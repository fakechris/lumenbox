/** A pending approval blocks only the conversation whose turn is parked on it, and expires when nothing waits on it or after a day (INV-1622). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalsHolding, describeHolding, staleApprovals, type OpenTurns } from "./approval-wait.ts";
import type { PendingApproval } from "./policy.ts";
import type { InterruptedTurn } from "./resume.ts";

const T0 = Date.parse("2026-11-05T12:00:00Z");
const approval = (over: Partial<PendingApproval>): PendingApproval => ({
  id: "ap-1", fingerprint: "f1", agentId: "vic", agentName: "Vic", description: "bash — rm -rf .scratch", requestedAt: new Date(T0 - 60_000).toISOString(), ...over,
});
const turn = (over: Partial<InterruptedTurn>): InterruptedTurn => ({ id: "t1", agentId: "vic", at: new Date(T0).toISOString(), about: "x", attempt: 1, ...over }) as InterruptedTurn;
const ledger = (turns: InterruptedTurn[], steps: Record<string, string[]>): OpenTurns => ({
  turns: { interrupted: () => turns },
  steps: { stepsOf: id => ({ open: (steps[id] ?? []).map((approvalId, i) => ({ toolUseId: `u${i}`, name: "bash", at: new Date(T0).toISOString(), approvalId })) }) },
});

test("only an approval a turn in this conversation is parked on holds it; other conversations and ended turns do not", () => {
  const pending = [approval({}), approval({ id: "ap-2", fingerprint: "f2" }), approval({ id: "ap-ada", fingerprint: "f3", agentId: "ada", agentName: "Ada" })];
  const turns = ledger([turn({ conversation: "goal-7" }), turn({ id: "t2", agentId: "ada" })], { t1: ["ap-1"], t2: ["ap-ada"] });
  assert.deepEqual(approvalsHolding(turns, "vic", "goal-7", pending).map(a => a.id), ["ap-1"]);
  assert.deepEqual(approvalsHolding(turns, "vic", "main", pending), [], "another conversation of the same agent is free");
  assert.deepEqual(approvalsHolding(turns, "ada", "main", pending).map(a => a.id), ["ap-ada"], "the main conversation is the ledger's absent one");
  assert.deepEqual(approvalsHolding(undefined, "vic", "goal-7", pending), [], "no ledger, nothing is known to be held");
  assert.match(describeHolding(pending[0]!, T0), /^审批 ap-1 仍在等人（1 min 前：bash — rm -rf .scratch）/);
  assert.match(describeHolding(approval({ requestedAt: new Date(T0 - 3 * 86_400_000).toISOString() }), T0), /3 d 前/);
});

test("an approval nothing waits on expires with its reason; one still held does not; a day old expires whatever holds it; a harness-resumed one waits for its day", () => {
  const held = approval({});
  const orphan = approval({ id: "ap-2", fingerprint: "f2" });
  const old = approval({ id: "ap-3", fingerprint: "f3", requestedAt: new Date(T0 - 25 * 3_600_000).toISOString() });
  const harness = approval({ id: "ap-4", fingerprint: "f4", harnessResumes: true });
  const turns = ledger([turn({})], { t1: ["ap-1", "ap-3"] });
  const stale = staleApprovals(turns, [held, orphan, old, harness], T0);
  assert.deepEqual(stale.map(s => s.id), ["ap-2", "ap-3"]);
  assert.match(stale[0]!.reason, /turn that asked has ended/);
  assert.match(stale[1]!.reason, /waited 25 hours/);
  assert.deepEqual(staleApprovals(undefined, [held, orphan, old], T0).map(s => s.id), ["ap-3"], "without a ledger only age expires");
  assert.deepEqual(staleApprovals(turns, [orphan], T0, 7 * 86_400_000).map(s => s.id), ["ap-2"]);
});
