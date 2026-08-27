/**
 * Picking a turn back up after the process ended underneath it.
 *
 * Durable admission closed the window before a turn starts: work that was accepted and never begun
 * is replayed, and that is safe precisely because nothing had run yet. This is the window *after*
 * it starts. An agent four hundred rounds into a task, killed by a restart or an OOM, left its
 * prompt and its completed rounds in the transcript and simply stopped — no error, no report, and
 * nothing that would ever run again.
 *
 * **The transcript is already the checkpoint.** Every completed round is appended to it as it
 * happens, so what a resumed turn needs to know is not "what did I do" — that is on disk — but
 * "there was a turn here, and it did not end". That is all this file adds: a begin and an end, so
 * a begin without an end is a fact rather than a guess.
 *
 * **Nothing is re-executed.** A resumed turn is an ordinary turn whose opening message says what
 * happened; the model reads its own history and decides. That is the only defensible choice while
 * a call and its result are separate appends: a crash between them leaves an action whose outcome
 * is genuinely unknown, and request assembly says so in as many words rather than claiming it
 * failed. Re-running it automatically would deploy twice; declaring it failed would undo work that
 * succeeded. The one thing that is *not* honest is silence, which is what happened before.
 *
 * **Resuming is bounded.** A turn that kills the process will kill it again. After a couple of
 * attempts the interruption is reported into the transcript and left alone, because a crash loop
 * that also restarts itself is worse than a task that stopped.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { dirname, join } from "node:path";
import { agentboxHome, envNumber } from "../config.ts";

/** Kept alongside the transcripts: same lifetime, same volume, same backup. */
export function turnLedgerPath(): string {
  return process.env.AGENTBOX_TURN_LEDGER ?? join(agentboxHome(), "turns.jsonl");
}

/**
 * How many times an interrupted turn may be picked up again.
 *
 * Two, because the failure this guards against is a turn that ends the process *every* time —
 * an allocation that will not fit, a bug reached at round 300 — and resuming that forever is a
 * crash loop the system inflicts on itself. Two attempts distinguishes "the machine restarted" from
 * "this turn is what kills it".
 */
export const MAX_RESUMES = envNumber("AGENTBOX_MAX_RESUMES", 2);

/** Rewritten past this many lines, keeping only what is unfinished. */
const COMPACT_AT = envNumber("AGENTBOX_TURN_LEDGER_COMPACT_AT", 5_000);

interface BeginRecord {
  id: string;
  event: "begin";
  agentId: string;
  at: string;
  /** The turn this one is picking up, when it is a resumption. */
  resumeOf?: string;
  /**
   * The piece of work, as opposed to the attempt at it.
   *
   * `id` is a fresh UUID per attempt, so anything keyed on it sees a turn that resumed twice
   * as three unrelated short turns — which is why no cost report could answer "what did that
   * task cost". This one is minted once and inherited by every resumption.
   *
   * Optional because records written before the field existed have to keep replaying, and an
   * id synthesised for them would join their rows to nothing while looking like a grouping.
   */
  workId?: string;
  /** How many attempts have already been made at the original work, including this one. */
  attempt: number;
  /** What the turn was about, in one line, so an operator reading the file learns something. */
  about: string;
  /** Which conversation it ran in, when not the main one — so the resume lands in the same thread. */
  conversation?: string;
}

interface EndRecord {
  id: string;
  event: "end";
  at: string;
  /** How it ended, for the log. Not consulted: any end at all means this turn is not outstanding. */
  how: string;
}

type LedgerRecord = BeginRecord | EndRecord;

/** A turn that began and never ended. */
export interface InterruptedTurn {
  id: string;
  agentId: string;
  at: string;
  about: string;
  /** Attempts already made, so the caller can stop rather than loop. */
  attempt: number;
  /** The conversation the turn belonged to, absent for the main one. */
  conversation?: string;
  /**
   * The work this turn was an attempt at, so the resumption inherits it rather than starting
   * a second one.
   *
   * Returned here and not only written to the file, because `resumeOf` is the cautionary
   * case: it goes into the begin record and never comes out of this shape, so the lineage
   * exists on disk and never reaches the code that resumes.
   */
  workId?: string;
}

export class TurnLedger {
  private readonly path: string | undefined;
  private lines = 0;

  /**
   * `null` means keep no ledger; omitted means the default path.
   *
   * Two words for two states, because a default parameter fires on an explicit `undefined` exactly
   * as it does on an absent argument — which is how a sibling of this file wrote into a developer's
   * home directory from a test that had asked for no file at all.
   */
  constructor(
    path: string | null = turnLedgerPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.path = path ?? undefined;
  }

  /** Records that a turn is starting. Returns the handle its end is reported against. */
  begin(options: {
    agentId: string;
    about: string;
    id: string;
    resumeOf?: string;
    workId?: string;
    attempt?: number;
    conversation?: string;
    now?: Date;
  }): string {
    const record: BeginRecord = {
      id: options.id,
      event: "begin",
      agentId: options.agentId,
      at: (options.now ?? new Date()).toISOString(),
      ...(options.resumeOf !== undefined ? { resumeOf: options.resumeOf } : {}),
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
      attempt: options.attempt ?? 1,
      about: options.about.replace(/\s+/g, " ").trim().slice(0, 200),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
    };
    this.append(record);
    return record.id;
  }

  /** Records that a turn is over, however it ended. */
  end(id: string, how: string, now = new Date()): void {
    this.append({ id, event: "end", at: now.toISOString(), how });
    if (this.lines > COMPACT_AT && this.interrupted().length === 0) this.compact();
  }

  /**
   * Turns that began and never ended, oldest first.
   *
   * Every process that has ever written here contributes: this is read at startup, when by
   * definition nothing of ours is running, so an unfinished record is an interrupted turn and not a
   * turn in flight. A second orchestrator against the same state directory would break that
   * assumption, which is the same assumption the single-box design makes everywhere else.
   */
  interrupted(): InterruptedTurn[] {
    const open = new Map<string, InterruptedTurn>();
    for (const record of this.read()) {
      if (record.event === "begin") {
        open.set(record.id, {
          id: record.id,
          agentId: record.agentId,
          at: record.at,
          about: record.about,
          attempt: record.attempt,
          ...(record.conversation !== undefined ? { conversation: record.conversation } : {}),
          ...(record.workId !== undefined ? { workId: record.workId } : {}),
        });
      } else {
        open.delete(record.id);
      }
    }
    return [...open.values()];
  }

  private append(record: LedgerRecord): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(record));
      this.lines += 1;
    } catch (error) {
      // Never fail a turn over bookkeeping. What is lost is the ability to notice that this turn
      // was interrupted, which is the behaviour every turn had before this file existed.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turns: cannot write ${this.path} (${detail})`);
    }
  }

  private read(): LedgerRecord[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      const records: LedgerRecord[] = [];
      let lines = 0;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        try {
          const record = JSON.parse(line) as LedgerRecord;
          if (typeof record?.id === "string") records.push(record);
        } catch {
          // A torn last line is the normal cost of append-only. Skipping it can only mean one turn
          // is not resumed; refusing the file would mean none of them are.
        }
      }
      this.lines = lines;
      return records;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turns: cannot read ${this.path} (${detail})`);
      return [];
    }
  }

  /** Rewrites the file empty. Only called with nothing outstanding, so nothing is being discarded. */
  private compact(): void {
    if (this.path === undefined) return;
    try {
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, "", "utf8");
      renameSync(temp, this.path);
      this.lines = 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turns: cannot compact ${this.path} (${detail})`);
    }
  }
}

/**
 * What a resumed turn is told.
 *
 * Written to be acted on rather than acknowledged. The three things it has to establish: this is
 * not a person asking, the history below is the agent's own, and the last thing it did may or may
 * not have happened. That last point is the one a model will get wrong if left to assume — the
 * natural reading of an interrupted log is "it failed", and acting on that undoes work that
 * succeeded.
 */
export function resumePrompt(about: string, interruptedAt: string): string {
  return [
    `[resumed] This turn was interrupted — the orchestrator stopped while you were working, and`,
    `has restarted. Nobody re-sent this; you are picking up your own unfinished work.`,
    "",
    `It began at ${interruptedAt} and was about: ${about}`,
    "",
    `Everything you had finished is in the conversation above, and your plan and todo list are`,
    `where you left them. What is *not* there is the outcome of whatever you were doing at the`,
    `moment it stopped: a call whose result was never written down shows above as having an unknown`,
    `outcome, and unknown is what it means — it may well have succeeded.`,
    "",
    `So: check the state of anything you may have been part-way through before repeating it, then`,
    `carry on. If you cannot tell whether something happened, say so rather than guessing, and`,
    `prefer looking over redoing.`,
  ].join("\n");
}

/**
 * What is said instead, once an interrupted turn has been picked up too many times.
 *
 * A turn that ends the process will end it again. Reported into the conversation rather than
 * retried, because a crash loop that restarts itself is worse than a task that stopped — and a
 * person reading this is the one who can do something about it.
 */
export function giveUpNote(about: string, attempts: number): string {
  return (
    `This turn was interrupted ${attempts} times and is not being picked up again. It was about: ` +
    `${about}. Whatever ended the process is likely to be in this work rather than in the machine, ` +
    `so it needs a person to look. Everything finished before the last interruption is in the ` +
    `conversation above.`
  );
}
