/**
 * INV-862: fan-out by plan. Real ledger, real policy gate; the sub-agent turns are a fake that
 * answers with a handoff line, so every count here is exact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemBrief, Orchestrations, parsePlan, planCalls, type OrchestrationPlan } from "./orchestrate.ts";
import { PendingWork } from "./pending-work.ts";
import { PolicyGate } from "./policy.ts";
import { dispatchTool, readHandoff } from "./tools.ts";

type RunChild = (agentId: string, conversation: string, brief: string) => Promise<string>;

function harness(confirmAt = 20) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-orchestrate-"));
  const policy = new PolicyGate({
    path: join(dir, "policy.jsonl"),
    limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] },
    spentSince: () => 0,
  });
  const delivered: { agentId: string; text: string; conversation: string }[] = [];
  const make = (runChild: RunChild, concurrency = 4) =>
    new Orchestrations({
      pendingWork: new PendingWork(join(dir, "pending-work.jsonl")),
      policy,
      runChild,
      readHandoff,
      deliver: (agentId, text, conversation) => { delivered.push({ agentId, text, conversation }); return true; },
      resultsDir: join(dir, "orchestrations"),
      confirmAt,
      concurrency,
    });
  return { dir, policy, delivered, make, ledger: () => new PendingWork(join(dir, "pending-work.jsonl")), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A sub-agent that answers with the item it was given, and counts calls. */
function answering() {
  const briefs: string[] = [];
  const conversations: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const runChild: RunChild = async (_agentId, conversation, brief) => {
    briefs.push(brief);
    conversations.push(conversation);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight -= 1;
    const item = /Item (\d+) of/.exec(brief)?.[1] ?? "summary";
    return `answer for ${item}\nHANDOFF: {"status":"done","reason":"ok"}`;
  };
  return { runChild, briefs, conversations, peak: () => peak };
}

function plan(items: number, reduce = false): OrchestrationPlan {
  const parsed = parsePlan({
    brief: "Survey the vendors",
    items: Array.from({ length: items }, (_, index) => `vendor-${index + 1}`),
    prompt: "Read the page of {{item}} and give its price.",
    expect: "the price and the source URL",
    ...(reduce ? { reduce: "Rank them by price:\n{{results}}" } : {}),
  });
  if ("problem" in parsed) throw new Error(parsed.problem);
  return parsed.plan;
}

const who = { agentId: "ada", agentName: "Ada", parent: "main" };

test("a plan is data: missing pieces are refused with the reason", () => {
  assert.match((parsePlan({ items: ["a"], prompt: "{{item}}" }) as { problem: string }).problem, /needs a brief/);
  assert.match((parsePlan({ brief: "b", items: [], prompt: "{{item}}" }) as { problem: string }).problem, /at least one item/);
  assert.match((parsePlan({ brief: "b", items: ["a"], prompt: "no placeholder" }) as { problem: string }).problem, /\{\{item\}\}/);
  assert.match((parsePlan({ brief: "b", items: ["a"], prompt: "{{item}}", reduce: "sum it" }) as { problem: string }).problem, /\{\{results\}\}/);
  assert.match((parsePlan({ brief: "b", items: ["a", "b", "c"], prompt: "{{item}}" }, 2) as { problem: string }).problem, /more than the 2/);
  const brief = itemBrief(plan(3), 1);
  assert.match(brief, /Item 2 of 3 in "Survey the vendors"/);
  assert.match(brief, /Read the page of vendor-2 and give its price\./);
  assert.match(brief, /must contain: the price and the source URL/);
  assert.equal(planCalls(plan(3, true)), 4);
});

test("a small plan starts at once, stays within its concurrency, and reports once", async () => {
  const h = harness();
  try {
    const child = answering();
    const orchestrations = h.make(child.runChild, 2);
    const submitted = orchestrations.submit({ ...who, plan: plan(5) });
    assert.equal(submitted.approval, undefined);
    assert.match(submitted.text, /Started 5 sub-agent turn/);
    await orchestrations.idle();
    assert.equal(child.briefs.length, 5);
    assert.ok(child.peak() <= 2, `peak ${child.peak()} over the limit`);
    assert.ok(child.conversations.every(name => name.startsWith("fork/main-plan-")), "items run as forks");
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.text, /The plan "Survey the vendors" finished: 5 item\(s\)/);
    assert.match(h.delivered[0]!.text, /--- item 3: vendor-3 \(done\) ---\nanswer for 3/);
    assert.equal(h.ledger().open().length, 0);
  } finally { h.cleanup(); }
});

test("with a reduce brief the reducer sees every answer and its summary is what arrives", async () => {
  const h = harness();
  try {
    const child = answering();
    const orchestrations = h.make(child.runChild);
    orchestrations.submit({ ...who, plan: plan(3, true) });
    await orchestrations.idle();
    assert.equal(child.briefs.length, 4);
    const reducer = child.briefs[3]!;
    assert.match(reducer, /Rank them by price:/);
    for (const n of [1, 2, 3]) assert.match(reducer, new RegExp(`item ${n}: vendor-${n} \\(done\\) ---\\nanswer for ${n}`));
    assert.match(h.delivered[0]!.text, /The summary:\]\n\nanswer for summary/);
  } finally { h.cleanup(); }
});

test("past the threshold nothing runs until the person confirms; a second submit does not ask twice", async () => {
  const h = harness();
  try {
    const child = answering();
    const orchestrations = h.make(child.runChild);
    const submitted = orchestrations.submit({ ...who, plan: plan(25) });
    assert.ok(submitted.approval);
    assert.match(submitted.text, /asked to confirm/);
    assert.equal(h.policy.pending().length, 1);
    assert.match(h.policy.pending()[0]!.description, /Run 25 sub-agent turns for "Survey the vendors"/);
    assert.equal(child.briefs.length, 0);

    assert.match(orchestrations.submit({ ...who, plan: plan(25) }).text, /already waiting for the person/);
    assert.equal(h.policy.pending().length, 1);

    h.policy.grant(submitted.approval!.id);
    assert.equal(orchestrations.settleApproval(submitted.approval!.id, "allowed"), true);
    await orchestrations.idle();
    assert.equal(child.briefs.length, 25);
    assert.equal(h.delivered.length, 1);
  } finally { h.cleanup(); }
});

test("a declined plan runs nothing and says so", async () => {
  const h = harness();
  try {
    const child = answering();
    const orchestrations = h.make(child.runChild);
    const { approval } = orchestrations.submit({ ...who, plan: plan(30) });
    h.policy.deny(approval!.id);
    orchestrations.settleApproval(approval!.id, "refused");
    await orchestrations.idle();
    assert.equal(child.briefs.length, 0);
    assert.match(h.delivered[0]!.text, /declined the plan "Survey the vendors"; nothing ran/);
    assert.equal(h.ledger().open().length, 0);
  } finally { h.cleanup(); }
});

test("30 items and a summary with a restart in the middle cost exactly 31 sub-agent turns", async () => {
  const h = harness(100);
  try {
    // The first process answers twelve items, then dies with its four workers mid-turn.
    let firstCalls = 0;
    const dying: RunChild = async (_agentId, _conversation, brief) => {
      firstCalls += 1;
      const item = Number(/Item (\d+) of/.exec(brief)?.[1]);
      if (item > 12) return new Promise<string>(() => {});
      return `answer for ${item}\nHANDOFF: {"status":"done","reason":"ok"}`;
    };
    h.make(dying).submit({ ...who, plan: plan(30, true) });
    await new Promise(resolve => setTimeout(resolve, 50));
    const answeredBeforeCrash = firstCalls - 4; // the four in flight never answered

    const child = answering();
    const afterRestart = h.make(child.runChild);
    assert.deepEqual(afterRestart.recover(), { resumed: 1, closed: 0 });
    await afterRestart.idle();

    assert.equal(answeredBeforeCrash, 12);
    assert.equal(child.briefs.length, 30 - 12 + 1, "only the unanswered items and the summary ran again");
    assert.equal(answeredBeforeCrash + child.briefs.length, 31);
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.text, /finished: 30 item\(s\)/);
    for (const n of [1, 12, 13, 30]) assert.match(child.briefs[child.briefs.length - 1]!, new RegExp(`item ${n}: vendor-${n} \\(done\\)`));
  } finally { h.cleanup(); }
});

test("re-submitting a finished plan reuses its answers instead of running them again", async () => {
  const h = harness();
  try {
    const child = answering();
    const orchestrations = h.make(child.runChild);
    orchestrations.submit({ ...who, plan: plan(4) });
    await orchestrations.idle();
    assert.match(orchestrations.submit({ ...who, plan: plan(4) }).text, /4 item\(s\) answered by an earlier run of this plan are reused/);
    await orchestrations.idle();
    assert.equal(child.briefs.length, 4);
    assert.equal(h.delivered.length, 2);
  } finally { h.cleanup(); }
});

test("a plan whose confirmation is gone after a restart is reported and closed; one still waiting stays", async () => {
  const h = harness();
  try {
    const child = answering();
    const { approval } = h.make(child.runChild).submit({ ...who, plan: plan(25) });
    assert.deepEqual(h.make(child.runChild).recover(), { resumed: 0, closed: 0 });
    h.policy.deny(approval!.id);
    assert.deepEqual(h.make(child.runChild).recover(), { resumed: 0, closed: 1 });
    assert.match(h.delivered[0]!.text, /waiting for a confirmation that is gone after a restart/);
    assert.equal(child.briefs.length, 0);
  } finally { h.cleanup(); }
});

test("a fork cannot submit a plan, and Orchestrate is withheld from forks", async () => {
  const { FORK_WITHHELD_TOOLS } = await import("./tools.ts");
  assert.ok(FORK_WITHHELD_TOOLS.has("Orchestrate"));
  let submitted = 0;
  const outcome = await dispatchTool(
    "Orchestrate",
    { brief: "b", items: ["a"], prompt: "{{item}}" },
    {
      agent: { id: "ada", profile: { name: "Ada" } },
      conversation: "fork/main-x-1",
      orchestrations: { submit: () => { submitted += 1; return { text: "" }; } },
    } as unknown as Parameters<typeof dispatchTool>[2]
  );
  assert.equal(outcome.isError, true);
  assert.equal(submitted, 0);
});
