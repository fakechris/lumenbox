/**
 * INV-1878: a member's reminder to itself. The real pending-work ledger on a real file, the real
 * effects that fire it and the real tool; the fakes are the clock, the member's inbox and the
 * report door. The whole episode on the bus, with a chat and the quiet rule, is in scenario.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effects } from "./effects.ts";
import { asModelSees, HOST_ORIGINS, inboundChannel } from "./model-text.ts";
import { PendingWork } from "./pending-work.ts";
import { PolicyGate } from "./policy.ts";
import { parseDue, pendingReminders, REMINDER_ORIGIN, reminderPrompt, REMINDERS_PER_AGENT, reminderTool, type Reminder } from "./reminders.ts";
import { reminderRoute } from "../web/reminder-routes.ts";
import { AgentRegistry, conversationIdFor } from "../agents/registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { fakeModel, type ModelCapture } from "./testing/fake-model.ts";

const NOW = new Date("2026-11-20T08:00:00Z");

function harness(report?: (reminder: Reminder & { chat: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-reminders-"));
  const clock = { now: NOW };
  const path = join(dir, "pending-work.jsonl");
  const notes: { agentId: string; text: string; conversation: string }[] = [];
  const logged: string[] = [];
  /** Whether the member's inbox admits a note. */
  const inbox = { up: true };
  const policy = new PolicyGate({ path: join(dir, "policy.jsonl"), limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] }, spentSince: () => 0 });
  /** A process: its own ledger object and effects over the same file. */
  const start = () => {
    const ledger = new PendingWork(path);
    const effects = new Effects({
      pendingWork: ledger, policy, mcp: () => undefined, now: () => clock.now, log: line => logged.push(line),
      deliver: (agentId, text, conversation) => { if (!inbox.up) return false; notes.push({ agentId, text, conversation }); return true; },
      ...(report !== undefined ? { report } : {}),
    });
    const as = (agentId: string, conversation = "main") => (input: Record<string, unknown>) => reminderTool({ agent: { id: agentId } as never, conversation, pendingWork: ledger }, input, clock.now);
    return { ledger, effects, as };
  };
  return { clock, notes, logged, inbox, start, at: (iso: string) => { clock.now = new Date(iso); }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a due time is a span from now or an ISO instant; one in the past, one past a year and one that is not a time are refused in words that say what to do", () => {
  const due = (text: string) => parseDue(text, NOW);
  const iso = (text: string) => { const at = due(text); assert.ok(at instanceof Date, `${text}: ${String(at)}`); return at.toISOString(); };
  assert.equal(iso("30m"), "2026-11-20T08:30:00.000Z");
  assert.equal(iso("2h"), "2026-11-20T10:00:00.000Z");
  assert.equal(iso("in 3 days"), "2026-11-23T08:00:00.000Z");
  assert.equal(iso("1 week"), "2026-11-27T08:00:00.000Z");
  assert.equal(iso("1.5h"), "2026-11-20T09:30:00.000Z");
  assert.equal(iso("2026-12-01T09:00:00Z"), "2026-12-01T09:00:00.000Z");
  assert.equal(iso("2026-12-01T09:00+08:00"), "2026-12-01T01:00:00.000Z", "an offset is honoured");
  assert.match(String(due("2026-11-18T09:00:00Z")), /not in the future .* do it in this turn instead/, "the item's own example date, two days gone");
  assert.match(String(due("0m")), /not in the future/);
  assert.match(String(due("2028-01-01T00:00:00Z")), /more than a year away/);
  assert.match(String(due("60w")), /more than a year away/);
  for (const text of ["next Tuesday", "", "3 fortnights", "soon", "12"]) assert.match(String(due(text)), /is not a time: give `30m`/, text);
});

test("a member sets a reminder, sees it in its list, and is woken with it once when due — also when the process restarted in between, and not again after", () => {
  const h = harness();
  try {
    const first = h.start();
    const set = first.as("ada", "feishu-oc_ops")({ action: "set", message: "Check whether PR 761 merged, and rebase if not.", due: "2026-11-21T09:00:00Z" });
    assert.equal(set.isError, undefined);
    assert.match(set.text, /^Reminder pw-[0-9a-f-]+ set for 2026-11-21T09:00:00\.000Z\. You will be woken with the note in this conversation\.$/);
    assert.match(first.as("ada")({ action: "list" }).text, /^1 of 20 reminders waiting, soonest first:\npw-\S+ · due 2026-11-21T09:00:00\.000Z · Check whether PR 761 merged/);
    assert.equal(first.as("bo")({ action: "list" }).text, "You have no reminders waiting.", "another member's list is its own");

    h.at("2026-11-21T08:59:00Z");
    assert.equal(first.effects.deliverDue(), 0, "a minute early is not due");

    const second = h.start();
    assert.equal(pendingReminders(second.ledger, "ada").length, 1, "the new process finds it waiting");
    h.at("2026-11-21T09:00:20Z");
    assert.equal(second.effects.deliverDue(), 1);
    assert.equal(second.effects.deliverDue(), 0);
    assert.equal(h.start().effects.deliverDue(), 0, "nor after one more restart");
    assert.deepEqual(h.notes, [{ agentId: "ada", text: "[Reminder you set: Check whether PR 761 merged, and rebase if not.]", conversation: "feishu-oc_ops" }], "once, in the conversation it was set in");
    assert.equal(second.as("ada")({ action: "list" }).text, "You have no reminders waiting.");
  } finally { h.cleanup(); }
});

test("the twenty-first waiting reminder is refused with what to do about it; cancelling one makes room, and another member's twenty are not this one's", () => {
  const h = harness();
  try {
    const { as, ledger } = h.start();
    for (let n = 1; n <= REMINDERS_PER_AGENT; n++) assert.equal(as("ada")({ action: "set", message: `look at item ${n}`, due: `${n}h` }).isError, undefined, `reminder ${n}`);
    const refused = as("ada")({ action: "set", message: "one more", due: "3d" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /refused — you already have 20 reminders waiting, and 20 is the most one member holds\. List them and cancel one you no longer need, or put this on a task/);
    assert.equal(pendingReminders(ledger, "ada").length, 20, "nothing was written");
    assert.equal(as("bo")({ action: "set", message: "mine", due: "1d" }).isError, undefined, "the limit is each member's own");

    const soonest = pendingReminders(ledger, "ada")[0]!;
    assert.equal(soonest.text, "look at item 1", "soonest first");
    assert.match(as("bo")({ action: "cancel", id: soonest.id }).text, /refused — no reminder of yours is waiting as pw-/, "a member cancels only its own");
    assert.match(as("ada")({ action: "cancel", id: soonest.id }).text, /cancelled; it will not fire/);
    assert.equal(as("ada")({ action: "set", message: "one more", due: "3d" }).isError, undefined, "and now there is room");
  } finally { h.cleanup(); }
});

test("a reminder a person dismissed on the page, or the member cancelled, does not fire; a call that is missing a part says which", async () => {
  const h = harness();
  try {
    const { as, ledger, effects } = h.start();
    as("ada")({ action: "set", message: "ask about the quote", due: "1h" });
    as("ada")({ action: "set", message: "check the deploy", due: "1h" });
    as("ada")({ action: "set", message: "renew the certificate", due: "1h" });
    const [quote, deploy] = pendingReminders(ledger, "ada");
    const deps = { readJson: async () => ({ id: quote!.id }), refused: () => false, agentName: (id: string) => (id === "ada" ? "Ada" : undefined), mayReadAgent: () => true };

    const listed = await reminderRoute("GET /api/reminders", ledger, deps);
    assert.deepEqual((listed!.body as { reminders: { text: string; agentName: string }[] }).reminders.map(entry => `${entry.agentName}: ${entry.text}`), ["Ada: ask about the quote", "Ada: check the deploy", "Ada: renew the certificate"]);
    assert.deepEqual((await reminderRoute("GET /api/reminders", ledger, { ...deps, mayReadAgent: () => false }))!.body, { reminders: [] }, "a member this caller may not read is left out");
    assert.equal((await reminderRoute("POST /api/reminders/dismiss", ledger, { ...deps, refused: () => true }))!.status, 0, "somebody who may not drive is refused by the server's own answer");
    assert.equal(pendingReminders(ledger).length, 3);
    assert.equal((await reminderRoute("POST /api/reminders/dismiss", ledger, deps))!.status, 200);
    assert.equal((await reminderRoute("POST /api/reminders/dismiss", ledger, deps))!.status, 404, "a second press finds nothing waiting");
    assert.equal(await reminderRoute("GET /api/schedules", ledger, deps), undefined, "any other route is not this one's");
    as("ada")({ action: "cancel", id: deploy!.id });

    h.at("2026-11-20T09:00:30Z");
    assert.equal(h.start().effects.deliverDue(), 1);
    assert.equal(effects.deliverDue(), 0);
    assert.deepEqual(h.notes.map(note => note.text), ["[Reminder you set: renew the certificate]"], "only the one nobody dropped");

    assert.match(as("ada")({ action: "set", due: "1h" }).text, /needs a `message`/);
    assert.match(as("ada")({ action: "set", message: "x" }).text, /needs `due`/);
    assert.match(as("ada")({ action: "set", message: "x".repeat(1_001), due: "1h" }).text, /1001 characters and the most is 1000/);
    assert.match(as("ada")({ action: "set", message: "x", due: "yesterday" }).text, /is not a time/);
    assert.match(as("ada")({ action: "cancel" }).text, /needs the reminder's `id`/);
    assert.match(as("ada")({ action: "snooze" }).text, /`action` is one of set, list, cancel/);
    assert.match(reminderTool({ agent: { id: "ada" } as never }, { action: "list" }).text, /this host keeps no reminders/);
  } finally { h.cleanup(); }
});

test("a reminder that names a chat runs as the member's own turn through the report door, once across a restart, with a prompt that says the host opened it; if that turn cannot start the member still gets its note, retried until its inbox takes it and without a second turn", async () => {
  const reported: (Reminder & { chat: string })[] = [];
  let fail = false, last: Promise<void> = Promise.resolve();
  const h = harness(reminder => { reported.push(reminder); last = fail ? Promise.reject(new Error("Ada is paused")) : Promise.resolve(); return last; });
  try {
    const first = h.start();
    assert.match(first.as("ada")({ action: "set", message: "Tell the room whether the March export landed.", due: "2h", chat: "feishu:oc_ops" }).text, /What you say then is reported to feishu:oc_ops\.$/);
    assert.match(first.as("ada")({ action: "list" }).text, /· reports to feishu:oc_ops · Tell the room/);

    h.at("2026-11-20T10:00:10Z");
    const second = h.start();
    assert.equal(second.effects.deliverDue(), 1);
    assert.equal(h.start().effects.deliverDue(), 0, "a restart while its turn runs does not start it again");
    assert.equal(reported.length, 1);
    assert.equal(h.notes.length, 0, "nothing is also queued to the member as a note");
    assert.deepEqual({ agentId: reported[0]!.agentId, chat: reported[0]!.chat, conversation: reported[0]!.conversation, due: reported[0]!.due }, { agentId: "ada", chat: "feishu:oc_ops", conversation: "main", due: "2026-11-20T10:00:00.000Z" });

    // What the member reads: the host's words about its own note, never a person's request.
    const prompt = reminderPrompt(reported[0]!);
    assert.match(prompt, /^\[reminder\] This turn was started by a reminder you set for yourself on 2026-11-20T08:00:00\.000Z, not by a person\./);
    assert.match(prompt, /delivered to feishu:oc_ops/);
    assert.match(prompt, /NothingToSay/);
    assert.match(prompt, /Your note: Tell the room whether the March export landed\.$/);
    assert.ok(HOST_ORIGINS.has(REMINDER_ORIGIN.replace(/^host:/, "")), "the origin its turn carries is a registered one");
    assert.equal(inboundChannel({ fromId: "user", origin: REMINDER_ORIGIN, text: prompt }), "host");
    assert.equal(asModelSees({ origin: REMINDER_ORIGIN, text: "Look at the export." }), "[from the host (host:reminder), not from a person] Look at the export.");

    // INV-2009: the turn cannot start and the member's inbox refuses the note too. The reminder is
    // not done: the note is owed, listed as such, and offered again until the inbox takes it.
    fail = true;
    h.inbox.up = false;
    second.as("ada")({ action: "set", message: "Post the weekly numbers.", due: "1h", chat: "feishu:oc_ops" });
    h.at("2026-11-20T11:00:10Z");
    assert.equal(second.effects.deliverDue(), 1);
    await last.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reported.length, 2);
    assert.equal(h.notes.length, 0);
    assert.match(h.logged.join("\n"), /its turn for feishu:oc_ops did not run \(Ada is paused\); owed to the member as a note/);
    const owed = pendingReminders(second.ledger, "ada");
    assert.deepEqual(owed.map(entry => ({ text: entry.text, chat: entry.chat, missed: entry.missed })), [{ text: "Post the weekly numbers.", chat: undefined, missed: { chat: "feishu:oc_ops", why: "Ada is paused" } }], "still waiting, never shown as done");
    assert.match(second.as("ada")({ action: "list" }).text, /could not report to feishu:oc_ops; waiting to reach you · Post the weekly numbers\./);
    const page = await reminderRoute("GET /api/reminders", second.ledger, { readJson: async () => ({}), refused: () => false, agentName: () => "Ada", mayReadAgent: () => true });
    assert.deepEqual((page!.body as { reminders: Reminder[] }).reminders.map(entry => entry.missed?.chat), ["feishu:oc_ops"]);

    h.at("2026-11-20T11:01:10Z");
    assert.equal(h.start().effects.deliverDue(), 0, "still refused after a restart: it stays waiting");
    h.inbox.up = true;
    const third = h.start();
    assert.equal(third.effects.deliverDue(), 1);
    assert.equal(third.effects.deliverDue(), 0);
    assert.equal(h.start().effects.deliverDue(), 0);
    assert.equal(reported.length, 2, "no restart or retry opened the chat's turn a second time");
    assert.deepEqual(h.notes.map(note => note.text), ["[Reminder you set: Post the weekly numbers.] [It was to be reported to feishu:oc_ops, but that turn could not run: Ada is paused]"]);
    assert.equal(third.as("ada")({ action: "list" }).text, "You have no reminders waiting.");
  } finally { h.cleanup(); }
});

test("a reminder an extension's tool result asks for is the same record: it counts towards the member's twenty and shows in its list", () => {
  const h = harness();
  try {
    const { as, effects, ledger } = h.start();
    for (let n = 1; n <= REMINDERS_PER_AGENT - 1; n++) as("ada")({ action: "set", message: `item ${n}`, due: `${n}h` });
    const asked = { agentId: "ada", agentName: "Ada", conversation: "main", tool: "ext__notes" };
    assert.match(effects.apply({ ...asked, effects: [{ type: "reminder", text: "check the deploy", at: "2026-11-22T09:00:00Z" }] }).notes[0]!, /Reminder set for 2026-11-22T09:00:00\.000Z/);
    assert.match(effects.apply({ ...asked, effects: [{ type: "reminder", text: "and again", at: "2026-11-23T09:00:00Z" }] }).notes[0]!, /The reminder was not set: you already have 20 reminders waiting/);
    assert.equal(pendingReminders(ledger, "ada").at(-1)!.text, "check the deploy");
  } finally { h.cleanup(); }
});

test("on the orchestrator a due reminder with a chat is a turn the host opened, and what the member says leaves by the routine's report door and no other", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-reminder-orch-")), previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents")), ada = registry.create({ name: "Ada" });
    const capture: ModelCapture = { params: [] }, sent: { chatKey: string; text: string; from?: string }[] = [];
    const orch = new Orchestrator({
      registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks: null, extensions: null, pendingWork: new PendingWork(join(root, "pending-work.jsonl")),
      deliverToChat: async (chatKey, text, from) => { sent.push({ chatKey, text, ...(from !== undefined ? { from } : {}) }); return { delivered: true }; },
      client: fakeModel(() => ({ id: "r", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "The March export landed at 08:40." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } } as never), { capture }),
    });
    // Set an hour ago for half an hour later: due now, by the clock the host fires on.
    const set = reminderTool({ agent: ada, conversation: "main", pendingWork: orch.pendingWork }, { action: "set", message: "Say whether the March export landed.", due: "30m", chat: "feishu:oc_ops" }, new Date(Date.now() - 3_600_000));
    assert.equal(set.isError, undefined, set.text);

    assert.equal(orch.effects!.deliverDue(), 1);
    for (let waited = 0; sent.length === 0 && waited < 500; waited++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(sent, [{ chatKey: "feishu:oc_ops", text: "The March export landed at 08:40.", from: ada.id }]);
    assert.equal(orch.effects!.deliverDue(), 0);

    const conversation = conversationIdFor("feishu:oc_ops");
    const opened = (registry.readTranscript(ada.id, conversation) as { role: string; kind?: string; text?: string; host?: true; fromPerson?: true }[]).filter(entry => entry.role === "user" && entry.kind === undefined);
    assert.equal(opened.length, 1, "one turn, in the chat's conversation");
    assert.match(opened[0]!.text!, /^\[reminder\] This turn was started by a reminder you set for yourself/);
    assert.equal(opened[0]!.host, true, "recorded as the host's");
    assert.equal(opened[0]!.fromPerson, undefined, "and not as what a person said");
    assert.ok((capture.params[0]?.tools ?? []).some(tool => (tool as { name: string }).name === "NothingToSay"), "nobody is waiting on it: silence is offered");
    assert.equal(orch.routineResults.lastFor(`reminder:${pendingReminderId(set.text)}`)?.delivered, true, "the report door's own record has it, under the reminder's name");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

function pendingReminderId(setText: string): string {
  return /Reminder (pw-\S+) set/.exec(setText)![1]!;
}
