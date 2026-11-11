/** The Outbox (INV-1739): a draft waits for a person; approve delivers it, edit sends their words, reject carries the reason to the agent. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { attentionFor, isDecision } from "./attention.ts";
import { outboundVerdict } from "./outbound.ts";
import { chatTarget, type Draft, OutboxDrafts, type OutboxWorld } from "./outbox-drafts.ts";
import { PolicyGate } from "./policy.ts";
import { TaskStore } from "./tasks.ts";
import { dispatchTool } from "./tools.ts";

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-outbox-"));
  const drafts = new OutboxDrafts(join(root, "outbox-drafts.jsonl"));
  const policy = new PolicyGate({ path: join(root, "policy.jsonl"), limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] }, spentSince: () => 0 });
  policy.onApprovalSettled = (approval, how) => { void drafts.settled(approval.id, how); };
  const sent: { chatKey: string; text: string }[] = [];
  const told: { agentId: string; conversation: string; text: string }[] = [];
  const notes: { taskId: string; text: string }[] = [];
  const hands: OutboxWorld = {
    chatFor: draft => chatTarget(draft, { canSend: key => key.startsWith("feishu:"), chatOf: conversation => (conversation === "main" ? "feishu:oc_team" : undefined) }),
    deliver: async (draft, chatKey) => { sent.push({ chatKey, text: draft.body }); return { delivered: true }; },
    tell: (agentId, conversation, text) => { told.push({ agentId, conversation, text }); },
    note: (taskId, text) => { notes.push({ taskId, text }); },
  };
  drafts.connect(hands);
  const draft = (over: Partial<Draft> = {}) => {
    const id = drafts.newId();
    const approval = policy.requestConfirmation({ agentId: "a1", agentName: "Ada", description: `Outbox ${id}` });
    return drafts.record({ id, agentId: "a1", agentName: "Ada", conversation: "main", taskId: "t1", level: 4, kind: "message", target: "here", body: "The release moves to Friday.", why: "the team asked for the date", approvalId: approval.id, ...over });
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { root, drafts, policy, sent, told, notes, draft, settle, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a draft is written down, read back after a restart, and waits until its consent is answered", () => {
  const w = world();
  try {
    const kept = w.draft({ background: "the vendor slipped" });
    assert.equal(kept.status, "waiting");
    const again = new OutboxDrafts(join(w.root, "outbox-drafts.jsonl"));
    const [read] = again.waiting();
    assert.equal(read?.id, kept.id);
    assert.equal(read?.body, "The release moves to Friday.");
    assert.equal(read?.background, "the vendor slipped");
    assert.equal(again.byApproval(kept.approvalId)?.id, kept.id);
    assert.deepEqual(w.sent, [], "nothing goes before a person answers");
  } finally { w.cleanup(); }
});

test("approve: delivered to the chat it names, written on the draft and the task, and the agent is told to carry on", async () => {
  const w = world();
  try {
    const kept = w.draft();
    assert.equal(w.drafts.decide(kept.id, { decision: "approve" }, "Chris").ok, true);
    w.policy.grant(kept.approvalId, "user", "once");
    await w.settle();
    const done = w.drafts.get(kept.id)!;
    assert.equal(done.status, "approved");
    assert.equal(done.decidedBy, "Chris");
    assert.deepEqual(done.delivery && { delivered: done.delivery.delivered, where: done.delivery.where }, { delivered: true, where: "feishu:oc_team" });
    assert.deepEqual(w.sent, [{ chatKey: "feishu:oc_team", text: "The release moves to Friday." }]);
    assert.match(w.notes[0]!.text, /sent to feishu:oc_team, approved by Chris/);
    assert.match(w.told[0]!.text, /approved your message, and it was delivered to feishu:oc_team[\s\S]*Do not send it again; carry on/);
    assert.deepEqual(w.drafts.waiting(), []);
  } finally { w.cleanup(); }
});

test("edit and approve: the person's words are what is sent, and the agent is told they changed", async () => {
  const w = world();
  try {
    const kept = w.draft();
    assert.deepEqual(w.drafts.decide(kept.id, { decision: "edit", body: "  " }, "Chris"), { ok: false, why: "empty-body" });
    assert.equal(w.drafts.decide(kept.id, { decision: "edit", body: "The release moves to Friday 18:00." }, "Chris").ok, true);
    w.policy.grant(kept.approvalId, "user", "once");
    await w.settle();
    assert.equal(w.drafts.get(kept.id)?.edited, true);
    assert.deepEqual(w.sent.map(item => item.text), ["The release moves to Friday 18:00."]);
    assert.match(w.told[0]!.text, /after changing it[\s\S]*What was sent:\nThe release moves to Friday 18:00\./);
  } finally { w.cleanup(); }
});

test("reject: nothing is sent and the reason is in the message the agent's next turn reads", async () => {
  const w = world();
  try {
    const kept = w.draft();
    assert.deepEqual(w.drafts.decide(kept.id, { decision: "reject", reason: "" }, "Chris"), { ok: false, why: "no-reason" });
    assert.equal(w.drafts.decide(kept.id, { decision: "reject", reason: "wait until legal signs off" }, "Chris").ok, true);
    assert.deepEqual(w.drafts.decide(kept.id, { decision: "approve" }, "Chris"), { ok: false, why: "settled" }, "the first answer stands");
    w.policy.deny(kept.approvalId, "user", "wait until legal signs off");
    await w.settle();
    assert.equal(w.drafts.get(kept.id)?.status, "rejected");
    assert.deepEqual(w.sent, []);
    assert.equal(w.told[0]!.agentId, "a1");
    assert.equal(w.told[0]!.conversation, "main");
    assert.match(w.told[0]!.text, /Chris refused your message to here\. Their reason: "wait until legal signs off"\. Nothing was sent/);
    assert.match(w.notes[0]!.text, /refused by Chris — wait until legal signs off/);
  } finally { w.cleanup(); }
});

test("answered from the chat card instead, or expired: still recorded, still finished", async () => {
  const w = world();
  try {
    const yes = w.draft(), no = w.draft();
    w.policy.grant(yes.approvalId, "user", "once");
    w.policy.deny(no.approvalId, "system", "nobody answered", "approval-expired");
    await w.settle();
    assert.equal(w.drafts.get(yes.id)?.decidedBy, "a person in the chat");
    assert.equal(w.sent.length, 1);
    assert.equal(w.drafts.get(no.id)?.status, "rejected");
    assert.match(w.told.find(item => item.text.includes(no.id))!.text, /no reason was given/);
  } finally { w.cleanup(); }
});

test("a step the host cannot carry is approved for the agent to do, with the approved words", async () => {
  const w = world();
  try {
    const post = w.draft({ kind: "publish", target: "the company blog", body: "Q3 notes" });
    const stranger = w.draft({ target: "Mia's phone" });
    w.policy.grant(post.approvalId, "user", "once");
    w.policy.grant(stranger.approvalId, "user", "once");
    await w.settle();
    assert.deepEqual(w.sent, []);
    assert.match(w.told[0]!.text, /approved your publish to the company blog\. The host has no door to carry it, so do it now with exactly these words:\n\nQ3 notes/);
    assert.match(w.told[1]!.text, /no door to carry it/);
    assert.equal(w.drafts.get(post.id)?.delivery, undefined);
  } finally { w.cleanup(); }
});

test("where a message goes: this chat for \"here\", a chat key a door can send to, nowhere for anything else", () => {
  const doors = { canSend: (key: string) => key === "feishu:oc_ops", chatOf: (conversation: string) => (conversation === "c1" ? "feishu:oc_here" : undefined) };
  assert.equal(chatTarget({ kind: "message", target: "here", conversation: "c1" }, doors), "feishu:oc_here");
  assert.equal(chatTarget({ kind: "message", target: "feishu:oc_ops", conversation: "c1" }, doors), "feishu:oc_ops");
  assert.equal(chatTarget({ kind: "message", target: "Mia", conversation: "c1" }, doors), undefined);
  assert.equal(chatTarget({ kind: "email", target: "feishu:oc_ops", conversation: "c1" }, doors), undefined, "only a message is carried");
});

test("the delivery gate lets a draft through only once a person approved it", () => {
  const world = { taskStatus: () => undefined, pendingQuestion: () => undefined, answerOwed: () => false };
  assert.equal(outboundVerdict({ kind: "draft", id: "ob-1" }, world, new Set()).allow, false, "no Outbox, no draft goes");
  assert.equal(outboundVerdict({ kind: "draft", id: "ob-1" }, { ...world, draftApproved: id => id === "ob-1" }, new Set()).allow, true);
  assert.equal(outboundVerdict({ kind: "draft", id: "ob-2" }, { ...world, draftApproved: id => id === "ob-1" }, new Set()).allow, false);
});

test("the Outbox tool drafts against the task in hand and asks the person on a consent record; nothing is sent", async () => {
  const w = world();
  const home = mkdtempSync(join(tmpdir(), "agentbox-outbox-tool-"));
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const bus = new AgentBus(registry, async () => {});
    const ada = registry.create({ name: "Ada" });
    const tasks = new TaskStore(join(home, "tasks.jsonl"));
    const task = tasks.create({ title: "Tell the team the new release date", requester: "chris", assigneeId: ada.id, level: 4 })!;
    tasks.update(task.id, { status: "doing" }, ada.id);
    const context = { agent: ada, registry, bus, box: undefined, tasks, taskBinding:{taskId:task.id,role:"executor"}, policy: w.policy, outbox: w.drafts };
    const refused = await dispatchTool("Outbox", { kind: "message", target: "here", body: "Friday." }, context as never);
    assert.equal(refused.isError, true, "no reason, no draft");
    const said = await dispatchTool("Outbox", { kind: "message", target: "here", body: "Friday.", why: "they asked" }, context as never);
    assert.match(said.text, /in the Outbox as ob-[0-9a-f]{8}[\s\S]*Nothing has been sent/);
    const [draft] = w.drafts.waiting();
    assert.equal(draft?.taskId, task.id);
    assert.equal(draft?.level, 4);
    const [approval] = w.policy.pending();
    assert.equal(approval?.id, draft?.approvalId);
    assert.equal(approval?.harnessResumes, true, "the host carries it on; the agent is not told to retry");
    assert.equal(approval?.why, "they asked");
    assert.match(approval?.description ?? "", /message to here:\n\nFriday\./);
    const none = await dispatchTool("Outbox", { kind: "message", target: "here", body: "x", why: "y" }, { agent: ada, registry, bus, box: undefined } as never);
    assert.equal(none.isError, true, "no Outbox, no one to approve");
  } finally { w.cleanup(); rmSync(home, { recursive: true, force: true }); }
});

test("the person's list shows a draft once, as itself, as a decision — never again as its consent record", () => {
  const w = world();
  try {
    const kept = w.draft();
    const answer = attentionFor({ principalId: "", identities: [], tasks: [], questions: [], nameOf: id => id, all: true, outbox: w.drafts.waiting(), approvals: w.policy.pending() });
    assert.deepEqual(answer.mine.map(item => item.kind), ["outbox"]);
    assert.equal(answer.mine[0]!.draft?.body, "The release moves to Friday.");
    assert.equal(answer.mine[0]!.ref, kept.id);
    assert.equal(isDecision("outbox"), true, "counted in the strip's N decisions");
  } finally { w.cleanup(); }
});
