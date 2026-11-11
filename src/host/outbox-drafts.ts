/**
 * The Outbox (INV-1739): what an agent wants to say or do outside the box, held for a person.
 *
 * An L4 task does most of its work alone, and every step that reaches someone else waits for the
 * person (autonomy-level.ts). A gated tool call already waits on its consent card and goes on once
 * it is allowed. A message did not: an agent that had written the words could only put them in its
 * answer and stop, and after a "yes" somebody had to wake it again and tell it to send. So a draft
 * is its own record — the kind of step, who it is for, the words, the background and the agent's
 * case — and the person's answer finishes it:
 *
 *   - **approve** — the host delivers it (a message to a chat it can reach) and the result is
 *     written here and on the task; the agent is woken and told, and carries on.
 *   - **edit and approve** — the same, with the person's words; the record keeps that they changed.
 *   - **reject** — nothing goes; the reason reaches the agent's next turn.
 *
 * The decision itself is the policy gate's (policy.ts `requestConfirmation`): one consent record
 * per draft, so the card, the chat push, the Feishu buttons, the 24-hour expiry and the audit are
 * the ones every other approval has. This file keeps what the gate does not — the draft, who
 * decided, and what happened to it. Not to be confused with outbox.ts, the receipts of what the
 * host has sent: an approved message is handed to that, under the purpose `draft`, and the
 * delivery gate (outbound.ts) lets it through only once it is approved here.
 *
 * Append-only and replayed; a record, never compacted.
 */

import type {WorkStamp} from "../agents/work-attention.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLine, type LedgerKind } from "./jsonl.ts";

export const LEDGER_KIND: LedgerKind = "record";

export const OUTBOX_FILE = "outbox-drafts.jsonl";

export const DRAFT_KINDS = ["message", "publish", "submit", "email", "other"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export interface Delivery {
  delivered: boolean;
  /** The chat it went to, when it went. */
  where?: string;
  /** Why it did not go, or what the door said. */
  detail?: string;
  at: string;
}

export interface Draft {
  id: string;
  agentId: string;
  agentName: string;
  conversation: string;
  taskId?: string;
  work?: WorkStamp;
  level?: number;
  kind: DraftKind;
  /** Who or where it is for, as the agent named it: a chat key, "here", a person, a site. */
  target: string;
  /** The words, or the command; after an edit, the person's. */
  body: string;
  background?: string;
  /** The agent's one-line case for sending it. */
  why: string;
  /** The consent record the person answers (policy.ts). */
  approvalId: string;
  createdAt: string;
  status: "waiting" | "approved" | "rejected";
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** The person changed the words before approving. */
  edited?: boolean;
  delivery?: Delivery;
}

type Line =
  | { event: "drafted"; draft: Omit<Draft, "status"> }
  | { event: "decided"; id: string; decision: "approved" | "rejected"; by: string; at: string; reason?: string; body?: string }
  | { event: "delivered"; id: string; delivery: Delivery };

/** What the host does with an answered draft: carry it, tell the agent, note it on the task. */
export interface OutboxWorld {
  /** Where a draft can be delivered by the host itself; undefined when it cannot be (another kind, an unknown target). */
  chatFor: (draft: Draft) => string | undefined;
  deliver: (draft: Draft, chatKey: string) => Promise<{ delivered: boolean; detail?: string }>;
  tell: (agentId: string, conversation: string, text: string, work?:WorkStamp) => void;
  note?: (taskId: string, text: string, work?:WorkStamp) => void;
  log?: (line: string) => void;
}

export type Decision =
  | { decision: "approve" }
  | { decision: "edit"; body: string }
  | { decision: "reject"; reason: string };

export class OutboxDrafts {
  private world: OutboxWorld | undefined;

  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  /** The host's hands, given once the doors exist; until then an answered draft is recorded and waits to be told. */
  connect(world: OutboxWorld): void {
    this.world = world;
  }

  newId(): string {
    return `ob-${randomBytes(4).toString("hex")}`;
  }

  /** Writes a draft down; it waits until its consent record is answered. */
  record(draft: Omit<Draft, "status" | "createdAt">): Draft {
    const kept: Omit<Draft, "status"> = { ...draft, body: draft.body.slice(0, 8000), why: draft.why.slice(0, 300), createdAt: this.now().toISOString() };
    this.append({ event: "drafted", draft: kept });
    return { ...kept, status: "waiting" };
  }

  get(id: string): Draft | undefined {
    return this.replay().get(id);
  }

  byApproval(approvalId: string): Draft | undefined {
    return [...this.replay().values()].find(draft => draft.approvalId === approvalId);
  }

  /** Every draft still waiting for a person, oldest first. */
  waiting(): Draft[] {
    return this.list().filter(draft => draft.status === "waiting");
  }

  list(): Draft[] {
    return [...this.replay().values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * A person's answer from the Outbox, written before the consent record is settled so the
   * reason and the edited words are on file when the agent is told. Refused for a draft that is
   * not waiting, an edit with no words, and a rejection with no reason.
   */
  decide(id: string, answer: Decision, by: string): { ok: true; draft: Draft } | { ok: false; why: "unknown" | "settled" | "empty-body" | "no-reason" } {
    const draft = this.get(id);
    if (draft === undefined) return { ok: false, why: "unknown" };
    if (draft.status !== "waiting") return { ok: false, why: "settled" };
    if (answer.decision === "edit" && answer.body.trim() === "") return { ok: false, why: "empty-body" };
    if (answer.decision === "reject" && answer.reason.trim() === "") return { ok: false, why: "no-reason" };
    this.append({
      event: "decided", id, by, at: this.now().toISOString(),
      decision: answer.decision === "reject" ? "rejected" : "approved",
      ...(answer.decision === "reject" ? { reason: answer.reason.trim().slice(0, 300) } : {}),
      ...(answer.decision === "edit" && answer.body !== draft.body ? { body: answer.body.slice(0, 8000) } : {}),
    });
    return { ok: true, draft: this.get(id)! };
  }

  /**
   * The consent record was answered — from the Outbox, a chat card, a word in the chat, or by
   * expiring. A draft answered anywhere but the Outbox gets its decision written here; then it is
   * finished: delivered and reported, or the refusal and its reason reported.
   */
  async settled(approvalId: string, how: "allowed" | "refused"): Promise<Draft | undefined> {
    let draft = this.byApproval(approvalId);
    if (draft === undefined || draft.delivery !== undefined) return draft;
    if (draft.status === "waiting") {
      this.append({ event: "decided", id: draft.id, decision: how === "allowed" ? "approved" : "rejected", by: "a person in the chat", at: this.now().toISOString(), ...(how === "refused" ? { reason: "refused from the chat or expired; no reason was given" } : {}) });
      draft = this.get(draft.id)!;
    }
    const world = this.world;
    if (world === undefined) return draft;
    if (draft.status === "rejected") {
      world.tell(draft.agentId, draft.conversation, rejectedText(draft),draft.work);
      if (draft.taskId !== undefined) world.note?.(draft.taskId, `Outbox ${draft.id}: ${draft.kind} to ${draft.target} refused by ${draft.decidedBy ?? "a person"} — ${draft.reason ?? "no reason given"}`);
      return draft;
    }
    const chat = world.chatFor(draft);
    if (chat === undefined) {
      world.tell(draft.agentId, draft.conversation, approvedToDoText(draft),draft.work);
      if (draft.taskId !== undefined) world.note?.(draft.taskId, `Outbox ${draft.id}: ${draft.kind} to ${draft.target} approved by ${draft.decidedBy ?? "a person"}${draft.edited === true ? " (edited)" : ""}; the agent carries it out`);
      return draft;
    }
    let result: { delivered: boolean; detail?: string };
    try {
      result = await world.deliver(draft, chat);
    } catch (error) {
      result = { delivered: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const delivery: Delivery = { delivered: result.delivered, ...(result.delivered ? { where: chat } : {}), ...(result.detail !== undefined ? { detail: result.detail.slice(0, 300) } : {}), at: this.now().toISOString() };
    this.append({ event: "delivered", id: draft.id, delivery });
    draft = this.get(draft.id)!;
    world.log?.(`outbox ${draft.id}: ${delivery.delivered ? `delivered to ${chat}` : `not delivered — ${delivery.detail ?? "no reason"}`}`);
    world.tell(draft.agentId, draft.conversation, deliveredText(draft),draft.work);
    if (draft.taskId !== undefined) world.note?.(draft.taskId, delivery.delivered ? `Outbox ${draft.id}: sent to ${chat}${draft.edited === true ? " as edited by " : ", approved by "}${draft.decidedBy ?? "a person"}` : `Outbox ${draft.id}: approved, but not delivered — ${delivery.detail ?? "no reason"}`);
    return draft;
  }

  private replay(): Map<string, Draft> {
    const drafts = new Map<string, Draft>();
    if (!existsSync(this.path)) return drafts;
    for (const raw of readFileSync(this.path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue; // a torn last line is what a crash leaves
      }
      if (line.event === "drafted") { drafts.set(line.draft.id, { ...line.draft, status: "waiting" }); continue; }
      const draft = drafts.get(line.id);
      if (draft === undefined) continue;
      if (line.event === "decided") {
        if (draft.status !== "waiting") continue; // the first answer stands
        Object.assign(draft, { status: line.decision, decidedAt: line.at, decidedBy: line.by }, line.reason !== undefined ? { reason: line.reason } : {}, line.body !== undefined ? { body: line.body, edited: true } : {});
      } else draft.delivery = line.delivery;
    }
    return drafts;
  }

  private append(line: Line): void {
    mkdirSync(dirname(this.path), { recursive: true }); // on the first draft, not at construction: a host that never drafts writes nothing
    appendLine(this.path, JSON.stringify(line));
  }
}

/** How the consent card words a draft: the host's phrase, then the agent's words verbatim. */
export function draftDescription(draft: Pick<Draft, "id" | "kind" | "target" | "body">): string {
  return `Outbox ${draft.id} — ${draft.kind} to ${draft.target}:\n\n${draft.body}`;
}

/** Where a message goes when the host carries it: a chat key a door can send to, or this conversation's chat for "here". */
export function chatTarget(draft: Pick<Draft, "kind" | "target" | "conversation">, doors: { canSend: (chatKey: string) => boolean; chatOf: (conversation: string) => string | undefined }): string | undefined {
  if (draft.kind !== "message") return undefined;
  const target = draft.target.trim();
  if (/^(here|this chat|this conversation|当前会话|这里)$/i.test(target) || target === "") return doors.chatOf(draft.conversation);
  return doors.canSend(target) ? target : undefined;
}

function rejectedText(draft: Draft): string {
  return `[Outbox ${draft.id}: ${draft.decidedBy ?? "the person"} refused your ${draft.kind} to ${draft.target}. Their reason: "${draft.reason ?? "none given"}". Nothing was sent. Do not send it again as it was; act on the reason — revise and draft again, or say what cannot be done.]`;
}

function approvedToDoText(draft: Draft): string {
  return `[Outbox ${draft.id}: ${draft.decidedBy ?? "the person"} approved your ${draft.kind} to ${draft.target}${draft.edited === true ? ", with their own changes" : ""}. The host has no door to carry it, so do it now with exactly these words:\n\n${draft.body}\n\nThen carry on with the task.]`;
}

function deliveredText(draft: Draft): string {
  if (draft.delivery?.delivered !== true) return `[Outbox ${draft.id}: approved by ${draft.decidedBy ?? "the person"}, but it could not be delivered — ${draft.delivery?.detail ?? "no reason given"}. Nothing was sent. Say so on the task, or find another way to reach ${draft.target}.]`;
  return `[Outbox ${draft.id}: ${draft.decidedBy ?? "the person"} approved your message${draft.edited === true ? " after changing it — the words sent were theirs" : ""}, and it was delivered to ${draft.delivery.where}. It is on the task's record. Do not send it again; carry on with the task.]${draft.edited === true ? `\n\nWhat was sent:\n${draft.body}` : ""}`;
}
