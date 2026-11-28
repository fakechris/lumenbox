/**
 * What waits on the person, and their answers (docs/106 §4.2 Decisions, docs/110 §4, INV-2214).
 *
 * `GET /inbox` is the page's own "waiting on you" — one projection (web/decisions.ts), filtered by the
 * person's reach — with the secrets agents asked for beside it. Each item says what may be done about
 * it here (`actions`); what is answered here goes through the page's own paths (approval-answer.ts,
 * outbox-answer.ts, secret-requests.ts, the board), so a phone's answer is recorded and followed through
 * as a click is, and names who answered: `user:<person> device:<id>`.
 *
 * Small-screen safety (docs/110 §4): `always` is never granted here; allowing or approving what leaves
 * the box needs a step-up proof from the device's biometric-held key (step-up.ts); a secret goes to the
 * vault and nowhere else.
 */

import type { AttentionItem } from "../../host/attention.ts";
import { urgencyOf } from "../../host/attention.ts";
import type { Draft } from "../../host/outbox-drafts.ts";
import type { PendingApproval } from "../../host/policy.ts";
import type { Task } from "../../host/tasks.ts";
import type { OutboxAnswer } from "../outbox-answer.ts";
import type { SecretRequest } from "../secret-requests.ts";
import type { Call, ClientPerson } from "./frame.ts";
import { refuse } from "./frame.ts";
import { stepUpRequiredFor, stepUpText, verifyStepUp, wordsDigest } from "./step-up.ts";
import { apiTime } from "./times.ts";
import { decodeCursor, encodeCursor, limitOf, sightOf } from "./visibility.ts";

/** What the decision operations read and do (mount.ts wires it to the server's own paths). */
export interface DecisionAccess {
  /** What waits on this person now, by the page's projection and their reach; with the records the items were made from. */
  inbox(person: ClientPerson): Promise<{ items: readonly AttentionItem[]; approvals: readonly PendingApproval[]; drafts: readonly Draft[]; tasks: readonly Task[]; secrets: readonly SecretRequest[] }>;
  answerApproval(input: { id: string; allow: boolean; scope: "once" | "session"; reason?: string | undefined; decider: string }): boolean;
  answerDraft(id: string, answer: { decision: "approve" } | { decision: "edit"; body: string } | { decision: "reject"; reason: string }, by: string, decider: string): OutboxAnswer;
  /** The person's words to an agent, in a conversation, as their message (a question's answer). */
  say(person: ClientPerson, agentId: string, conversation: string, text: string, questionId?: string): Promise<void>;
  /** `forAgent`: the agent the person was shown asking; a request now made by another under that name is not theirs to answer. */
  saveSecret(id: string, value: string, by: string, forAgent: string): "saved" | "unknown" | "empty";
  dismissSecret(id: string, by: string): boolean;
  /** A decision on work, as the page's buttons make it. */
  work(person: ClientPerson, taskId: string, decision: "done" | "keep-open" | "put-off" | "stop", until?: string, note?: string): Promise<{ ok: true } | { ok: false; why: string }>;
  stepUpKeyOf(deviceId: string): { id: string; publicKey: string } | undefined;
  /** Writes what changed in what waits on people since the ledger last said (change-ledger.ts type `inbox`). */
  noteInbox(): Promise<void>;
}

type Built = {
  id: string; kind: string; title: string; detail: string; decision: boolean; actions: string[]; stepUpRequired: boolean;
  deadline?: string; agentId?: string; agentName?: string; workId?: string;
  approval?: Record<string, unknown>; draft?: Record<string, unknown>; question?: Record<string, unknown>; secret?: Record<string, unknown>; closeProposal?: Record<string, unknown>;
  /** Not in the resource: what an answer needs. */
  hidden: { approvalId?: string; draftId?: string; secretId?: string; agentId?: string; conversation?: string; questionId?: string; options?: string[] };
};

const DECIDED_KINDS = new Set(["approval", "question", "close-proposal", "reauthorize", "spend-limit", "paused", "routine-paused", "org-knowledge", "exception", "outbox", "secret"]);
/** What may be done here about work the item is on, by kind; the rest is the page's. */
const WORK_ACTIONS: Record<string, string[]> = { "close-proposal": ["done", "keep-open"], review: ["done", "put-off"], nudged: ["done", "put-off", "stop"], reauthorize: ["stop"], flagged: ["stop"] };
const isAt = (value: string | undefined): value is string => value !== undefined && !Number.isNaN(Date.parse(value));

/** An item's id: what it is and which record it is, opaque to a client. One rule for the list, the answers and the change record. */
function itemIdOf(item: AttentionItem): string {
  if (item.kind === "question" && item.answer !== undefined) return item.answer.questionId !== undefined ? `question:${item.answer.questionId}` : `question:task:${item.ref}`;
  return `${item.kind}:${item.ref}`;
}

/** The person's inbox, built field by field: never an internal record passed through. */
async function inboxOf(call: Call): Promise<Built[]> {
  const { person } = call.caller!;
  const found = await call.deps.decisions.inbox(person);
  const approvals = new Map(found.approvals.map(item => [item.id, item]));
  const drafts = new Map(found.drafts.map(draft => [draft.id, draft]));
  const tasks = new Map(found.tasks.map(task => [task.id, task]));
  const mayDecide = person.role !== "viewer";
  const built: Built[] = [];
  for (const item of [...found.items].sort((a, b) => urgencyOf(a.kind) - urgencyOf(b.kind))) {
    const task = tasks.get(item.ref);
    const base = {
      kind: item.kind, title: item.title, detail: item.detail, decision: DECIDED_KINDS.has(item.kind),
      ...(isAt(item.deadline) ? { deadline: apiTime(item.deadline) } : {}), ...(item.with !== undefined && item.with !== "" ? { agentName: item.with } : {}),
    };
    if (item.kind === "approval") {
      const approval = approvals.get(item.ref);
      if (approval === undefined) continue;
      const scopes = approval.onceOnly === true ? ["once"] : ["once", "session"];
      built.push({
        ...base, id: itemIdOf(item), actions: mayDecide ? ["allow", "deny"] : [], stepUpRequired: stepUpRequiredFor(approval.tier), agentId: approval.agentId,
        ...(approval.returnTo?.work?.taskId !== undefined ? { workId: approval.returnTo.work.taskId } : {}),
        approval: {
          id: approval.id, description: approval.description, ...(approval.action !== undefined ? { action: approval.action } : {}), ...(approval.why !== undefined ? { why: approval.why } : {}),
          ...(approval.tier !== undefined ? { tier: approval.tier } : {}), scopes, requestedAt: apiTime(approval.requestedAt),
        },
        hidden: { approvalId: approval.id },
      });
    } else if (item.kind === "outbox") {
      const draft = drafts.get(item.ref);
      if (draft === undefined) continue;
      built.push({
        ...base, id: itemIdOf(item), actions: mayDecide ? ["approve", "edit", "reject"] : [], stepUpRequired: true, agentId: draft.agentId, ...(draft.taskId !== undefined ? { workId: draft.taskId } : {}),
        draft: { kind: draft.kind, target: draft.target, body: draft.body, why: draft.why, ...(draft.background !== undefined ? { background: draft.background } : {}) },
        hidden: { draftId: draft.id },
      });
    } else if (item.kind === "question" && item.answer !== undefined) {
      const { agentId, conversation, questionId, options } = item.answer;
      built.push({
        ...base, id: itemIdOf(item), actions: mayDecide ? ["answer"] : [], stepUpRequired: false, agentId,
        ...(task !== undefined ? { workId: task.id } : {}),
        question: { ...(options !== undefined && options.length > 0 ? { options: [...options] } : {}), conversation },
        hidden: { agentId, conversation, ...(questionId !== undefined ? { questionId } : {}), ...(options !== undefined ? { options } : {}) },
      });
    } else {
      const work = task !== undefined && WORK_ACTIONS[item.kind] !== undefined;
      built.push({
        ...base, id: itemIdOf(item), actions: work && mayDecide ? [...WORK_ACTIONS[item.kind]!] : ["open-on-page"], stepUpRequired: false,
        ...(task !== undefined ? { workId: task.id, ...(task.assigneeId !== undefined ? { agentId: task.assigneeId } : {}) } : {}),
        ...(item.kind === "close-proposal" && task?.closeProposal !== undefined
          ? { closeProposal: { by: item.with ?? task.closeProposal.by, reason: task.closeProposal.reason, ...(isAt(task.closeProposal.decideBy) ? { decideBy: apiTime(task.closeProposal.decideBy) } : {}) } }
          : {}),
        hidden: {},
      });
    }
  }
  // A secret an agent asked for: the vault is the installation's, so an Admin saves it.
  for (const request of found.secrets) {
    built.push({
      id: `secret:${request.id}`, kind: "secret", title: `${request.agentName} asks for a secret: ${request.id}`, detail: request.description, decision: true,
      // Saving is stepped up: a value of somebody else's choosing (a key, an endpoint) is what the agent would then use.
      actions: person.role === "admin" ? ["save", "dismiss"] : ["open-on-page"], stepUpRequired: true, agentId: request.agentId, agentName: request.agentName,
      secret: { name: request.id, description: request.description }, hidden: { secretId: request.id },
    });
  }
  return built;
}

const resourceOf = ({ hidden: _hidden, ...item }: Built) => item;

export async function listInbox(call: Call) {
  const items = await inboxOf(call);
  const after = decodeCursor(call.params.cursor, "inbox", (value: unknown): value is string => typeof value === "string");
  const at = after === undefined ? -1 : items.findIndex(item => item.id === after);
  // The item a cursor stopped at was answered meanwhile: say so, rather than start the list again under the client's feet.
  if (after !== undefined && at < 0) return refuse("api-cursor-invalid");
  const rest = items.slice(at + 1);
  const page = rest.slice(0, limitOf(call));
  return { items: page.map(resourceOf), ...(rest.length > page.length ? { nextCursor: encodeCursor(page.at(-1)!.id, "inbox") } : {}) };
}

/** Who answered, as the gate records it: the person, and the device or token they answered with (docs/106 §5 R8). */
const deciderOf = (call: Call): string => {
  const { person, credential } = call.caller!;
  return `user:${person.id} ${credential.kind === "device" ? "device" : "token"}:${credential.id}`;
};

/** Refuses unless the caller is a device whose registered key signed exactly this decision. */
function stepUp(call: Call, itemId: string, decision: string, detail: string): void {
  const { credential } = call.caller!;
  const proof = call.body.stepUp as { keyId?: string; signature?: string } | undefined;
  const key = credential.kind === "device" ? call.deps.decisions.stepUpKeyOf(credential.id) : undefined;
  if (key === undefined || proof === undefined) refuse("step-up-required");
  if (proof!.keyId !== key!.id || typeof proof!.signature !== "string" || !verifyStepUp(key!.publicKey, stepUpText(credential.id, itemId, decision, detail), proof!.signature)) refuse("step-up-invalid");
}

const now = () => apiTime(new Date().toISOString());

export async function decideApproval(call: Call) {
  const id = String(call.params.id);
  const item = (await inboxOf(call)).find(entry => entry.hidden.approvalId === id);
  if (item === undefined) return refuse("api-not-found");
  if (!item.actions.includes("allow")) return refuse("api-role-needed");
  const body = call.body as { decision: string; scope?: string; reason?: string };
  if (body.decision === "deny") {
    if (!call.deps.decisions.answerApproval({ id, allow: false, scope: "once", reason: body.reason, decider: deciderOf(call) })) return refuse("api-not-found");
    return { id, outcome: "denied", at: now() };
  }
  if (body.decision !== "allow") return refuse("inbox-answer-invalid", { why: "decision is allow or deny" });
  const scope = body.scope ?? "once";
  // A standing grant is not made on a small screen, nor by a script: the page makes those (docs/110 §4).
  if (scope === "always") return refuse("approval-always-refused");
  if (scope !== "once" && scope !== "session") return refuse("inbox-answer-invalid", { why: "scope is once or session" });
  if (!(item.approval!.scopes as string[]).includes(scope)) return refuse("inbox-answer-invalid", { why: "this one may be allowed once only" });
  if (item.stepUpRequired) stepUp(call, id, `allow:${scope}`, "-");
  if (!call.deps.decisions.answerApproval({ id, allow: true, scope, decider: deciderOf(call) })) return refuse("api-not-found");
  return { id, outcome: "allowed", at: now() };
}

export async function answerInboxItem(call: Call) {
  const id = String(call.params.id);
  const { person } = call.caller!;
  const item = (await inboxOf(call)).find(entry => entry.id === id);
  if (item === undefined) return refuse("api-not-found");
  const body = call.body as { action: string; text?: string; body?: string; reason?: string; value?: string };
  // The role first: a viewer answers nothing for an agent, and only an Admin saves a secret.
  const answersHere = item.kind === "question" || item.kind === "outbox" || item.kind === "secret";
  if (answersHere && (person.role === "viewer" || (item.kind === "secret" && person.role !== "admin"))) return refuse("api-role-needed");
  // Approvals and work have their own operations; anything else is answered on the page.
  if (!answersHere || !item.actions.includes(body.action)) return refuse("inbox-answer-invalid", { why: answersHere ? `it takes ${item.actions.join(", ")}` : "it is answered elsewhere" });
  const decisions = call.deps.decisions, by = person.id;
  if (item.kind === "question") {
    const text = (body.text ?? "").trim();
    if (text === "") return refuse("inbox-answer-invalid", { why: "an answer has words" });
    await decisions.say(person, item.hidden.agentId!, item.hidden.conversation!, text, item.hidden.questionId);
    return { id, outcome: "answered", at: now() };
  }
  if (item.kind === "secret") {
    if (body.action === "dismiss") { decisions.dismissSecret(item.hidden.secretId!, by); return { id, outcome: "dismissed", at: now() }; }
    const value = body.value ?? "";
    if (value.trim() === "") return refuse("inbox-answer-invalid", { why: "a secret has a value" });
    // Planting a value is an effect: a stolen fifteen-minute token must not choose what the agent then uses. The proof covers the value.
    stepUp(call, id, "save", wordsDigest(value));
    const saved = decisions.saveSecret(item.hidden.secretId!, value, by, item.agentId!);
    if (saved === "unknown") return refuse("api-not-found");
    if (saved === "empty") return refuse("inbox-answer-invalid", { why: "a secret has a value" });
    return { id, outcome: "saved", at: now() };
  }
  // An Outbox draft: approving or editing sends something outside the box, so it is stepped up; rejecting is not.
  const draftId = item.hidden.draftId!;
  if (body.action === "reject") {
    const answered = decisions.answerDraft(draftId, { decision: "reject", reason: (body.reason ?? "").trim() }, person.name, deciderOf(call));
    if (!answered.ok) return answered.why === "no-reason" ? refuse("inbox-answer-invalid", { why: "a rejection has a reason" }) : refuse("api-not-found");
    return { id, outcome: "rejected", at: now() };
  }
  const words = body.action === "edit" ? (body.body ?? "") : undefined;
  if (words !== undefined && words.trim() === "") return refuse("inbox-answer-invalid", { why: "an edit has words" });
  stepUp(call, id, body.action, words === undefined ? "-" : wordsDigest(words));
  const answered = decisions.answerDraft(draftId, words === undefined ? { decision: "approve" } : { decision: "edit", body: words }, person.name, deciderOf(call));
  if (!answered.ok) return answered.why === "empty-body" ? refuse("inbox-answer-invalid", { why: "an edit has words" }) : refuse("api-not-found");
  return { id, outcome: words === undefined ? "approved" : "edited", at: now() };
}

export async function decideWork(call: Call) {
  const id = String(call.params.id);
  const { person } = call.caller!;
  const task = call.deps.world.tasks().find(row => row.id === id);
  if (task === undefined || !sightOf(call).task(task)) return refuse("api-not-found");
  if (person.role === "viewer") return refuse("api-role-needed");
  const body = call.body as { decision: string; until?: string; note?: string };
  const decision = body.decision;
  if (decision !== "done" && decision !== "keep-open" && decision !== "put-off" && decision !== "stop") return refuse("inbox-answer-invalid", { why: "decision is done, keep-open, put-off or stop" });
  if (decision === "put-off" && (!isAt(body.until) || Date.parse(body.until!) <= Date.now())) return refuse("inbox-answer-invalid", { why: "put-off needs until, a time to come" });
  const result = await call.deps.decisions.work(person, id, decision, body.until, body.note);
  if (!result.ok) return refuse("decision-refused", { why: result.why });
  return { id, outcome: decision === "keep-open" ? "kept-open" : decision === "stop" ? "stopped" : decision, at: now() };
}

export async function getNotification(call: Call) {
  const seq = Number(call.params.seq);
  await call.deps.decisions.noteInbox();
  const found = call.deps.world.changes.after(seq - 1);
  const line = found.reset ? undefined : found.lines.find(entry => entry.seq === seq);
  if (line === undefined || line.type !== "inbox" || line.op !== "upsert") return refuse("api-not-found");
  // The words, only if it still waits on this person: a push for somebody else's item, or one already answered, says nothing.
  const item = (await inboxOf(call)).find(entry => entry.id === line.id);
  if (item === undefined) return refuse("api-not-found");
  return { seq, itemId: item.id, kind: item.kind, title: item.title, body: item.detail, at: apiTime(line.at) };
}

/**
 * The change records that bring the ledger's word on what waits on people up to `rows`: an item that came, or whose route
 * changed (it moved to another agent: its new audience is told), is an upsert; one that went is a delete, routed as it was.
 */
export function inboxChanges(last: ReadonlyMap<string, { op: "upsert" | "delete"; assigneeId?: string; requester?: string }>, rows: readonly { id: string; agentId?: string; requester?: string }[]) {
  type Line = { type: "inbox"; id: string; op: "upsert" | "delete"; assigneeId?: string; requester?: string };
  const lines: Line[] = [], present = new Set<string>();
  const routed = (agentId: string | undefined, requester: string | undefined) => ({ ...(agentId !== undefined ? { assigneeId: agentId } : {}), ...(requester !== undefined ? { requester } : {}) });
  for (const row of rows) {
    if (present.has(row.id)) continue;
    present.add(row.id);
    const before = last.get(row.id);
    const moved = before !== undefined && (before.assigneeId !== row.agentId || before.requester !== row.requester);
    if (before === undefined || before.op === "delete" || moved) lines.push({ type: "inbox", id: row.id, op: "upsert", ...routed(row.agentId, row.requester) });
  }
  for (const [id, line] of last) if (line.op !== "delete" && !present.has(id)) lines.push({ type: "inbox", id, op: "delete", ...routed(line.assigneeId, line.requester) });
  return lines;
}

/** What the change record keeps of what waits on people: the item's id and how it is routed (visibility.ts). Never its words. */
export function inboxRouting(found: Awaited<ReturnType<DecisionAccess["inbox"]>>): { id: string; agentId?: string; requester?: string }[] {
  const approvals = new Map(found.approvals.map(item => [item.id, item.agentId]));
  const drafts = new Map(found.drafts.map(draft => [draft.id, draft.agentId]));
  const tasks = new Map(found.tasks.map(task => [task.id, task]));
  const rows: { id: string; agentId?: string; requester?: string }[] = [];
  for (const item of found.items) {
    const task = tasks.get(item.ref);
    const agentId = item.kind === "approval" ? approvals.get(item.ref) : item.kind === "outbox" ? drafts.get(item.ref) : item.answer?.agentId ?? task?.assigneeId ?? (item.kind === "paused" ? item.ref : undefined);
    const id = itemIdOf(item);
    rows.push({ id, ...(agentId !== undefined ? { agentId } : task !== undefined ? { requester: task.requester } : {}) });
  }
  for (const request of found.secrets) rows.push({ id: `secret:${request.id}`, agentId: request.agentId });
  return rows;
}
