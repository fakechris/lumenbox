import assert from "node:assert/strict";
import { test } from "node:test";
import { satisfies } from "./action-claims.ts";
import { GOAL_BOOKKEEPING_TOOLS } from "./goal-mode.ts";
import { PushBudget } from "./push-budget.ts";
import { admitTell, awaitingAnswer, TELL, Teller, TELLS_PER_TURN, type TellRequest } from "./tell.ts";
import { BOOKKEEPING_TOOLS, PERSON_FACING_TOOLS } from "./tools.ts";
import type { TurnEvent } from "./turn-events.ts";

const MINUTE = 60_000;
const quiet = { told: 0, now: 10 * MINUTE, gapMs: 2 * MINUTE, waited: true };

test("a Tell goes when the turn has room for it, and each refusal says what to do instead (INV-1853)", () => {
  assert.deepEqual(admitTell(quiet), { allow: true, counted: false }, "a turn a person is waiting on spends none of the daily allowance");
  assert.deepEqual(admitTell({ ...quiet, waited: false, pushesLeft: 1 }), { allow: true, counted: true }, "any other turn does");

  const refused = (situation: Parameters<typeof admitTell>[0]) => { const verdict = admitTell(situation); assert.equal(verdict.allow, false); return verdict.allow ? "" : verdict.reason; };
  assert.match(refused({ ...quiet, told: TELLS_PER_TURN }), /already told the person 3 things.*Put the rest in your reply/);
  assert.match(refused({ ...quiet, told: 1, lastAt: quiet.now - 30_000 }), /30s ago.*at least 2 min apart.*in 90s/);
  assert.equal(admitTell({ ...quiet, told: 1, lastAt: quiet.now - 2 * MINUTE }).allow, true, "two minutes later the next one goes");
  assert.match(refused({ ...quiet, waited: false, pushesLeft: 0 }), /nobody is waiting on this turn.*allowance.*is used/);
  assert.equal(admitTell({ ...quiet, pushesLeft: 0 }).allow, true, "an exhausted allowance never silences a turn somebody is waiting on");
  assert.match(refused({ ...quiet, awaiting: "AskUser" }), /asked the person a question.*have not answered/);
  assert.match(refused({ ...quiet, awaiting: "ShowUI" }), /card with a choice.*have not answered/);
});

function desk(options: { chat?: string; fails?: string; budget?: PushBudget; clock?: { at: number } } = {}) {
  const page: TurnEvent[] = [], chat: { chatKey: string; text: string; about: string }[] = [];
  const teller = new Teller({
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    now: () => options.clock?.at ?? 0,
    redact: text => text.replaceAll("sk-live-1", "[held]"),
    chatOf: () => options.chat,
    toChat: async (chatKey, text, about) => { if (options.fails !== undefined) return { delivered: false, why: options.fails }; chat.push({ chatKey, text, about }); return { delivered: true }; },
    toPage: event => { page.push(event); },
  });
  const request = (more: Partial<TellRequest> = {}): TellRequest => ({ agentId: "a1", agentName: "Ada", conversation: "main", turnId: "turn-1", text: "March is short by 3%.", waited: true, ...more });
  return { teller, page, chat, request };
}

test("a Tell reaches the page; from a chat's turn it reaches that chat first, with its files staged for the chat's outbox", async () => {
  const web = desk();
  assert.deepEqual(await web.teller.tell(web.request({ text: "The key sk-live-1 is rejected." })), { delivered: true, where: "in the app", text: "The key [held] is rejected.", files: [], unsent: [] });
  assert.deepEqual(web.page.map(event => event.type === "told" && [event.conversation, event.text]), [["main", "The key [held] is rejected."]], "held values are scrubbed on the way out");
  assert.deepEqual(web.chat, [], "a conversation of the page's own goes to no chat");

  const room = desk({ chat: "feishu:oc_room" }), order: string[] = [];
  const told = await room.teller.tell(room.request({
    conversation: "feishu-oc_room", callId: "call-7",
    attach: async () => ({ files: [{ name: "march.csv", path: "/home/box/work/march.csv" }], stage: async () => { order.push(`staged before ${room.chat.length} sends`); }, left: async () => [] }),
  }));
  assert.equal(told.delivered && told.where, "in the feishu chat");
  assert.deepEqual(order, ["staged before 0 sends"], "the files are in the outbox before the words go, so the same push carries them");
  assert.deepEqual(room.chat, [{ chatKey: "feishu:oc_room", text: "March is short by 3%.", about: "tell call-7" }]);
  assert.deepEqual(room.page.map(event => event.type === "told" && event.files), [[{ name: "march.csv", path: "/home/box/work/march.csv" }]], "the page shows the same words with the file as a card");
});

test("what was not delivered is not counted: against the turn's three, or against the day", async () => {
  const dead = desk({ chat: "feishu:oc_room", fails: "could not send to feishu:oc_room — timeout" });
  for (let attempt = 0; attempt < TELLS_PER_TURN + 1; attempt++) {
    assert.deepEqual(await dead.teller.tell(dead.request()), { delivered: false, why: "could not send to feishu:oc_room — timeout" }, "a failed send is reported as it failed, every time");
  }
  assert.deepEqual(dead.page, [], "and the page does not claim what the chat never got");
  const unreadable = desk();
  assert.deepEqual(await unreadable.teller.tell(unreadable.request({ attach: async () => "/home/box/work/x.pdf could not be read (missing)" })), { delivered: false, why: "/home/box/work/x.pdf could not be read (missing)" });

  const budget = new PushBudget(undefined, () => new Date("2026-11-19T10:00:00Z"));
  budget.setPerDay("a1", 1);
  const clock = { at: 0 }, routine = desk({ budget, clock });
  assert.equal((await routine.teller.tell(routine.request({ waited: true }))).delivered, true);
  assert.equal(budget.counts("a1").sent, 0, "a person's own turn is free");
  clock.at += 5 * MINUTE;
  assert.equal((await routine.teller.tell(routine.request({ turnId: "turn-2", waited: false }))).delivered, true);
  assert.equal(budget.counts("a1").sent, 1, "a turn nobody is waiting on spends one");
  const over = await routine.teller.tell(routine.request({ turnId: "turn-3", waited: false }));
  assert.match(over.delivered ? "" : over.why, /today's allowance of unprompted messages is used/);
  assert.equal(budget.counts("a1").held, 0, "and a refused Tell is not held for a digest: the member was told to put it in its reply");
});

test("a Tell waits on an open question of the same turn, and on nothing else", () => {
  const at = "t", turnId = "turn-2";
  const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
  const blocks = (...calls: unknown[]) => ({ role: "assistant", kind: "blocks", turnId, blocks: calls, at });
  const results = (...ids: [string, boolean?][]) => ({ role: "user", kind: "results", turnId, blocks: ids.map(([id, failed]) => ({ type: "tool_result", tool_use_id: id, content: "x", ...(failed ? { is_error: true } : {}) })), at });
  const choice = { surface: "pick", components: [{ id: "root", component: "Button", action: { event: { name: "choose" } } }] };
  const open = (...entries: unknown[]) => awaitingAnswer({
    registry: { readTranscript: () => [{ role: "assistant", kind: "blocks", turnId: "turn-1", blocks: [use("old", "AskUser")], at }, { role: "user", text: "do it", fromPerson: true, turnId, at }, ...entries] } as never,
    agent: { id: "a1" } as never, conversation: "main", turnId, toolUseId: "now",
  });
  assert.equal(open(blocks(use("now", TELL))), undefined, "a question of an earlier turn was answered by the message that opened this one");
  assert.equal(open(blocks(use("q", "AskUser")), results(["q"]), blocks(use("now", TELL))), "AskUser");
  assert.equal(open(blocks(use("q", "AskUser"), use("now", TELL))), "AskUser", "asked in the same breath counts as asked");
  assert.equal(open(blocks(use("q", "AskUser")), results(["q", true]), blocks(use("now", TELL))), undefined, "a question that was refused is not waiting on anyone");
  assert.equal(open(blocks(use("c", "ShowUI", choice)), results(["c"]), blocks(use("now", TELL))), "ShowUI");
  assert.equal(open(blocks(use("c", "ShowUI", { surface: "table", components: [{ id: "root", component: "Table" }] })), results(["c"]), blocks(use("now", TELL))), undefined, "a card with nothing to press asks nothing");
  assert.equal(open(blocks(use("q", "AskUser")), results(["q"]), { role: "user", text: "the second one", fromPerson: true, turnId, at }, blocks(use("now", TELL))), undefined, "their answer, arriving mid-turn, reopens it");
});

test("telling is not finishing: a Tell is no filed answer, no work done, and no evidence that anything was sent or checked", () => {
  assert.equal(BOOKKEEPING_TOOLS.has(TELL), false, "prose beside a Tell is not promoted to the turn's answer");
  assert.equal(GOAL_BOOKKEEPING_TOOLS.has(TELL), true, "a continuation that only told the person something did no work");
  assert.deepEqual((["send", "save", "schedule", "check"] as const).filter(claim => satisfies(claim, TELL)), [], "\"I sent it\" is not backed by having told the person");
  assert.equal(PERSON_FACING_TOOLS.has(TELL), true, "withheld, like a question, on a turn no person is party to");
});
