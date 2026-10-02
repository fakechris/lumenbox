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
import { appendLine, archiveSettled, type LedgerKind } from "./jsonl.ts";
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

/**
 * The life of every turn, and it is not a queue either.
 *
 * Emptying this file is emptying the only place that says what a turn cost, how long it
 * ran, which model and prompt produced it, and how it ended. See `compact()`.
 */
export const LEDGER_KIND: LedgerKind = "record";

/** Rewritten past this many lines, keeping only what is unfinished. */
const COMPACT_AT = envNumber("AGENTBOX_TURN_LEDGER_COMPACT_AT", 5_000);

interface BeginRecord {
  principalId?: string;
  causedBy?: string[];
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
  /**
   * Which model, which code, and which prompt produced this turn (R24).
   *
   * "Did the regression start the day we swapped the model or the day we deployed" was
   * unanswerable from our own records: usage rows carry the model, nothing carried the code,
   * and the assembled prompt was never kept. The prompt itself is not stored — it can be
   * thousands of lines and mostly repeats — but a hash of it is enough to say "the prompt
   * changed between these two turns", which is the question that matters.
   */
  model?: string;
  build?: { version: string; commit: string };
  promptHash?: string;
  /**
   * The same prompt in three parts (INV-782): the stable prefix, the volatile tail, and the
   * tool definitions sent with it. `promptHash` says *whether* the prompt changed; this says
   * *which part*, which is the question a cache miss actually asks — the tool set moves with
   * skills, MCP servers and the lane, and was not in the hash at all.
   */
  promptFingerprint?: PromptFingerprint;
  /** Which of the three parts differ from the previous turn in this conversation; absent when there was none. */
  promptChanged?: PromptSegment[];
  /** Whether the volatile tier rode the newest message instead of the system prompt (INV-767). */
  volatileInTail?: boolean;
  contextEpoch?: number;
  contextMode?: "normal" | "clean" | "recover";
  memoryProjection?: {
    personal: import("./memory.ts").MemoryProjectionManifest;
    shared: import("./memory.ts").MemoryProjectionManifest;
  };
}

/** The three parts of an assembled prompt that can each break the provider's cache on their own. */
export type PromptSegment = "stable" | "volatile" | "tools";

/** A 16-hex digest per segment (turn.ts `promptHashOf`). */
export type PromptFingerprint = Record<PromptSegment, string>;

export const PROMPT_SEGMENTS: readonly PromptSegment[] = ["stable", "volatile", "tools"];

/** The segments whose digest differs between two fingerprints, in fixed order. */
export function changedPromptSegments(previous: PromptFingerprint, current: PromptFingerprint): PromptSegment[] {
  return PROMPT_SEGMENTS.filter(segment => previous[segment] !== current[segment]);
}

interface EndRecord {
  id: string;
  event: "end";
  at: string;
  /** How it ended, for the log. Not consulted: any end at all means this turn is not outstanding. */
  how: string;
  /** The failure class, when `how` is failed (failure-taxonomy.ts). */
  category?: string;
  /**
   * What this turn read and kept, as the self-describing pointers say it (INV-659, INV-665).
   *
   * The link only went one way. A kept file's frontmatter names the turn that read it, so
   * *file to turn* resolved; nothing answered *turn to files*, and the only way to ask was
   * to walk every month of the evidence store filtering on `turn_id` — linear in everything
   * ever kept, and blind to whatever the retention had already taken.
   *
   * It lives here rather than in a new ledger because `turns.jsonl` is a `record` since
   * INV-634: it archives instead of emptying, which is exactly what an edge between a turn
   * and its evidence needs. A new ledger would have been a second thing to keep honest.
   */
  evidence?: KeptEvidence[];
}

/** One thing a turn read and kept. The fields a pointer carries, parsed once at write time. */
export interface KeptEvidence {
  path: string;
  sha256: string;
  chars: number;
  at: string;
}

/**
 * The process is exiting on purpose with this turn still open.
 *
 * Written by the shutdown handler, not by the turn: an operator's Ctrl-C or `kill` is
 * not evidence that the turn crashes the process, and counting it against the turn's
 * resume budget conflated the two — two quick operator restarts in one minute burned
 * both attempts and a healthy task was given up on (measured 2026-09-01, 01:27–01:28).
 * A turn whose interruption carries this marker resumes without spending an attempt;
 * a turn interrupted with no marker died with the process, which is the case the
 * budget exists for.
 */
interface CleanRecord {
  id: string;
  event: "clean";
  at: string;
}

type LedgerRecord = BeginRecord | EndRecord | CleanRecord;

/** Persisted on the recovery admission, so a second restart retains its lineage. */
export interface ResumeMarker {
  id: string;
  attempt: number;
  workId?: string;
  continues?: true;
  approval?: { id: string; how: "allowed" | "refused" | "gone" };
}

/** A turn that began and never ended. */
export interface InterruptedTurn {
  principalId?: string;
  causedBy?: string[];
  id: string;
  agentId: string;
  at: string;
  about: string;
  /** Attempts already made, so the caller can stop rather than loop. */
  attempt: number;
  /** The conversation the turn belonged to, absent for the main one. */
  conversation?: string;
  contextEpoch?: number;
  contextMode?: "normal" | "clean" | "recover";
  /** True when the process exited on purpose under this turn — resume it for free. */
  cleanExit?: boolean;
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

/** `FORK_PREFIX` from tools.ts, repeated here to keep this file free of the tool module. */
const FORK_CONVERSATION_PREFIX = "fork/";

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
    principalId?: string;
    causedBy?: string[];
    agentId: string;
    about: string;
    id: string;
    resumeOf?: string;
    workId?: string;
    attempt?: number;
    conversation?: string;
    model?: string;
    build?: { version: string; commit: string };
    promptHash?: string;
    promptFingerprint?: PromptFingerprint;
    promptChanged?: PromptSegment[];
    volatileInTail?: boolean;
    contextEpoch?: number;
    contextMode?: "normal" | "clean" | "recover";
    memoryProjection?: BeginRecord["memoryProjection"];
    now?: Date;
  }): string {
    const record: BeginRecord = {
      id: options.id,
      event: "begin",
      ...(options.principalId !== undefined ? { principalId: options.principalId } : {}),
      ...(options.causedBy !== undefined ? { causedBy: [...options.causedBy] } : {}),
      agentId: options.agentId,
      at: (options.now ?? new Date()).toISOString(),
      ...(options.resumeOf !== undefined ? { resumeOf: options.resumeOf } : {}),
      ...(options.workId !== undefined ? { workId: options.workId } : {}),
      attempt: options.attempt ?? 1,
      about: options.about.replace(/\s+/g, " ").trim().slice(0, 200),
      ...(options.conversation !== undefined ? { conversation: options.conversation } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.build !== undefined ? { build: options.build } : {}),
      ...(options.promptHash !== undefined ? { promptHash: options.promptHash } : {}),
      ...(options.promptFingerprint !== undefined ? { promptFingerprint: options.promptFingerprint } : {}),
      ...(options.promptChanged !== undefined ? { promptChanged: [...options.promptChanged] } : {}),
      ...(options.volatileInTail !== undefined ? { volatileInTail: options.volatileInTail } : {}),
      ...(options.contextEpoch !== undefined ? { contextEpoch: options.contextEpoch } : {}),
      ...(options.contextMode !== undefined ? { contextMode: options.contextMode } : {}),
      ...(options.memoryProjection !== undefined ? { memoryProjection: options.memoryProjection } : {}),
    };
    this.append(record, true);
    return record.id;
  }

  /**
   * The fingerprint of the most recent turn this agent began in this conversation, or
   * `undefined` when none in the live file carries one (INV-782). Live file only, like
   * `evidence()`: the comparison is between adjacent turns, and an archived one is not adjacent.
   */
  lastPromptFingerprint(agentId: string, conversation?: string): PromptFingerprint | undefined {
    let found: PromptFingerprint | undefined;
    for (const record of this.read()) {
      if (record.event !== "begin" || record.agentId !== agentId) continue;
      if ((record.conversation ?? undefined) !== conversation) continue;
      if (record.promptFingerprint !== undefined) found = record.promptFingerprint;
    }
    return found;
  }

  /** Records that a turn is over, however it ended. */
  end(id: string, how: string, now = new Date(), category?: string, evidence?: readonly KeptEvidence[]): void {
    this.append({
      id,
      event: "end",
      at: now.toISOString(),
      how,
      ...(category !== undefined ? { category } : {}),
      ...(evidence !== undefined && evidence.length > 0 ? { evidence: [...evidence] } : {}),
    });
    if (this.lines > COMPACT_AT && this.interrupted().length === 0) this.compact();
  }

  /**
   * Everything the turns in this file say they read and kept, newest first.
   *
   * Live file only. An archived turn's evidence has almost certainly outlived the retention
   * on the thing it points at, and the pointer's own digest is what still describes it
   * (INV-659) — reading months of archive to find references to files that are gone would
   * cost a great deal to learn nothing.
   */
  evidence(): { turnId: string; at: string; kept: KeptEvidence[] }[] {
    const out: { turnId: string; at: string; kept: KeptEvidence[] }[] = [];
    for (const record of this.read()) {
      const kept = (record as EndRecord).evidence;
      if (record.event === "end" && kept !== undefined && kept.length > 0) {
        out.push({ turnId: record.id, at: record.at, kept });
      }
    }
    return out.reverse();
  }

  /**
   * Records that the process is exiting on purpose under this still-open turn.
   * Synchronous appends only — this runs in a signal handler.
   */
  markClean(id: string, now = new Date()): void {
    this.append({ id, event: "clean", at: now.toISOString() });
  }

  /**
   * Turns that began and never ended, oldest first.
   *
   * Every process that has ever written here contributes: this is read at startup, when by
   * definition nothing of ours is running, so an unfinished record is an interrupted turn and not a
   * turn in flight. A second orchestrator against the same state directory would break that
   * assumption, which is the same assumption the single-box design makes everywhere else.
   */
  /**
   * Ends every open record in one conversation, for the fork ledger's startup sweep
   * (docs/32 §1): a fork child interrupted by a restart is never resumed, so its record must
   * not read as an interrupted turn. Returns how many were ended.
   */
  endIn(conversation: string, how: string, now = new Date()): number {
    return this.endWhere(candidate => candidate === conversation, how, now);
  }

  /** Ends every open record whose conversation the predicate selects. */
  endWhere(select: (conversation: string) => boolean, how: string, now = new Date()): number {
    let ended = 0;
    for (const turn of this.interrupted({ includeForks: true })) {
      if (!select(turn.conversation ?? "")) continue;
      this.end(turn.id, how, now);
      ended += 1;
    }
    return ended;
  }

  interrupted(options: { includeForks?: boolean } = {}): InterruptedTurn[] {
    const open = new Map<string, InterruptedTurn>();
    for (const record of this.read()) {
      if (record.event === "begin") {
        if (record.resumeOf !== undefined && record.resumeOf !== record.id) open.delete(record.resumeOf);
        open.set(record.id, {
          id: record.id,
          ...(record.principalId !== undefined ? { principalId: record.principalId } : {}),
          ...(record.causedBy !== undefined ? { causedBy: record.causedBy } : {}),
          agentId: record.agentId,
          at: record.at,
          about: record.about,
          attempt: record.attempt,
          ...(record.conversation !== undefined ? { conversation: record.conversation } : {}),
          ...(record.contextEpoch !== undefined ? { contextEpoch: record.contextEpoch } : {}),
          ...(record.contextMode !== undefined ? { contextMode: record.contextMode } : {}),
          ...(record.workId !== undefined ? { workId: record.workId } : {}),
        });
      } else if (record.event === "clean") {
        const turn = open.get(record.id);
        if (turn !== undefined) turn.cleanExit = true;
      } else {
        open.delete(record.id);
      }
    }
    // A fork child's turn is never resumed across a restart: the fork ledger (docs/32) owns
    // that conversation and settles it `dropped` before this is read. Skipped here as well,
    // so a ledger that could not write is not a reason to resume a child nobody is joining.
    return [...open.values()].filter(
      turn => options.includeForks === true || !(turn.conversation ?? "").startsWith(FORK_CONVERSATION_PREFIX)
    );
  }

  private append(record: LedgerRecord, required = false): void {
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
      if (required) throw error;
    }
  }

  /** The live file's lines, as written. What `compact()` hands to the archive. */
  private readLines(): string[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "");
    } catch {
      return [];
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

  /**
   * Moves the file to an archive and starts a fresh one.
   *
   * It used to write the file empty on the reasoning that nothing outstanding means
   * nothing is being discarded — true of *resumption*, which is what this ledger was
   * built for, and false of everything else that reads it. This is the only record of
   * what a turn cost, how long it took, which model and which prompt produced it, and how
   * it ended; after five thousand turns all of that went, and the audit export for last
   * month exported a file that had been emptied since.
   *
   * Only called with nothing outstanding, so every line being moved is a settled one.
   */
  private compact(): void {
    if (this.path === undefined) return;
    try {
      archiveSettled(this.path, this.readLines());
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
/**
 * Whether an open turn belongs to this agent *and this conversation* (INV-435).
 *
 * The delivery sweep used to ask only "does this agent have an open turn?", so an answer
 * finished in one chat waited on an unrelated turn still running in another — and, worse,
 * a turn in a second conversation that the sweep took for the writer of the first's
 * answer. The ledger records the conversation; custody is per conversation.
 */
export function openTurnFor(
  open: readonly InterruptedTurn[],
  agentId: string,
  conversation?: string
): InterruptedTurn | undefined {
  return open.find(
    turn =>
      turn.agentId === agentId &&
      (conversation === undefined || (turn.conversation ?? MAIN_CONVERSATION_ID) === conversation)
  );
}

/** The main conversation's id, as the ledger omits it. Mirrors registry's MAIN_CONVERSATION. */
export const MAIN_CONVERSATION_ID = "main";

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

// ── turn checkpoints (INV-774) ────────────────────────────────────────────────────────────

/** Beside `turns.jsonl`: same lifetime, same volume, same backup. */
export function stepLedgerPath(): string {
  return process.env.AGENTBOX_STEP_LEDGER ?? join(agentboxHome(), "turn-steps.jsonl");
}

/**
 * What is outstanding inside a turn. Emptied once nothing is, like the inbox: a settled
 * step is already in the transcript, which is the record; this file only says which
 * calls were in flight when the process died.
 */
export const STEP_LEDGER_KIND: LedgerKind = "queue";

const STEP_COMPACT_AT = envNumber("AGENTBOX_STEP_LEDGER_COMPACT_AT", 5_000);

type StepRecord =
  | { turnId: string; event: "pending"; toolUseId: string; name: string; at: string }
  | { turnId: string; event: "settled"; toolUseId: string; at: string }
  | { turnId: string; event: "awaiting_approval"; toolUseId: string; approvalId: string; at: string }
  | { turnId: string; event: "closed"; at: string };

/** A call that was dispatched and whose result never reached the transcript. */
export interface OpenStep {
  toolUseId: string;
  name: string;
  at: string;
  /** Set when the call was refused pending a person's approval, by that approval's id. */
  approvalId?: string;
}

/**
 * Where a turn's tool calls stood when the process died.
 *
 * The turn ledger says *that* a turn did not end; this one says *which call* it was inside,
 * and is written by the host as each call is dispatched and settled — never by the model,
 * never shown to it. Its whole use is at startup: a turn with an entry here is continued
 * in place, as the same turn, with the unfinished call answered `outcome_unknown`; a turn
 * with none (a transcript from before this file existed) takes the older resume-prompt path.
 *
 * `pending` is written before the call runs and `settled` after its result is on disk, so
 * a crash anywhere between leaves an open step — which is the honest state: the call may
 * have run. `awaiting_approval` is a pending call the policy gate handed to a person; the
 * step stays open until they answer, and the turn is parked rather than continued.
 */
export class StepLedger {
  private readonly path: string | undefined;
  private lines = 0;

  /** `null` means keep no ledger; omitted means the default path (see `TurnLedger`). */
  constructor(
    path: string | null = stepLedgerPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.path = path ?? undefined;
  }

  /** Written before the call is dispatched. */
  pending(turnId: string, toolUseId: string, name: string, now = new Date()): void {
    this.append({ turnId, event: "pending", toolUseId, name, at: now.toISOString() }, true);
  }

  /** Written after the call's result is in the transcript. */
  settled(turnId: string, toolUseId: string, now = new Date()): void {
    this.append({ turnId, event: "settled", toolUseId, at: now.toISOString() });
  }

  /** Written when the policy gate put the call in front of a person instead of running it. */
  awaitingApproval(turnId: string, toolUseId: string, approvalId: string, now = new Date()): void {
    this.append({ turnId, event: "awaiting_approval", toolUseId, approvalId, at: now.toISOString() });
  }

  /** Written when the turn ends, however it ends. */
  closed(turnId: string, now = new Date()): void {
    this.append({ turnId, event: "closed", at: now.toISOString() });
    if (this.lines > STEP_COMPACT_AT) this.compact();
  }

  /**
   * What the ledger knows about one turn: whether it was recorded here at all, and which
   * of its calls are still open. `known: false` is the older transcript's case.
   */
  stepsOf(turnId: string): { known: boolean; open: OpenStep[] } {
    const turns = this.openByTurn();
    const turn = turns.get(turnId);
    return { known: turn !== undefined, open: turn === undefined ? [] : [...turn.values()] };
  }

  /**
   * Closes the step that was waiting on this approval, once the person has answered it
   * (INV-798). A step handed to a person stays open past the end of its batch — that is
   * what lets a restart park on the answer — so the answer is what closes it. Nothing to
   * close is the ordinary case: the turn ended first, or the approval was not a step's.
   */
  settleApproval(approvalId: string, now = new Date()): boolean {
    for (const [turnId, steps] of this.openByTurn()) {
      for (const step of steps.values()) {
        if (step.approvalId !== approvalId) continue;
        this.settled(turnId, step.toolUseId, now);
        return true;
      }
    }
    return false;
  }

  /** Every turn the ledger has seen, with the steps still open in each. */
  private openByTurn(): Map<string, Map<string, OpenStep>> {
    const turns = new Map<string, Map<string, OpenStep>>();
    for (const record of this.read()) {
      let open = turns.get(record.turnId);
      if (open === undefined) {
        open = new Map();
        turns.set(record.turnId, open);
      }
      if (record.event === "pending") {
        open.set(record.toolUseId, { toolUseId: record.toolUseId, name: record.name, at: record.at });
      } else if (record.event === "awaiting_approval") {
        const step = open.get(record.toolUseId);
        if (step !== undefined) step.approvalId = record.approvalId;
      } else if (record.event === "settled") {
        open.delete(record.toolUseId);
      } else if (record.event === "closed") {
        open.clear();
      }
    }
    return turns;
  }

  private append(record: StepRecord, required = false): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(record));
      this.lines += 1;
    } catch (error) {
      // Dispatch must stop if its checkpoint is missing. Otherwise a previously known
      // turn could recover an executed call as not_started. Settled results already
      // have a transcript receipt and can conservatively remain open.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turn-steps: cannot write ${this.path} (${detail})`);
      if (required) throw error;
    }
  }

  private read(): StepRecord[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      const records: StepRecord[] = [];
      let lines = 0;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        try {
          const record = JSON.parse(line) as StepRecord;
          if (typeof record?.turnId === "string" && typeof record?.event === "string") records.push(record);
        } catch {
          // A torn last line is the normal cost of append-only: one step reads as open
          // rather than settled, which errs on the side of "unknown".
        }
      }
      this.lines = lines;
      return records;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turn-steps: cannot read ${this.path} (${detail})`);
      return [];
    }
  }

  /** Rewrites the file keeping only the turns that have not closed. */
  private compact(): void {
    if (this.path === undefined) return;
    try {
      const records = this.read();
      const closed = new Set(records.filter(record => record.event === "closed").map(record => record.turnId));
      const kept = records.filter(record => !closed.has(record.turnId));
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.map(record => JSON.stringify(record)).join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`turn-steps: cannot compact ${this.path} (${detail})`);
    }
  }
}

/**
 * What a continued turn is woken with. Not a message to the model — a continued turn
 * appends no user text — only the line the bus and the ledger record it under.
 */
export function continuationNote(about: string): string {
  return `[continuing] ${about}`;
}

/**
 * The host's result for a call that was dispatched and whose outcome was never recorded.
 *
 * Written as a tool result rather than as prose, so the model meets it as the next
 * observation of the call it made — the same place a real result would have been.
 */
export function outcomeUnknownResult(name: string): string {
  return (
    `outcome_unknown: the host restarted before this ${name} call's result was recorded. ` +
    `It may have run in full, in part, or not at all. Treat the outcome as unknown: check the ` +
    `state it would have changed before repeating it, and do not retry blindly.`
  );
}

/** The host's result for a call the model asked for that the host never started. */
export function notStartedResult(name: string): string {
  return `not_started: the host restarted before this ${name} call was dispatched. It did not run. Call it again if it is still needed.`;
}

/** The host's result for a call that was waiting on a person when the host restarted. */
export function approvalOutcomeResult(name: string, how: "allowed" | "refused" | "gone" | "pending"): string {
  switch (how) {
    case "pending":
      return `This ${name} call is still waiting for the person's approval. It has not run. Wait for its answer; do not ask again or retry it yet.`;
    case "allowed":
      return `The person allowed this ${name} call while the host was restarting. It has not run yet: the grant is held, so call it again now, exactly as before.`;
    case "refused":
      return `The person refused this ${name} call. Do not retry it; do without, or say what cannot be done.`;
    default:
      return `This ${name} call was waiting for a person's approval when the host restarted, and that approval is no longer waiting — it was answered or lost while the host was down. It did not run. Ask again if it is still needed.`;
  }
}
