import assert from "node:assert/strict";
import { test } from "node:test";
import { satisfies } from "./action-claims.ts";
import { GOAL_BOOKKEEPING_TOOLS } from "./goal-mode.ts";
import { PushBudget } from "./push-budget.ts";
import { QuietQueue } from "./quiet-delivery.ts";
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

  assert.deepEqual(admitTell({ ...quiet, waited: false, busy: true }), { allow: true, counted: true, wait: true }, "nobody is waiting on the turn and a person is in the conversation: it goes when that is quiet (INV-1928)");
  assert.deepEqual(admitTell({ ...quiet, busy: true }), { allow: true, counted: false }, "a turn the person is waiting on is never made to wait: they are there, and asked");
});

test("a Tell from a turn nobody is waiting on waits for its conversation to be quiet, on the page as in the chat, and can be reworded or taken back until it goes (INV-1928)", async () => {
  let now = 0, personAt: number | undefined;
  const queue = new QuietQueue({ now: () => now, lastPersonAt: () => personAt, answering: () => false });
  const page: string[] = [], chat: string[] = [], filed: string[] = [], staged: string[] = [];
  const budget = new PushBudget(undefined, () => new Date("2026-11-20T10:00:00Z"));
  const teller = new Teller({
    budget, quiet: queue, gapMinutes: 0, now: () => now, chatOf: conversation => (conversation === "feishu-oc_room" ? "feishu:oc_room" : undefined),
    toChat: async (_chatKey, text) => { chat.push(text); return { delivered: true }; },
    toPage: event => { if (event.type === "told") page.push(`${event.conversation}: ${event.text}${event.files !== undefined ? ` [${event.files.map(file => file.name).join()}]` : ""}`); },
    filed: told => { filed.push(`${told.turnId}: ${told.text}`); },
  });
  const request = (more: Partial<TellRequest>): TellRequest => ({ agentId: "a1", agentName: "Ada", conversation: "main", turnId: "wake-1", text: "The export finished.", waited: false, ...more });
  const attach = async () => ({ files: [{ name: "export.csv", path: "/home/box/work/export.csv" }], stage: async () => { staged.push("export.csv"); }, left: async () => [] });

  personAt = 0; now = MINUTE;
  const attended = await teller.tell(request({ turnId: "turn-1", waited: true, text: "March is short by 3%." }));
  assert.deepEqual([attended.delivered && attended.queued, page], [undefined, ["main: March is short by 3%."]], "the person asked and is waiting: told at once, a minute after they wrote");

  const onPage = await teller.tell(request({}));
  const inChat = await teller.tell(request({ conversation: "feishu-oc_room", text: "Three invoices are overdue.", attach }));
  const second = await teller.tell(request({ conversation: "feishu-oc_room", text: "The audit closed." }));
  assert.deepEqual([onPage, inChat, second].map(told => told.delivered && told.queued), ["q1", "q2", "q3"]);
  assert.match(onPage.delivered ? onPage.where : "", /once that conversation is quiet, within 30 min/);
  assert.deepEqual([page.length, chat, filed, staged], [1, [], [], []], "nothing reaches the page, the chat, the record or the chat's outbox while the person is writing");
  assert.equal(budget.counts("a1").sent, 3, "each is counted when it is taken: its delivery is owed from then on");

  assert.deepEqual(teller.takeBack("a1", "q2", "Two invoices are overdue."), { ok: true });
  assert.deepEqual(teller.takeBack("a1", "q3"), { ok: true });
  const gone = teller.takeBack("a1", "q3");
  assert.match(gone.ok ? "" : gone.why, /nothing of yours is waiting as q3.*Waiting now: q1 “The export finished.”, q2 “Two invoices are overdue.”/);
  assert.equal(teller.takeBack("a2", "q1").ok, false, "another member's message is not this one's to take back");

  now = 3 * MINUTE;
  assert.equal(await queue.sweep(), 2);
  assert.deepEqual(page.slice(1), ["main: The export finished.", "feishu-oc_room: Two invoices are overdue. [export.csv]"], "the page gets them when the chat does, in order");
  assert.deepEqual([chat, staged], [["Two invoices are overdue."], ["export.csv"]], "the chat gets the new words, with the file it was told with");
  assert.deepEqual(filed, ["wake-1: The export finished.", "wake-1: Two invoices are overdue."], "and each is filed as said only once it was");
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
