import { test } from "node:test";
import assert from "node:assert/strict";
import { settleReviews, REVIEW_LAPSE_MS, settleDelivered, signOffReasons, signOffView, SETTLE_ACTOR, type SettleWorld } from "./review-settle.ts";
import { TaskStore, type Task } from "./tasks.ts";

const DAY = 86_400_000;
const agents = new Set(["bob", "ada"]), isAgent = (id: string) => agents.has(id);

/** A person's request, worked by Bob and delivered: the shape of every card that asked to be accepted. */
function delivered(at = new Date("2026-11-17T08:00:00Z")) {
  const board = new TaskStore(null);
  const task = board.create({ title: "MCP 工具搜索方案选型", requester: "feishu:ou_chris", assigneeId: "bob", conversation: "feishu-oc_1", now: new Date(at.getTime() - 3_600_000) })!;
  board.update(task.id, { status: "doing" }, "bob", undefined, new Date(at.getTime() - 1_800_000));
  board.deliveryCommand(task.id, "submit", "bob", { evidence: ["brief written: weighted BM25"] }, undefined, at);
  const world = (checking = false): SettleWorld => ({ board, isAgent: id => agents.has(id), checking: () => checking });
  return { board, id: task.id, world };
}

test("a delivered result nothing depends on ends on delivery, and the record says nobody accepted it (INV-1904)", () => {
  const { board, id, world } = delivered();
  assert.equal(board.get(id)!.status, "review");
  assert.deepEqual(signOffReasons(board.get(id)!, board, isAgent), []);
  settleDelivered(board, id, world());
  const ended = board.get(id)!, last = ended.history.at(-1)!;
  assert.equal(ended.status, "done");
  assert.equal(last.by, SETTLE_ACTOR);
  assert.equal(last.closed, "delivery", "an ending, never an acceptance");
  assert.match(last.note ?? "", /Not accepted by a person/);
  assert.deepEqual(signOffView(ended, board, isAgent), [], "nothing is asked of the person once it ended");
  // A person who says it is wrong sends it back: the assignee reopens it.
  assert.equal(board.update(id, { status: "doing", note: "Chris: the numbers on the card do not hold" }, "bob")!.task.status, "doing");
});

test("a result waits for the person exactly when their word changes something", () => {
  // Work that waits on it would start on something nobody looked at.
  const blocked = delivered();
  blocked.board.create({ title: "roll the chosen search out", requester: "feishu:ou_chris", assigneeId: "ada", blockedBy: [blocked.id] });
  assert.deepEqual(signOffReasons(blocked.board.get(blocked.id)!, blocked.board, isAgent), ["blocks"]);
  settleDelivered(blocked.board, blocked.id, blocked.world());
  assert.equal(blocked.board.get(blocked.id)!.status, "review");

  // The person asked to see it first.
  const asked = delivered();
  asked.board.update(asked.id, { signOff: true }, "bob");
  settleDelivered(asked.board, asked.id, asked.world());
  assert.equal(asked.board.get(asked.id)!.status, "review");
  assert.deepEqual(signOffReasons(asked.board.get(asked.id)!, asked.board, isAgent), ["asked"]);
  const named = delivered();
  named.board.update(named.id, { reviewerId: "feishu:ou_lee" }, "feishu:ou_chris");
  assert.deepEqual(signOffReasons(named.board.get(named.id)!, named.board, isAgent), ["asked"], "a person named to review it");
  named.board.update(named.id, { reviewerId: "ada" }, "feishu:ou_chris");
  assert.deepEqual(signOffReasons(named.board.get(named.id)!, named.board, isAgent), [], "an agent reviewer's check settles it, not the person");
  settleDelivered(named.board, named.id, named.world());
  assert.equal(named.board.get(named.id)!.status, "review", "but its verdict comes first");
  named.board.update(named.id, { status: "review", note: "verified complete by Ada; awaiting the requester's acceptance" }, "review-guard");
  settleDelivered(named.board, named.id, named.world());
  assert.equal(named.board.get(named.id)!.status, "done", "and once it has passed, nothing is left to ask");

  // Handed back unfinished — out of budget or stuck — is not a delivery (Devin on #734).
  const board = new TaskStore(null);
  const stuck = board.create({ title: "index the tools", requester: "feishu:ou_chris", assigneeId: "bob" })!;
  board.update(stuck.id, { status: "doing" }, "bob");
  board.deliveryCommand(stuck.id, "handoff", "bob", { note: "incomplete (turn_budget): handed back" });
  assert.equal(board.get(stuck.id)!.status, "review");
  assert.deepEqual(signOffReasons(board.get(stuck.id)!, board, isAgent), ["unfinished"]);
  settleDelivered(board, stuck.id, { board, isAgent, checking: () => false });
  assert.equal(board.get(stuck.id)!.status, "review", "unfinished work never ends as if delivered");

  // "Show me first" holds when the turn ends, not only after an explicit submit; written criteria are asked for too.
  const shown = board.create({ title: "draft the brief", requester: "feishu:ou_chris", assigneeId: "bob", signOff: true })!;
  board.update(shown.id, { status: "doing" }, "bob");
  board.turnFinished(shown.id);
  assert.equal(board.get(shown.id)!.status, "review", "the turn ending submits it instead of closing it");
  const criteria = board.create({ title: "ship the brief", requester: "feishu:ou_chris", assigneeId: "bob", contract: { acceptance: "cites the benchmark" } })!;
  board.update(criteria.id, { status: "doing" }, "bob");
  board.turnFinished(criteria.id);
  assert.deepEqual(signOffReasons(board.get(criteria.id)!, board, isAgent), ["asked"]);

  // A check could not settle it.
  const undecided = delivered();
  undecided.board.update(undecided.id, { note: "reviewers disagree; a person decides", decide: true }, "review-guard");
  assert.deepEqual(signOffReasons(undecided.board.get(undecided.id)!, undecided.board, isAgent), ["undecided"]);
  // A check that ran on this evidence and never moved the task — exhausted, interrupted — gave no verdict either (CodeRabbit on #734).
  const cut = delivered(), ran = { running: () => false, checked: () => true };
  assert.deepEqual(signOffReasons(cut.board.get(cut.id)!, cut.board, isAgent, ran), ["undecided"]);
  cut.board.update(cut.id, { status: "review", note: "verified complete by Ada" }, "review-guard");
  assert.deepEqual(signOffReasons(cut.board.get(cut.id)!, cut.board, isAgent, ran), [], "a check that moved it gave its verdict");

  // Somebody wrote about the result after it was delivered — the 2026-11-02 note said it did not hold.
  const remarked = delivered();
  remarked.board.update(remarked.id, { note: "不能按原样验收：卡面三项数字不成立" }, "bob");
  remarked.board.update(remarked.id, { note: "nudge 1/2: idle" }, "aging");
  assert.deepEqual(signOffReasons(remarked.board.get(remarked.id)!, remarked.board, isAgent), ["remarked"], "the sweep's own notes are not remarks");
  const answered = delivered();
  answered.board.update(answered.id, { note: "数字不对，先别用" }, "feishu:ou_chris");
  assert.deepEqual(signOffReasons(answered.board.get(answered.id)!, answered.board, isAgent), ["remarked"], "the requester's own word on it holds it too");

  // Files handed over are looked at before they are used.
  const files = delivered();
  const withFiles: Task = { ...files.board.get(files.id)!, deliverables: [{ id: "d1", name: "brief.md", path: "brief.md", size: 10, sha256: "x", at: "2026-11-17T08:00:00Z", by: "bob" }] as Task["deliverables"] };
  assert.deepEqual(signOffReasons(withFiles, files.board, isAgent), ["files"]);
});

test("delivery does not end what is not a person's plain request, or what a check is still reading", () => {
  const checking = delivered();
  settleDelivered(checking.board, checking.id, checking.world(true));
  assert.equal(checking.board.get(checking.id)!.status, "review", "the check speaks first");

  const board = new TaskStore(null);
  const piece = board.create({ title: "a piece for a teammate", requester: "ada", assigneeId: "bob" })!;
  board.deliveryCommand(piece.id, "submit", "bob", { evidence: ["done"] });
  settleDelivered(board, piece.id, { board, isAgent: (id: string) => agents.has(id), checking: () => false });
  assert.equal(board.get(piece.id)!.status, "review", "an agent's own request is settled by the check record");
});

test("a review nobody answered for a week ends unreviewed, unless work waits on it", () => {
  const at = new Date("2026-11-01T08:00:00Z");
  const { board, id, world } = delivered(at);
  board.update(id, { note: "不能按原样验收" }, "bob", undefined, at); // remarked: it waits for the person, and still lapses
  assert.deepEqual(settleReviews(board, world(), new Date(at.getTime() + REVIEW_LAPSE_MS - DAY)), [], "six days is still asking");
  board.update(id, { snoozeUntil: new Date(at.getTime() + 10 * DAY).toISOString() }, "feishu:ou_chris", undefined, at);
  assert.deepEqual(settleReviews(board, world(), new Date(at.getTime() + 8 * DAY)), [], "not now means not now");
  const later = new Date(at.getTime() + 11 * DAY), ended = settleReviews(board, world(), later);
  assert.equal(ended.length, 1);
  assert.match(ended[0]!, /ended unreviewed: waited 11 days/);
  assert.equal(board.get(id)!.status, "done");
  assert.equal(board.get(id)!.history.at(-1)!.closed, "lapsed");

  const plain = delivered(at); // delivered before this rule, never moved since: the sweep ends it without waiting a week
  assert.equal(settleReviews(plain.board, plain.world(), at).length, 1);
  assert.equal(plain.board.get(plain.id)!.history.at(-1)!.closed, "delivery");

  const waited = delivered(at);
  waited.board.create({ title: "depends on it", requester: "feishu:ou_chris", assigneeId: "ada", blockedBy: [waited.id] });
  assert.deepEqual(settleReviews(waited.board, waited.world(), later), [], "downstream work keeps asking");
  assert.equal(waited.board.get(waited.id)!.status, "review");
});

test("a person's own acceptance is not marked as an ending", () => {
  const { board, id } = delivered();
  board.update(id, { signOff: true }, "bob");
  board.deliveryCommand(id, "accept", "feishu:ou_chris");
  assert.equal(board.get(id)!.status, "done");
  assert.equal(board.get(id)!.history.at(-1)!.closed, undefined);
});
