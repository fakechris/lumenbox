/**
 * Work that has been accepted but not yet begun.
 *
 * The gap this closes: `/api/prompt` returns 202 and the message goes into a `Map` in the bus. A
 * person's request was accepted, they were told so, and the only record of it lived in the memory of
 * a process that could be killed a millisecond later. The same is true of an inter-agent message
 * whose sender was told "Sent to Bob". Everything else durable here — transcripts, memory, plans,
 * usage, policy, schedules — records what *happened*; nothing recorded what had been *promised*.
 *
 * **Only what has not started is replayed, and that is the whole of the safety argument.** A message
 * is marked as started the moment a turn takes it, before anything runs. So the window this replays
 * is the one where nothing has executed yet: no tool has run, no money has been spent, nothing has
 * been written. Replaying it cannot duplicate a side effect because there are none to duplicate.
 *
 * The other choice — marking a message done when its *turn* completes — would replay half-finished
 * turns, and a turn that deployed something before dying would deploy it twice. Resuming that turn
 * properly needs per-step checkpoints, which do not exist yet; until they do, the honest boundary is
 * "started". A turn interrupted mid-flight leaves its prompt in the transcript, so the work is not
 * invisible, but it is not silently re-run either.
 */

import { envNumber } from "../config.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendLine } from "../host/jsonl.ts";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/** Kept alongside the transcripts: same lifetime, same volume, same backup. */
export function inboxPath(): string {
  return process.env.AGENTBOX_INBOX_LOG ?? join(agentboxHome(), "inbox.jsonl");
}

/**
 * Rewritten once it passes this many lines *and* nothing is outstanding.
 *
 * Both conditions, because compacting with work outstanding means rewriting the very records that
 * are still needed, and the point of the file is that it is only ever appended to while anything
 * depends on it.
 */
const COMPACT_AT = envNumber("AGENTBOX_INBOX_COMPACT_AT", 5_000);

interface AdmitRecord<T> {
  seq: number;
  event: "admitted";
  agentId: string;
  at: string;
  message: T;
}

interface StartRecord {
  seq: number;
  event: "started";
}

type InboxRecord<T> = AdmitRecord<T> | StartRecord;

/** One admitted-but-unstarted item, as it comes back after a restart. */
export interface Admitted<T> {
  seq: number;
  agentId: string;
  at: string;
  message: T;
}

export class Inbox<T> {
  private nextSeq = 1;
  private lines = 0;
  /** Admitted and not yet started, so compaction can tell whether anything depends on the file. */
  private outstanding = 0;

  private readonly path: string | undefined;

  /**
   * `null` means keep no file; omitted means the default path.
   *
   * Two words for two states, because one `undefined` for both is how this file's first version
   * wrote into the developer's home directory from a test that asked for no inbox at all — a
   * default parameter fires on an explicit `undefined` just as it does on an absent argument. The
   * same conflation this review keeps finding, committed while fixing instances of it.
   */
  constructor(
    path: string | null = inboxPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.path = path ?? undefined;
    const pending = this.read();
    this.outstanding = pending.length;
  }

  /**
   * Records that this message has been accepted, and returns the handle that marks it started.
   *
   * Returns `undefined` when there is no file to write to, which is what a test wants and what a
   * caller uses to tell "nothing was recorded" from "record 0".
   */
  admit(agentId: string, message: T, now = new Date()): number | undefined {
    if (this.path === undefined) return undefined;
    const seq = this.nextSeq++;
    const record: AdmitRecord<T> = {
      seq,
      event: "admitted",
      agentId,
      at: now.toISOString(),
      message,
    };
    if (!this.append(record)) return undefined;
    this.outstanding += 1;
    return seq;
  }

  /** Records that a turn has taken these messages. Called before anything runs. */
  start(seqs: readonly (number | undefined)[]): void {
    for (const seq of seqs) {
      if (seq === undefined) continue;
      if (this.append({ seq, event: "started" })) this.outstanding = Math.max(0, this.outstanding - 1);
    }
    if (this.outstanding === 0 && this.lines > COMPACT_AT) this.compact();
  }

  /** Everything accepted that no turn ever took. In admission order. */
  pending(): Admitted<T>[] {
    return this.read();
  }

  private append(record: InboxRecord<T>): boolean {
    if (this.path === undefined) return false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(record));
      this.lines += 1;
      return true;
    } catch (error) {
      // Never fail an enqueue over bookkeeping. A message that could not be recorded is still
      // delivered in this process; what is lost is its ability to survive a restart, which is the
      // behaviour every message had before this file existed.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`inbox: cannot write ${this.path} (${detail})`);
      return false;
    }
  }

  private read(): Admitted<T>[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    const admitted = new Map<number, Admitted<T>>();
    try {
      let lines = 0;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        let record: InboxRecord<T>;
        try {
          record = JSON.parse(line) as InboxRecord<T>;
        } catch {
          // A torn last line is the normal cost of append-only. Skipping it loses at most one
          // message; refusing to read the file would lose every one of them.
          continue;
        }
        if (typeof record?.seq !== "number") continue;
        if (record.seq >= this.nextSeq) this.nextSeq = record.seq + 1;
        if (record.event === "admitted") {
          admitted.set(record.seq, {
            seq: record.seq,
            agentId: record.agentId,
            at: record.at,
            message: record.message,
          });
        } else if (record.event === "started") {
          admitted.delete(record.seq);
        }
      }
      this.lines = lines;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`inbox: cannot read ${this.path} (${detail})`);
      return [];
    }
    return [...admitted.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Rewrites the file empty. Temp plus rename, so a reader never sees half a file. */
  private compact(): void {
    if (this.path === undefined) return;
    try {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, "", "utf8");
      renameSync(temp, this.path);
      this.lines = 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`inbox: cannot compact ${this.path} (${detail})`);
    }
  }
}
