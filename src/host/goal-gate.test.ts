import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import { MAX_VERIFY_REJECTIONS, VERIFIER_TOOLS, newPursuit, parseGoalVerdict, type ChecklistItem, type GoalMarker } from "./goal-mode.ts";
import { GoalGate, commandIsConfirmed, manifestHashOf, verifierConversation, type GoalGateDeps } from "./goal-gate.ts";

const CHECKLIST: ChecklistItem[] = [
  { id: "c1", text: "report exists", check: { kind: "artifact", path: "/home/box/work/q3.md" } },
  { id: "c2", text: "lint passes", check: { kind: "command", command: "npm run lint", expectExit: 0 }, confirmed: true },
  { id: "c3", text: "tests pass", check: { kind: "command", command: "npm test", expectExit: 0 } },
  { id: "c4", text: "reads well" },
];

const REPORT_PASS = "Status: complete\nIntegrity: clean\nContract audit: aligned\nItem c1: proven — q3.md, 2.1 KB\nItem c2: proven — exit 0\nItem c3: proven — judged from lint output\nItem c4: proven — read it\nNext action: none\n\nAll four hold.";
const REPORT_FAIL = "Status: incomplete\nIntegrity: clean\nContract audit: aligned\nItem c1: proven — q3.md exists\nItem c2: contradicted — exit 1: 3 errors\nItem c3: unverified\nItem c4: incomplete — section 3 is a stub\nNext action: fix the three lint errors and finish section 3";

function harness(over: Partial<GoalGateDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-goal-gate-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  let manifest = new Map<string, string>([["/home/box/work/q3.md", "aaa"]]);
  let todos: { status: string; text: string }[] = [];
  let transcript: unknown[] = [];
  const wakes: { agentId: string; text: string; conversation?: string; toolScope?: readonly string[]; goal?: GoalMarker }[] = [];
  const told: string[] = [];
  const deps: GoalGateDeps = {
    tasks,
    registry: { readDurableState: () => ({ todos }) as never, readTranscript: () => transcript },
    bus: { sendFromUser: (agentId, text, options) => { wakes.push({ agentId, text, ...(options.conversation !== undefined ? { conversation: options.conversation } : {}), ...(options.toolScope !== undefined ? { toolScope: options.toolScope } : {}), ...(options.goal !== undefined ? { goal: options.goal } : {}) }); return 1; }, wake: async () => {} },
    manifest: async () => manifest,
    notify: async (_task, text) => { told.push(text); },
    log: () => {},
    ...over,
  };
  const gate = new GoalGate(deps);
  const task = tasks.create({ title: "quarterly", requester: "principal-user", assigneeId: "nova", conversation: "feishu-private", pursuit: { ...newPursuit({ objective: "quarterly report", workId: "w-1", chatKey: "feishu:private" }), checklist: CHECKLIST } })!;
  return {
    tasks, gate, wakes, told, task,
    pursuit: () => tasks.get(task.id)!.pursuit!,
    setManifest: (next: Map<string, string>) => { manifest = next; },
    setTodos: (next: { status: string; text: string }[]) => { todos = next; },
    setTranscript: (next: unknown[]) => { transcript = next; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const EVIDENCE = [{ id: "c1", evidence: "/home/box/work/q3.md" }, { id: "c2", evidence: "ran it, exit 0" }, { id: "c4", evidence: "read it twice" }];

test("the verdict parser: headers, one line per item, the next action; anything less is no verdict", () => {
  const pass = parseGoalVerdict(REPORT_PASS, CHECKLIST)!;
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.items.map(item => [item.id, item.verdict]), [["c1", "proven"], ["c2", "proven"], ["c3", "proven"], ["c4", "proven"]]);
  assert.equal(pass.items[0]!.evidence, "q3.md, 2.1 KB");
  assert.equal(pass.nextAction, undefined, "'none' is no action");
  const fail = parseGoalVerdict(REPORT_FAIL, CHECKLIST)!;
  assert.equal(fail.passed, false);
  assert.deepEqual(fail.items.map(item => item.verdict), ["proven", "contradicted", "unverified", "incomplete"]);
  assert.equal(fail.nextAction, "fix the three lint errors and finish section 3");
  assert.equal(parseGoalVerdict("Status: complete\nItem c1: proven", CHECKLIST), undefined, "no integrity header");
  assert.equal(parseGoalVerdict("Status: complete\nIntegrity: clean\nContract audit: aligned\nItem c1: proven", CHECKLIST)!.passed, false, "a missing item line is unverified, and unverified is not complete");
  assert.equal(parseGoalVerdict("I think it's done!", CHECKLIST), undefined);
  assert.equal(commandIsConfirmed({ verify: { attempt: 1, confirmedCommands: ["npm run lint"] } }, " npm run lint "), true);
  assert.equal(commandIsConfirmed({ verify: { attempt: 1, confirmedCommands: ["npm run lint"] } }, "npm run lint && rm -rf /"), false);
  assert.equal(commandIsConfirmed(undefined, "anything"), true, "not a verification: bash is the policy gate's business");
});

test("a claim is refused for the wrong agent, over open todos, and rejected outright over a missing artifact", async () => {
  const h = harness();
  try {
    assert.match((await h.gate.claim(h.task.id, "someone-else", EVIDENCE)).text, /nova's to claim/);
    h.setTodos([{ status: "doing", text: "write section 3" }]);
    const overTodos = await h.gate.claim(h.task.id, "nova", EVIDENCE);
    assert.equal(overTodos.accepted, false);
    assert.match(overTodos.text, /1 todo\(s\) are still doing \(write section 3\)/);
    assert.equal(h.pursuit().status, "active");
    assert.equal(h.pursuit().spent.rejections, 0, "a refusal is not a rejection");
    h.setTodos([]);
    h.setManifest(new Map());
    const missing = await h.gate.claim(h.task.id, "nova", EVIDENCE);
    assert.equal(missing.accepted, false);
    assert.match(missing.text, /Produce the missing artifact\(s\): \/home\/box\/work\/q3\.md/);
    assert.equal(h.pursuit().status, "active");
    assert.equal(h.pursuit().spent.rejections, 1, "the host's check counts as a rejection");
    assert.equal(h.pursuit().checklist[0]!.verdict, "contradicted");
    assert.equal(h.pursuit().lastVerdict?.passed, false);
    assert.equal(h.wakes.length, 0, "no verifier was started");
  } finally { h.cleanup(); }
});

test("an accepted claim becomes verifying and starts a verifier with read tools and only the confirmed commands", async () => {
  const h = harness();
  try {
    const result = await h.gate.claim(h.task.id, "nova", EVIDENCE);
    assert.equal(result.accepted, true);
    const pursuit = h.pursuit();
    assert.equal(pursuit.status, "verifying");
    assert.equal(h.tasks.get(h.task.id)!.status, "doing");
    assert.deepEqual({ conversation: pursuit.verifying?.conversation, attempt: pursuit.verifying?.attempt, hash: pursuit.verifying?.manifestHash }, { conversation: verifierConversation(h.task.id, 1), attempt: 1, hash: manifestHashOf(new Map([["/home/box/work/q3.md", "aaa"]])) });
    assert.deepEqual(pursuit.claim?.items.map(item => [item.id, item.evidence]), [["c1", "/home/box/work/q3.md"], ["c2", "ran it, exit 0"], ["c3", ""], ["c4", "read it twice"]]);
    assert.equal(h.wakes.length, 1);
    const wake = h.wakes[0]!;
    assert.equal(wake.conversation, verifierConversation(h.task.id, 1), "a conversation with no history of the work");
    assert.deepEqual(wake.toolScope, VERIFIER_TOOLS);
    assert.deepEqual(wake.goal?.verify, { attempt: 1, confirmedCommands: ["npm run lint"] }, "npm test was proposed, never confirmed");
    assert.match(wake.text, /c2: lint passes\n {3}check: run exactly: npm run lint — proven when it exits 0/);
    assert.match(wake.text, /c3: tests pass\n {3}check: a command was proposed but the person did not confirm it/);
    assert.match(wake.text, /executor's pointer: read it twice/);
    assert.doesNotMatch(wake.text, /ReadHistory/, "the verifier is not sent to the executor's account");
    assert.match((await h.gate.claim(h.task.id, "nova", EVIDENCE)).text, /already being verified/);
  } finally { h.cleanup(); }
});

test("a passing verdict moves the goal to review for the person; the checklist carries the verdicts", async () => {
  const h = harness();
  try {
    await h.gate.claim(h.task.id, "nova", EVIDENCE);
    await h.gate.verifierEnded({ marker: h.wakes[0]!.goal!, how: "done", worked: true, finalText: REPORT_PASS });
    const pursuit = h.pursuit();
    assert.equal(pursuit.status, "complete");
    assert.equal(pursuit.verifying, undefined);
    assert.equal(h.tasks.get(h.task.id)!.status, "review");
    assert.deepEqual(pursuit.checklist.map(item => item.verdict), ["proven", "proven", "proven", "proven"]);
    assert.equal(pursuit.lastVerdict?.passed, true);
    assert.match(h.told[0] ?? "", /目标 t1 验证通过[\s\S]*等你验收/);
    // The person's word is done; the assignee's is not.
    assert.equal(h.tasks.update(h.task.id, { status: "done" }, "nova")?.task.status, "review");
    assert.equal(h.tasks.update(h.task.id, { status: "done" }, "principal-user")?.task.status, "done");
  } finally { h.cleanup(); }
});

test("a rejection returns the goal to active with the next action; the third in a row goes to the person", async () => {
  const h = harness();
  try {
    for (let n = 1; n <= MAX_VERIFY_REJECTIONS; n++) {
      const claim = await h.gate.claim(h.task.id, "nova", EVIDENCE);
      assert.equal(claim.accepted, true, `claim ${n}`);
      await h.gate.verifierEnded({ marker: h.wakes.at(-1)!.goal!, how: "done", worked: true, finalText: REPORT_FAIL });
      const pursuit = h.pursuit();
      assert.equal(pursuit.spent.rejections, n);
      assert.equal(pursuit.lastVerdict?.nextAction, "fix the three lint errors and finish section 3");
      assert.deepEqual(pursuit.checklist.map(item => item.verdict), ["proven", "contradicted", "unverified", "incomplete"]);
      if (n < MAX_VERIFY_REJECTIONS) {
        assert.equal(pursuit.status, "active", "back to the loop, with the next action");
        assert.match(h.told.at(-1) ?? "", /没有通过验证；它会继续推进，下一步：fix the three lint errors/);
      }
    }
    assert.equal(h.pursuit().status, "paused");
    assert.equal(h.pursuit().pausedReason, "needs_person");
    assert.equal(h.tasks.get(h.task.id)!.status, "blocked");
    assert.match(h.told.at(-1) ?? "", /验证连续 3 次没通过，需要你来判断[\s\S]*c2 contradicted、c3 unverified、c4 incomplete/);
  } finally { h.cleanup(); }
});

test("no verdict is never a pass: a verifier that fails or rambles is run once more, then the person decides", async () => {
  const h = harness();
  try {
    await h.gate.claim(h.task.id, "nova", EVIDENCE);
    await h.gate.verifierEnded({ marker: h.wakes[0]!.goal!, how: "failed", worked: false });
    assert.equal(h.pursuit().status, "verifying");
    assert.equal(h.pursuit().verifying?.attempt, 2);
    assert.equal(h.wakes.length, 2, "tried once more");
    assert.equal(h.wakes[1]!.goal?.verify?.attempt, 2);
    // A stale report from attempt 1 arriving now is ignored.
    await h.gate.verifierEnded({ marker: h.wakes[0]!.goal!, how: "done", worked: true, finalText: REPORT_PASS });
    assert.equal(h.pursuit().status, "verifying", "attempt 1's late words do not settle attempt 2");
    await h.gate.verifierEnded({ marker: h.wakes[1]!.goal!, how: "done", worked: true, finalText: "Looks fine to me, all good!" });
    assert.equal(h.pursuit().status, "paused");
    assert.equal(h.pursuit().pausedReason, "needs_person");
    assert.equal(h.pursuit().lastVerdict?.passed, false);
    assert.match(h.told.at(-1) ?? "", /需要你来判断/);
  } finally { h.cleanup(); }
});

test("a workspace that changed during verification voids it, whatever the verifier said", async () => {
  const h = harness();
  try {
    await h.gate.claim(h.task.id, "nova", EVIDENCE);
    h.setManifest(new Map([["/home/box/work/q3.md", "bbb"]]));
    await h.gate.verifierEnded({ marker: h.wakes[0]!.goal!, how: "done", worked: true, finalText: REPORT_PASS });
    assert.equal(h.pursuit().status, "active");
    assert.equal(h.pursuit().spent.rejections, 1);
    assert.match(h.pursuit().lastVerdict?.nextAction ?? "", /workspace changed while it was being verified/);
  } finally { h.cleanup(); }
});

test("after a restart a goal left verifying finds its verdict in the transcript, or is rejected as interrupted", async () => {
  const h = harness();
  try {
    await h.gate.claim(h.task.id, "nova", EVIDENCE);
    h.setTranscript([{ role: "user", text: "…", host: true }, { role: "assistant", kind: "blocks", blocks: [{ type: "text", text: REPORT_PASS }] }]);
    const fresh = new GoalGate((h.gate as unknown as { deps: GoalGateDeps }).deps);
    assert.equal(await fresh.rearm(), 1);
    assert.equal(h.pursuit().status, "complete", "the verdict on the record is applied");

    const again = harness();
    try {
      await again.gate.claim(again.task.id, "nova", EVIDENCE);
      again.setTranscript([{ role: "user", text: "…", host: true }]);
      const restarted = new GoalGate((again.gate as unknown as { deps: GoalGateDeps }).deps);
      assert.equal(await restarted.rearm(), 1);
      assert.equal(again.pursuit().status, "active", "no verdict: failed closed, back to the loop");
      assert.equal(again.pursuit().spent.rejections, 1);
      assert.match(again.pursuit().lastVerdict?.nextAction ?? "", /interrupted by a restart/);
      assert.match(again.told.at(-1) ?? "", /验证被中断/);
    } finally { again.cleanup(); }
  } finally { h.cleanup(); }
});

test("the verifier's spend lands on the goal's bill (INV-772)", async () => {
  const h = harness();
  try {
    await h.gate.claim(h.task.id, "nova", EVIDENCE);
    await h.gate.verifierEnded({ marker: h.wakes[0]!.goal!, how: "done", worked: true, finalText: REPORT_PASS, cost: 1234 });
    assert.equal(h.pursuit().spent.cost, 1234);
    assert.equal(h.pursuit().status, "complete");
  } finally { h.cleanup(); }
});

