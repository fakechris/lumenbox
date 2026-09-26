/**
 * A routine's run is execute then resolve (INV-776): the result is on the ledger before a
 * verdict is asked for; the rules decide silent / attach_next / push_now; a routine that
 * asks for every run gets every run; the same result twice is delivered once; and what
 * nothing holds among a report's commitments is a note on the one delivery, never a
 * second message.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "./fetched.ts";
import {
  PendingAttachments,
  RoutineResultLedger,
  finishRoutineRun,
  parseDeliverWhen,
  parseResolveVerdict,
  resolveByRules,
  resolveRoutineResult,
  routineResolveMode,
  type RoutineDeliveryDeps,
} from "./routine-resolve.ts";

function home(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-routine-resolve-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function harness(path: string, overrides: Partial<RoutineDeliveryDeps> = {}) {
  const pushed: string[] = [];
  const attachments = new PendingAttachments();
  const ledger = new RoutineResultLedger(join(path, "routine-results.jsonl"));
  const deps: RoutineDeliveryDeps = {
    ledger,
    recentChat: () => [],
    deliverToChat: async (_chat, text) => { pushed.push(text); },
    attachNext: (chat, text) => attachments.add(chat, text),
    ...overrides,
  };
  return { pushed, attachments, ledger, deps };
}

const run = (said: string, extra: Partial<Parameters<typeof finishRoutineRun>[0]> = {}) => ({
  slug: "price-check", agentId: "a1", agentName: "Nova", deliver: "feishu:oc_1", said, ...extra,
});

test("the rules: nothing to say and no text are silent; a changed result pushes; deliver_when: always always pushes", () => {
  const base = { slug: "s", deliver: "c", recentChat: [] as string[] };
  assert.equal(resolveByRules({ ...base, text: "", silent: { reason: "no change" } }).verdict, "silent");
  assert.equal(resolveByRules({ ...base, text: "" }).verdict, "silent");
  assert.equal(resolveByRules({ ...base, text: "BTC 60k" }).verdict, "push_now");
  const previous = { sha256: sha256("BTC 60k"), text: "BTC 60k", at: "2026-09-26T09:00:00Z" };
  assert.equal(resolveByRules({ ...base, text: "BTC 60k", previous }).verdict, "silent", "the same bytes as last time");
  assert.equal(resolveByRules({ ...base, text: "BTC 60k", previous, deliverWhen: "always" }).verdict, "push_now", "unless the routine asked for every run");
  assert.equal(resolveByRules({ ...base, text: "BTC 61k", previous }).verdict, "push_now");
  assert.equal(parseDeliverWhen(" Always "), "always");
  assert.equal(parseDeliverWhen("sometimes"), undefined);
  assert.equal(routineResolveMode({}), "rules");
  assert.equal(routineResolveMode({ AGENTBOX_ROUTINE_RESOLVE: "model" }), "model");
});

test("the result is written before the verdict is asked for, and written again with it", async () => {
  const { path, cleanup } = home();
  try {
    let seen: string | undefined;
    const { deps, ledger, pushed } = harness(path, {
      mode: "model",
      ask: async () => {
        seen = readFileSync(join(path, "routine-results.jsonl"), "utf8");
        return JSON.stringify({ verdict: "attach_next", reason: "not urgent" });
      },
    });
    const out = await finishRoutineRun(run("BTC 60k"), deps);
    assert.match(seen ?? "", /"verdict":"pending"/, "on disk before the judge answered");
    assert.equal(out.verdict, "attach_next");
    assert.deepEqual(pushed, []);
    const listed = ledger.list();
    assert.equal(listed.length, 1, "pending and resolved read as one run");
    assert.equal(listed[0]!.verdict, "attach_next");
    assert.equal(listed[0]!.reason, "not urgent");
  } finally { cleanup(); }
});

test("three verdicts: silent stays on the ledger, attach_next queues under the next reply, push_now goes to the chat", async () => {
  const { path, cleanup } = home();
  try {
    const answers = ["silent", "attach_next", "push_now"];
    const { deps, ledger, pushed, attachments } = harness(path, {
      mode: "model",
      ask: async () => JSON.stringify({ verdict: answers.shift(), reason: "judged" }),
    });
    // The model is only asked past the rules, so a silence from the judge needs a result the
    // rules would have pushed: three different texts.
    const silent = await finishRoutineRun(run("one"), deps);
    assert.equal(silent.verdict, "silent");
    assert.equal(silent.delivered, undefined);
    const attached = await finishRoutineRun(run("two"), deps);
    assert.equal(attached.verdict, "attach_next");
    assert.equal(attachments.take("feishu:oc_1"), "two");
    assert.equal(attachments.take("feishu:oc_1"), undefined, "taken once");
    const pushedNow = await finishRoutineRun(run("three"), deps);
    assert.equal(pushedNow.verdict, "push_now");
    assert.deepEqual(pushed, ["three"]);
    assert.deepEqual(ledger.list().map(entry => [entry.text, entry.verdict]), [["three", "push_now"], ["two", "attach_next"], ["one", "silent"]], "every run is on the record, delivered or not");
  } finally { cleanup(); }
});

test("without an attach hook, attach_next is delivered as push_now", async () => {
  const { path, cleanup } = home();
  try {
    const { deps, pushed } = harness(path, {
      attachNext: undefined,
      mode: "model",
      ask: async () => JSON.stringify({ verdict: "attach_next", reason: "later" }),
    });
    const out = await finishRoutineRun(run("x"), deps);
    assert.equal(out.verdict, "attach_next");
    assert.deepEqual(pushed, ["x"]);
  } finally { cleanup(); }
});

test("deliver_when: always pushes every run, even one identical to the last", async () => {
  const { path, cleanup } = home();
  try {
    const { deps, pushed } = harness(path);
    await finishRoutineRun(run("same", { deliverWhen: "always" }), deps);
    await finishRoutineRun(run("same", { deliverWhen: "always" }), deps);
    assert.deepEqual(pushed, ["same", "same"]);
  } finally { cleanup(); }
});

test("a result identical to the previous run's is suppressed; a NothingToSay is silent with its reason on the record", async () => {
  const { path, cleanup } = home();
  try {
    const { deps, pushed, ledger } = harness(path);
    assert.equal((await finishRoutineRun(run("BTC 60k"), deps)).verdict, "push_now");
    const again = await finishRoutineRun(run("BTC 60k"), deps);
    assert.equal(again.verdict, "silent");
    assert.match(again.reason, /same result as the previous run/);
    const quiet = await finishRoutineRun(run("", { silent: { reason: "price unchanged" } }), deps);
    assert.equal(quiet.verdict, "silent");
    assert.match(quiet.reason, /price unchanged/);
    // A silence between two identical results does not make the second one a change.
    assert.equal((await finishRoutineRun(run("BTC 60k"), deps)).verdict, "silent");
    assert.equal((await finishRoutineRun(run("BTC 61k"), deps)).verdict, "push_now");
    assert.deepEqual(pushed, ["BTC 60k", "BTC 61k"]);
    assert.deepEqual(ledger.lastFor("price-check")?.text, "BTC 61k");
    assert.equal(ledger.list({ slug: "price-check" }).length, 5);
  } finally { cleanup(); }
});

test("a commitment gap is a note on the one delivery, never a second message; a silent run is not reconciled", async () => {
  const { path, cleanup } = home();
  try {
    let reconciled = 0;
    const { deps, pushed, ledger } = harness(path, {
      reconcile: async () => { reconciled += 1; return "Commitments in this report that nothing is holding:\n- ship it by 2026-10-01: no task card"; },
    });
    const report = "Weekly retro.\n\n## Next week\n- ship it by 2026-10-01";
    const out = await finishRoutineRun(run(report), deps);
    assert.equal(pushed.length, 1, "one delivery");
    assert.equal(pushed[0], `${report}\n\nCommitments in this report that nothing is holding:\n- ship it by 2026-10-01: no task card`);
    assert.equal(out.delivered, pushed[0]);
    assert.match(ledger.lastFor("price-check")?.gapsNote ?? "", /no task card/);
    await finishRoutineRun(run(report), deps);
    assert.equal(reconciled, 1, "the identical run stayed silent and was not reconciled");
    assert.equal(pushed.length, 1);
  } finally { cleanup(); }
});

test("the model judge may soften a push but never re-opens a silence, and falls back to the rules when it cannot answer", async () => {
  const base = { slug: "s", deliver: "c", recentChat: ["person: how is BTC?"] };
  const asked: string[] = [];
  const say = (reply: string | undefined) => async (prompt: string) => { asked.push(prompt); return reply; };
  assert.equal((await resolveRoutineResult({ ...base, text: "BTC 60k" }, { mode: "model", ask: say('{"verdict":"attach_next","reason":"they asked already"}') })).verdict, "attach_next");
  assert.match(asked[0] ?? "", /person: how is BTC\?/, "the judge sees the chat");
  assert.equal((await resolveRoutineResult({ ...base, text: "", silent: { reason: "n/a" } }, { mode: "model", ask: say('{"verdict":"push_now","reason":"x"}') })).verdict, "silent");
  assert.equal(asked.length, 1, "a silence the rules found is not put to the model");
  const fallback = await resolveRoutineResult({ ...base, text: "BTC 60k" }, { mode: "model", ask: say("not json") });
  assert.equal(fallback.verdict, "push_now");
  assert.match(fallback.reason, /judge unavailable/);
  const thrown = await resolveRoutineResult({ ...base, text: "BTC 60k" }, { mode: "model", ask: async () => { throw new Error("down"); } });
  assert.equal(thrown.verdict, "push_now");
  assert.equal((await resolveRoutineResult({ ...base, text: "BTC 60k" }, { mode: "rules", ask: say('{"verdict":"silent","reason":"x"}') })).verdict, "push_now", "rules mode never asks");
  assert.equal(parseResolveVerdict('{"verdict":"maybe"}'), undefined);
  assert.deepEqual(parseResolveVerdict('Sure: {"verdict":"SILENT","reason":"same"}'), { verdict: "silent", reason: "same" });
});
