/**
 * When the organisation's knowledge goes stale (INV-1731, docs/98 §7 and §10 decision 3).
 *
 * An L1 item goes stale by one of two lines, never by the calendar alone:
 *
 * - **Its review date passes** (`reviewBy`): the item is *due for review* ("待复核") until its
 *   owner re-verifies, supersedes or retracts it.
 * - **Its evidence changes state**: a cited task is reopened or dropped, a cited Involute item is
 *   superseded or canceled, a cited document is superseded. The item is *stale* ("过期").
 *
 * Either way it stays readable, marked, and goes last (org-knowledge.ts), it leaves the Recall
 * tool's search, and it is on its owner's "needs you" list (`ownerAttention`) — the projection
 * a person's notifications are built from, so nothing here keeps a second record of who was told.
 *
 * Involute is evidence, never a search. The host reads one item's state by its `inv:` id, with the
 * credential the installation already configures for its Involute agents (`involuteStateReader`
 * takes the call; server.ts hands it that credential's), and only in `EvidenceWatch.sweep`: a
 * remote read never runs inside a turn. Nothing here is a tool, and no agent is given a way to
 * search Involute (the test reads the tool list to hold that).
 *
 * Nothing is written to the ledger: whether an item is stale is a reading of its evidence now,
 * so an evidence change that is undone (a task closed again) un-stales it without a correction.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttentionItem } from "./attention.ts";
import type { MemoryRecord } from "./memory.ts";
import { evidenceKind } from "./memory-scope.ts";
import type { Task, TaskStatus } from "./tasks.ts";

/** What happened to a piece of evidence that makes the item resting on it stale. */
export type EvidenceChange = "reopened" | "dropped" | "superseded" | "canceled";

/** Why an item is not to be relied on without a look. */
export type Staleness =
  | { kind: "review-due"; since: string }
  | { kind: "evidence"; ref: string; change: EvidenceChange; detail?: string };

/** What an Involute item's state says, read by its identifier. */
export interface InvoluteItemState {
  superseded: boolean;
  canceled: boolean;
  /** The item that replaced it, when Involute names one. */
  supersededBy?: string;
}

/** The reads one staleness check makes. Each is optional: a kind nobody can read never makes an item stale. */
export interface EvidenceReaders {
  task?: (id: string) => Pick<Task, "status" | "history"> | undefined;
  /** A document's header, by the reference's path (`docs/98`, `docs/98-company-brain.md`). */
  doc?: (ref: string) => { status: string; supersededBy?: string } | undefined;
  /** Remote: called only by `sweep`, never in a turn. */
  inv?: (identifier: string) => Promise<InvoluteItemState | undefined>;
}

/**
 * How a cited task changed since `since` (when the item was verified): dropped now, or moved out of
 * done after that time. A task that was never done when the item was written is not a change.
 */
export function taskChange(task: Pick<Task, "status" | "history">, since: string): "reopened" | "dropped" | undefined {
  const after = Date.parse(since);
  if (task.status === "dropped") {
    const droppedAt = task.history.findLast(change => change.status === "dropped")?.at;
    return droppedAt !== undefined && Date.parse(droppedAt) < after ? undefined : "dropped"; // dropped before a person verified the item: they saw it that way
  }
  let previous: TaskStatus | undefined;
  let reopened = false;
  for (const change of task.history) {
    if (change.status === undefined) continue;
    if (previous === "done" && change.status !== "done" && !(Date.parse(change.at) < after)) reopened = true;
    if (change.status === "done") reopened = false; // closed again: the evidence stands as it did
    previous = change.status;
  }
  return reopened && task.status !== "done" ? "reopened" : undefined;
}

/** The two header fields a document's supersession is recorded in (scripts/docs-lint.mjs owns the header). */
export function docHeaderStatus(text: string): { status: string; supersededBy?: string } | undefined {
  if (!text.startsWith("<!-- doc:")) return undefined;
  const header = text.slice(0, Math.max(0, text.indexOf("-->")));
  const field = (name: string) => new RegExp(`^\\s*${name}:\\s*(\\S.*)$`, "m").exec(header)?.[1]?.trim();
  const status = field("status");
  if (status === undefined) return undefined;
  const by = field("superseded-by");
  return { status, ...(by !== undefined ? { supersededBy: by } : {}) };
}

/** Reads `doc:` references against one directory of documents: `docs/98`, `docs/98-company-brain.md`, `98`. */
export function docsDirReader(dir: string): NonNullable<EvidenceReaders["doc"]> {
  return ref => {
    const name = ref.replace(/^docs\//, "").replace(/\.md$/, "");
    if (!/^[\w.-]+$/.test(name)) return undefined; // a reference is never a path out of the directory
    const exact = join(dir, `${name}.md`);
    let file: string | undefined = existsSync(exact) ? exact : undefined;
    if (file === undefined && /^\d+$/.test(name)) {
      try {
        const match = readdirSync(dir).find(entry => entry.startsWith(`${name}-`) && entry.endsWith(".md"));
        if (match !== undefined) file = join(dir, match);
      } catch {
        return undefined;
      }
    }
    if (file === undefined) return undefined;
    try {
      return docHeaderStatus(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  };
}

/** Reads an Involute item's state from `work_get_context` and its team's workflow states. `call` is the installation's credential's. */
export function involuteStateReader(call: (tool: string, args: Record<string, unknown>) => Promise<unknown>): NonNullable<EvidenceReaders["inv"]> {
  const stateTypes = new Map<string, Map<string, string>>(); // team → state id → group
  return async identifier => {
    const context = (await call("work_get_context", { id: identifier })) as { work?: Record<string, unknown> } | undefined;
    const work = context?.work;
    if (work === undefined || typeof work !== "object") return undefined;
    const teamId = typeof work.teamId === "string" ? work.teamId : undefined;
    let types = teamId === undefined ? undefined : stateTypes.get(teamId);
    const unknownState = typeof work.stateId === "string" && types !== undefined && !types.has(work.stateId); // a state the team added since
    if (teamId !== undefined && (types === undefined || unknownState)) {
      const catalog = (await call("work_catalog", { kind: "states", team_id: teamId, first: 200 })) as { nodes?: { id?: unknown; type?: unknown }[] } | undefined;
      types = new Map((catalog?.nodes ?? []).filter(node => typeof node.id === "string" && typeof node.type === "string").map(node => [node.id as string, node.type as string]));
      if (types.size > 0) stateTypes.set(teamId, types); // an empty or unreadable answer is asked again next time, not believed for the process's life
    }
    const stateType = typeof work.stateId === "string" ? types?.get(work.stateId) : undefined;
    const supersededBy = typeof work.supersededById === "string" && work.supersededById !== "" ? work.supersededById : undefined;
    const superseded = supersededBy !== undefined || work.resolution === "duplicate";
    const canceled = stateType === "CANCELED" || work.commitmentStatus === "REJECTED";
    return { superseded, canceled, ...(supersededBy !== undefined ? { supersededBy } : {}) };
  };
}

const INV_ID = /^INV-\d+$/i;

/** The evidence of the organisation's items, read: tasks and documents when asked, Involute from the last sweep. */
export class EvidenceWatch {
  private readonly involute = new Map<string, InvoluteItemState>();

  constructor(private readonly readers: EvidenceReaders) {}

  /** Reads every cited Involute item's state once. A failed read keeps what the last sweep knew. */
  async sweep(items: readonly Pick<MemoryRecord, "evidence">[]): Promise<{ read: number; failed: number }> {
    const ids = new Set(items.flatMap(item => item.evidence ?? []).filter(ref => evidenceKind(ref) === "inv").map(ref => ref.slice("inv:".length).toUpperCase()).filter(id => INV_ID.test(id)));
    let read = 0;
    let failed = 0;
    if (this.readers.inv === undefined) return { read, failed };
    for (const id of ids) {
      try {
        const state = await this.readers.inv(id);
        if (state !== undefined) this.involute.set(id, state);
        read++;
      } catch {
        failed++;
      }
    }
    return { read, failed };
  }

  /** The first piece of an item's evidence that changed state since it was verified, or undefined. */
  changeOf(item: Pick<MemoryRecord, "evidence" | "at" | "verifiedAt">): Extract<Staleness, { kind: "evidence" }> | undefined {
    const since = item.verifiedAt ?? item.at;
    for (const ref of item.evidence ?? []) {
      const kind = evidenceKind(ref);
      const target = ref.slice(ref.indexOf(":") + 1);
      if (kind === "task") {
        const task = this.readers.task?.(target);
        const change = task === undefined ? undefined : taskChange(task, since);
        if (change !== undefined) return { kind: "evidence", ref, change };
      } else if (kind === "doc") {
        const header = this.readers.doc?.(target);
        if (header?.status === "superseded") return { kind: "evidence", ref, change: "superseded", ...(header.supersededBy !== undefined ? { detail: `by ${header.supersededBy}` } : {}) };
      } else if (kind === "inv") {
        const state = this.involute.get(target.toUpperCase());
        if (state?.superseded === true) return { kind: "evidence", ref, change: "superseded", ...(state.supersededBy !== undefined ? { detail: `by ${state.supersededBy}` } : {}) };
        if (state?.canceled === true) return { kind: "evidence", ref, change: "canceled" };
      }
    }
    return undefined;
  }
}

/** The marker a stale item carries wherever it is read: in the prompt, cited by id, on the owner's list. */
export function describeStaleness(staleness: Staleness): string {
  if (staleness.kind === "review-due") return `REVIEW DUE since ${staleness.since.slice(0, 10)}: its owner has not re-verified it`;
  return `STALE: ${staleness.ref} was ${staleness.change}${staleness.detail !== undefined ? ` ${staleness.detail}` : ""}`;
}

/** The owner's "needs you" items: one per stale item they own (`isOwner` matches every identity of the person, or everyone for the operator). */
export function ownerAttention(entries: readonly { id: string; item: Pick<MemoryRecord, "text" | "owner">; staleness: Staleness }[], isOwner: (owner: string | undefined) => boolean): AttentionItem[] {
  return entries.filter(entry => isOwner(entry.item.owner)).map(({ id, item, staleness }) => ({
    kind: "org-knowledge",
    ref: id,
    title: staleness.kind === "review-due" ? `An organisation item you own is due for review (${id})` : `An organisation item you own is stale: ${staleness.ref} was ${staleness.change} (${id})`,
    detail: `"${item.text.slice(0, 140)}" — ${staleness.kind === "review-due" ? "re-verify it, supersede it or retract it" : "supersede it with an item that cites current evidence, or retract it"}. Until then agents see it marked ${staleness.kind === "review-due" ? "review due" : "stale"}, after everything current.`,
  }));
}

/** How often the host re-reads cited Involute items. A review date needs no sweep: it is read against the clock. */
export const EVIDENCE_SWEEP_MS = 60 * 60_000;

/** The documents a `doc:` reference names: the package's own `docs/`, when it ships with one. */
export const PACKAGE_DOCS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));

/** The documents directory, or undefined — said once in the log — when this build ships none: a `doc:` reference is then never checked. */
export function docsReaderAt(dir: string, log: (line: string) => void): EvidenceReaders["doc"] {
  if (existsSync(dir)) return docsDirReader(dir);
  log(`org knowledge: no documents at ${dir}; a doc: reference will not make an item stale`);
  return undefined;
}

/**
 * Wires the watch to the ledger: sets `ledger.evidence`, sweeps once now and then every
 * `EVIDENCE_SWEEP_MS`. Returns the timer, unref'd. `inv` is absent when the installation has no
 * Involute credential: an `inv:` reference then never makes an item stale.
 */
export function watchOrgEvidence(ledger: { evidence: Pick<EvidenceWatch, "changeOf"> | undefined; live(): readonly Pick<MemoryRecord, "evidence">[] }, readers: EvidenceReaders, log: (line: string) => void): NodeJS.Timeout {
  const watch = new EvidenceWatch(readers);
  ledger.evidence = watch;
  const sweep = () => {
    void watch.sweep(ledger.live()).then(({ failed }) => { if (failed > 0) log(`org knowledge: ${failed} Involute read(s) failed; the last known state stands`); }).catch(error => log(`org knowledge: evidence sweep failed — ${error instanceof Error ? error.message : String(error)}`));
  };
  sweep();
  const timer = setInterval(sweep, EVIDENCE_SWEEP_MS);
  timer.unref();
  return timer;
}
