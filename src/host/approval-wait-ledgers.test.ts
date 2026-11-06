/**
 * The 2026-11-05 shape on the real ledgers (INV-1622): an approval from yesterday whose turn
 * ended does not block a new goal for the agent and expires on the sweep; one a turn in this
 * conversation is parked on blocks, by name, and is left alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsHolding, describeHolding, openTurnsOf, staleApprovals } from "./approval-wait.ts";
import { PolicyGate } from "./policy.ts";
import { StepLedger, TurnLedger } from "./resume.ts";

test("an old approval whose turn ended neither blocks the agent nor survives the sweep; the parked one blocks and stays", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-approval-wait-"));
  try {
    const yesterday = new Date("2026-11-04T02:36:16Z");
    const today = new Date("2026-11-05T12:22:42Z");
    let now = yesterday;
    const gate = new PolicyGate({ path: join(root, "policy.jsonl"), now: () => now, limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: ["bash"], approvalRequiredCommands: [] }, spentSince: () => 0 });
    const turns = new TurnLedger(join(root, "turns.jsonl"));
    const steps = new StepLedger(join(root, "steps.jsonl"));
    const open = openTurnsOf(turns, steps)!;

    // Yesterday: Vic's turn in its main conversation asked, the person never answered, the turn was handed back.
    const vicTurn = turns.begin({ agentId: "vic", about: "clean .scratch", id: "turn-vic-1", now: yesterday });
    const asked = gate.check({ kind: "tool", agentId: "vic", agentName: "Vic", tool: "bash", input: { command: "find . -name '.scratch*' | xargs rm" } });
    const vicApproval = (!asked.allow && asked.approval?.id) as string;
    steps.pending(vicTurn, "use-1", "bash", yesterday); steps.awaitingApproval(vicTurn, "use-1", vicApproval, yesterday);
    turns.end(vicTurn, "handed back", yesterday);

    // Today: Ada's turn in a goal conversation is parked on its own approval right now.
    now = today;
    const adaTurn = turns.begin({ agentId: "ada", about: "ship", id: "turn-ada-1", conversation: "goal-9", now: today });
    const adaAsked = gate.check({ kind: "tool", agentId: "ada", agentName: "Ada", tool: "bash", input: { command: "cp report.md outbox/" } });
    const adaApproval = (!adaAsked.allow && adaAsked.approval?.id) as string;
    steps.pending(adaTurn, "use-2", "bash", today); steps.awaitingApproval(adaTurn, "use-2", adaApproval, today);

    assert.equal(gate.pending().length, 2);
    // Starting a goal for Vic, in any conversation, is not blocked by yesterday's approval.
    assert.deepEqual(approvalsHolding(open, "vic", "main", gate.pending()), []);
    assert.deepEqual(approvalsHolding(open, "vic", "goal-10", gate.pending()), []);
    // Ada's goal conversation is held, and the blocker names the approval.
    const held = approvalsHolding(open, "ada", "goal-9", gate.pending());
    assert.deepEqual(held.map(a => a.id), [adaApproval]);
    assert.match(describeHolding(held[0]!, today.getTime()), new RegExp(`^审批 ${adaApproval.slice(0, 8)} 仍在等人（0 min 前：Ada: bash — cp report.md outbox/）`));
    assert.deepEqual(approvalsHolding(open, "ada", "main", gate.pending()), [], "Ada's other conversations are free");

    // The sweep: Vic's expires (turn ended, and a day old); Ada's is left alone.
    const stale = staleApprovals(open, gate.pending(), today.getTime());
    assert.deepEqual(stale.map(s => s.id), [vicApproval]);
    for (const s of stale) assert.equal(gate.deny(s.id, "host", s.reason, "approval-expired"), true);
    assert.deepEqual(gate.pending().map(a => a.id), [adaApproval]);
    assert.equal(gate.grant(vicApproval), false, "a late click on yesterday's card runs nothing");
    // After a restart the expired one is still gone and the parked one still pending.
    const again = new PolicyGate({ path: join(root, "policy.jsonl"), now: () => now, limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: ["bash"], approvalRequiredCommands: [] }, spentSince: () => 0 });
    assert.deepEqual(again.pending().map(a => a.id), [adaApproval]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
