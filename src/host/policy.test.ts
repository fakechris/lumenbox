/**
 * Tests for the policy gate.
 *
 * Two of these matter more than the rest, because they are the claims that are worthless if
 * decorative: that an approval is bound to the exact action a person was shown, and that a pending
 * approval survives a restart. Both are failures other systems have shipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  describeRequest,
  fingerprintOf,
  MAX_APPROVABLE_DESCRIPTION,
  PolicyGate,
  type PolicyLimits,
  type PolicyRequest,
} from "./policy.ts";

function fixture(limits: Partial<PolicyLimits> = {}, spent = 0) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-policy-"));
  const path = join(dir, "policy.jsonl");
  const make = (extra: Partial<PolicyLimits> = {}) =>
    new PolicyGate({
      path,
      limits: {
        budgetWindowHours: 24,
        wakesPerWindow: 30,
        wakeWindowMinutes: 10,
        approvalRequiredTools: [],
        approvalRequiredCommands: [],
        ...limits,
        ...extra,
      },
      spentSince: () => spent,
    });
  return {
    path,
    gate: make(),
    /** A second gate over the same file: what a restart looks like. */
    restart: () => make(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const toolRequest = (command: string): PolicyRequest => ({
  kind: "tool",
  agentId: "agent-1",
  agentName: "Ada",
  tool: "bash",
  input: { command },
});

test("a stop refuses everything, not just the next model call", () => {
  const { gate, cleanup } = fixture();
  try {
    const modelCall: PolicyRequest = {
      kind: "model-call",
      agentId: "agent-1",
      agentName: "Ada",
      round: 3,
    };
    assert.equal(gate.check(modelCall).allow, true);

    gate.stop("agent-1");
    // All three kinds, because a person who pressed stop meant all of it. Refusing only the model
    // call would let the current round's tools run on.
    for (const request of [
      modelCall,
      toolRequest("echo hi"),
      {
        kind: "wake",
        agentId: "agent-1",
        agentName: "Ada",
        targetId: "agent-2",
        targetName: "Bob",
      } as PolicyRequest,
    ]) {
      const decision = gate.check(request);
      assert.equal(decision.allow, false, `${request.kind} must be refused`);
      assert.ok(
        !decision.allow && /stopped this turn/.test(decision.reason),
        "the reason is written for the model to act on"
      );
    }

    // Another agent is unaffected: a stop is per agent, not per box.
    assert.equal(
      gate.check({ kind: "model-call", agentId: "agent-2", agentName: "Bob", round: 0 }).allow,
      true
    );

    // A stop is cleared when the next turn starts, or the person's next instruction would be
    // refused too — which reads as the agent having broken rather than having been stopped.
    gate.resume("agent-1");
    assert.equal(gate.check(modelCall).allow, true);
    assert.equal(gate.isStopped("agent-1"), false);
  } finally {
    cleanup();
  }
});

test("a stop survives a restart", () => {
  const { gate, restart, cleanup } = fixture();
  try {
    gate.stop("agent-1", "alice");
    const after = restart();
    assert.equal(after.isStopped("agent-1"), true, "the stop is in the log, not in memory");
    after.resume("agent-1");
    assert.equal(restart().isStopped("agent-1"), false, "and so is the resume");
  } finally {
    cleanup();
  }
});

test("spend is refused at the budget, with a reason that says what happened", () => {
  const under = fixture({ budgetTokens: 1_000 }, 999);
  try {
    assert.equal(
      under.gate.check({ kind: "model-call", agentId: "a", agentName: "Ada", round: 0 }).allow,
      true
    );
  } finally {
    under.cleanup();
  }

  const over = fixture({ budgetTokens: 1_000 }, 1_000);
  try {
    const decision = over.gate.check({
      kind: "model-call",
      agentId: "a",
      agentName: "Ada",
      round: 0,
    });
    assert.equal(decision.allow, false, "at the budget is over it, not under");
    assert.ok(!decision.allow && /1000 budget/.test(decision.reason));
    assert.ok(!decision.allow && /Stop here/.test(decision.reason), "it tells the agent what to do");

    // Tools are not refused by a spend limit: a turn that has already paid for its round should be
    // allowed to finish the work it started rather than abandoning it half-done.
    assert.equal(over.gate.check(toolRequest("echo hi")).allow, true);
  } finally {
    over.cleanup();
  }
});

test("no budget means no ceiling, stated rather than defaulted", () => {
  const { gate, cleanup } = fixture({ budgetTokens: undefined }, 999_999_999);
  try {
    assert.equal(
      gate.check({ kind: "model-call", agentId: "a", agentName: "Ada", round: 0 }).allow,
      true
    );
    assert.equal(DEFAULT_LIMITS.budgetTokens, undefined, "and that is the default");
  } finally {
    cleanup();
  }
});

test("wakes are rate limited, which is what stops two agents looping", () => {
  const { gate, cleanup } = fixture({ wakesPerWindow: 3, wakeWindowMinutes: 10 });
  try {
    const wake: PolicyRequest = {
      kind: "wake",
      agentId: "agent-1",
      agentName: "Ada",
      targetId: "agent-2",
      targetName: "Bob",
    };
    for (let at = 0; at < 3; at++) {
      assert.equal(gate.check(wake).allow, true, `wake ${at} is within the limit`);
    }
    const refused = gate.check(wake);
    assert.equal(refused.allow, false);
    assert.ok(!refused.allow && /loop that/.test(refused.reason), "the reason names the failure");

    // Per agent: Bob replying to Ada is not Ada's quota.
    assert.equal(
      gate.check({ ...wake, agentId: "agent-2", agentName: "Bob", targetId: "agent-1" }).allow,
      true
    );
  } finally {
    cleanup();
  }
});

test("an approval is bound to the exact action a person was shown", () => {
  const { gate, cleanup } = fixture({ approvalRequiredCommands: ["rm "] });
  try {
    const harmless = toolRequest("rm README.md");
    const first = gate.check(harmless);
    assert.equal(first.allow, false, "a matching command waits for a person");
    assert.ok(!first.allow && first.approval, "and an approval is created");
    const approvalId = (!first.allow && first.approval?.id) as string;

    // A person sees the description and approves it.
    assert.deepEqual(
      gate.pending().map(entry => entry.description),
      ["Ada: bash — rm README.md"]
    );
    assert.equal(gate.grant(approvalId, "alice"), true);

    // The escalation this prevents: same tool, same agent, worse command, under the same grant.
    const escalated = gate.check(toolRequest("rm -rf /home/box/work"));
    assert.equal(escalated.allow, false, "a grant does not cover a different command");

    // The action that was actually approved runs.
    assert.equal(gate.check(harmless).allow, true);

    // And once, not twice. A grant is consumed, so a replay of the same call is refused again.
    assert.equal(gate.check(harmless).allow, false, "a grant is one-time");
  } finally {
    cleanup();
  }
});

test("the fingerprint covers the text a person reads, and the agent it was for", () => {
  // If the shown text and the hashed text could differ, the binding would be decorative — someone
  // could be shown one command and consent to another.
  const description = describeRequest(toolRequest("rm README.md"));
  assert.equal(description, "Ada: bash — rm README.md");
  assert.equal(fingerprintOf("agent-1", description), fingerprintOf("agent-1", description));
  assert.notEqual(
    fingerprintOf("agent-1", description),
    fingerprintOf("agent-2", description),
    "one agent's grant is not another's"
  );
  assert.notEqual(
    fingerprintOf("agent-1", description),
    fingerprintOf("agent-1", `${description} --force`)
  );
});

test("a pending approval survives a restart", () => {
  const { gate, restart, cleanup } = fixture({ approvalRequiredTools: ["bash"] });
  try {
    const decision = gate.check(toolRequest("deploy"));
    assert.equal(decision.allow, false);
    const id = (!decision.allow && decision.approval?.id) as string;

    // The failure this exists for: an approval registry kept only in memory means a person who
    // clicked "allow" has no way to know their decision was lost, and the agent stalls forever.
    const afterRestart = restart();
    assert.deepEqual(
      afterRestart.pending().map(entry => entry.id),
      [id],
      "still waiting after a restart"
    );

    assert.equal(afterRestart.grant(id), true);
    // And the grant itself survives a second restart, unused.
    assert.equal(restart().check(toolRequest("deploy")).allow, true);
  } finally {
    cleanup();
  }
});

test("granting an unknown or answered id is false, not an error", () => {
  const { gate, cleanup } = fixture({ approvalRequiredTools: ["bash"] });
  try {
    assert.equal(gate.grant("no-such-id"), false, "a stale page is not an error");
    const decision = gate.check(toolRequest("deploy"));
    const id = (!decision.allow && decision.approval?.id) as string;
    assert.equal(gate.grant(id), true);
    assert.equal(gate.grant(id), false, "a second click is not an error either");

    const second = gate.check(toolRequest("other"));
    const otherId = (!second.allow && second.approval?.id) as string;
    assert.equal(gate.deny(otherId, "alice", "not now"), true);
    assert.equal(gate.check(toolRequest("other")).allow, false, "denied stays denied");
  } finally {
    cleanup();
  }
});

test("asking twice while waiting does not queue two approvals", () => {
  const { gate, cleanup } = fixture({ approvalRequiredTools: ["bash"] });
  try {
    const first = gate.check(toolRequest("deploy"));
    const second = gate.check(toolRequest("deploy"));
    assert.equal(gate.pending().length, 1, "an agent that retries does not spam the person");
    assert.equal(
      (!first.allow && first.approval?.id) as string,
      (!second.allow && second.approval?.id) as string
    );
  } finally {
    cleanup();
  }
});

test("every decision is recorded before the caller can act on it", () => {
  const { gate, path, cleanup } = fixture({ approvalRequiredCommands: ["rm "] });
  try {
    gate.check({ kind: "model-call", agentId: "agent-1", agentName: "Ada", round: 0 });
    gate.check(toolRequest("rm x"));
    gate.stop("agent-1");
    gate.check(toolRequest("echo hi"));

    const events = readFileSync(path, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "")
      .map(line => JSON.parse(line) as { kind: string; allowed?: boolean });

    // "Who tried" is asked after an incident as often as "who did", and a log written on success
    // cannot answer the first. So a refusal is recorded too.
    assert.deepEqual(
      events.map(event => event.kind),
      ["checked", "checked", "approval-requested", "stop", "checked"]
    );
    assert.equal(events[0]!.allowed, true);
    assert.equal(events[1]!.allowed, false, "the refused tool call is on the record");
    assert.equal(events[4]!.allowed, false, "and so is the one refused by the stop");
  } finally {
    cleanup();
  }
});

test("a tool nobody asked to gate is not gated", () => {
  const { gate, cleanup } = fixture();
  try {
    // Empty by default on purpose: requiring approval for `bash` would ask about every command,
    // which trains a person to click through. The mechanism exists before the policy does.
    assert.deepEqual(DEFAULT_LIMITS.approvalRequiredTools, []);
    assert.equal(gate.check(toolRequest("rm -rf /")).allow, true);
    assert.equal(gate.pending().length, 0);
  } finally {
    cleanup();
  }
});

test("an action too large to show is refused, not shortened", () => {
  const { gate, cleanup } = fixture({ approvalRequiredTools: ["bash"] });
  try {
    // The hole this closes: the first version truncated the description at 400 characters and took
    // the fingerprint over the truncated text, so two commands sharing their first 400 characters
    // and differing after would pass under one grant. Consent is given to what the person read.
    const long = `echo ${"x".repeat(MAX_APPROVABLE_DESCRIPTION)}`;
    const decision = gate.check(toolRequest(long));
    assert.equal(decision.allow, false);
    assert.ok(!decision.allow && /refused rather than shortened/.test(decision.reason));
    // And crucially it does not become a pending approval, because there is nothing showable to
    // approve.
    assert.equal(gate.pending().length, 0);

    // Two commands that share a long prefix are still distinguished, now that nothing is cut.
    const prefix = "rm ".padEnd(500, "a");
    const first = gate.check(toolRequest(`${prefix}/one`));
    const id = (!first.allow && first.approval?.id) as string;
    assert.ok(id, "a showable action is still approvable at 500 characters");
    assert.equal(gate.grant(id), true);
    assert.equal(gate.check(toolRequest(`${prefix}/two`)).allow, false, "a different tail is a different action");
    assert.equal(gate.check(toolRequest(`${prefix}/one`)).allow, true);
  } finally {
    cleanup();
  }
});


test("the budget window rolls, rather than being decorative text", () => {
  // `budgetWindowHours` used to appear in the refusal message and nowhere else: spend was summed
  // over everything the usage file still held. A box that exhausted a "24-hour" budget on Monday
  // stayed refused on Tuesday, until enough unrelated records happened to push the old ones out of
  // the file.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-policy-"));
  try {
    let clock = new Date("2026-08-20T12:00:00Z");
    // Monday's 5,000 tokens, and nothing since.
    const spentAt = Date.parse("2026-08-20T09:00:00Z");
    const gate = new PolicyGate({
      path: join(dir, "policy.jsonl"),
      limits: {
        budgetTokens: 1_000,
        budgetWindowHours: 24,
        wakesPerWindow: 30,
        wakeWindowMinutes: 10,
        approvalRequiredTools: [],
        approvalRequiredCommands: [],
      },
      now: () => clock,
      spentSince: sinceMs => (sinceMs <= spentAt ? 5_000 : 0),
    });

    const call: PolicyRequest = { kind: "model-call", agentId: "a", agentName: "Ada", round: 0 };
    const refused = gate.check(call);
    assert.equal(refused.allow, false);
    assert.ok(!refused.allow && /in the last 24h/.test(refused.reason));

    // A day later that spend is outside the window, so the same box may spend again — without
    // anything having been reset by hand and without the usage file having been truncated.
    clock = new Date("2026-08-21T12:00:00Z");
    assert.equal(gate.check(call).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
