/** Who checks a claim and what their checking leaves behind (INV-1614): K reviewers, one record each, a settled claim is cited, new evidence reopens it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationFor, evidenceDigest, pickReviewers, planRound, recordLines, reviewRound, VerificationLedger, verdictOf } from "./review-dispatch.ts";
import { TaskStore, type Task } from "./tasks.ts";

const PASS = "Status: complete\nIntegrity: clean\nContract audit: aligned\nItem acceptance: proven — ran it\nNext action: none";
const FAIL = "Status: incomplete\nIntegrity: clean\nContract audit: aligned\nItem acceptance: contradicted — the file is empty\nNext action: write it";
const names = (id: string) => id.toUpperCase();

function claimed(store: TaskStore, evidence: string[] = ["/work/report.md: the report"]): Task {
  const task = store.create({ title: "Write the report", requester: "chris", assigneeId: "ada", reviewerId: "bob", contract: { acceptance: "report.md exists and names the quarter" } })!;
  store.update(task.id, { status: "doing" }, "ada");
  return store.update(task.id, { status: "review", evidence }, "ada")!.task;
}

test("dispatch goes to K reviewers only: the named one first, never the assignee or requester, the same set each time", () => {
  const task = { id: "t1", assigneeId: "ada", requester: "chris", reviewerId: "bob" };
  const team = ["ada", "bob", "cy", "dee", "enzo", "chris"];
  const picked = pickReviewers(task, team, 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0], "bob");
  assert.ok(!picked.includes("ada") && !picked.includes("chris"));
  assert.deepEqual(pickReviewers(task, [...team].reverse(), 2), picked, "order of the team does not change who is picked");
  assert.deepEqual(pickReviewers(task, team, 1), ["bob"]);
  assert.equal(pickReviewers(task, team, 9).length, 4, "only four are eligible");
  assert.deepEqual(pickReviewers({ ...task, reviewerId: "ada" }, team, 2).includes("ada"), false, "a named reviewer who is the assignee is not one");
});

test("records dedupe by (claim, digest, reviewer); K agreeing records settle; a 'none' counts for neither side; the file is append-only JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "verif-"));
  try {
    const path = join(dir, "verifications.jsonl");
    const ledger = new VerificationLedger(path);
    ledger.add({ taskId: "t1", digest: "d1", reviewerId: "bob", verdict: "pass", basis: "ran it" });
    ledger.add({ taskId: "t1", digest: "d1", reviewerId: "bob", verdict: "pass", basis: "ran it again" });
    assert.equal(ledger.recordsFor("t1", "d1").length, 1);
    assert.equal(ledger.recordsFor("t1", "d1")[0]!.basis, "ran it again");
    assert.equal(ledger.settled("t1", "d1", 2), undefined);
    ledger.add({ taskId: "t1", digest: "d1", reviewerId: "cy", verdict: "none", basis: "no verdict" });
    assert.equal(ledger.settled("t1", "d1", 2), undefined, "a none is not a vote");
    ledger.add({ taskId: "t1", digest: "d1", reviewerId: "dee", verdict: "pass", basis: "read it" });
    assert.deepEqual(ledger.settled("t1", "d1", 2), { verdict: "pass", by: ["bob", "dee"], digest: "d1" });
    assert.equal(ledger.settled("t1", "d2", 2), undefined, "another digest is another claim");
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 4, "every write is a line; the live view dedupes");
    const reloaded = new VerificationLedger(path);
    assert.equal(reloaded.recordsFor("t1", "d1").length, 3);
    assert.equal(reloaded.historyFor("t1").length, 3);
    assert.match(recordLines(reloaded.recordsFor("t1", "d1"), names)[0]!, /BOB · pass on d1: ran it again$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the K+1-th reviewer gets a citation, not a round; new evidence changes the digest and dispatches again; a split costs one more reviewer", () => {
  const store = new TaskStore(null);
  const task = claimed(store);
  const team = ["ada", "bob", "cy", "dee", "enzo"];
  const ledger = new VerificationLedger();
  const first = planRound(task, ledger, team, 2);
  assert.equal(first.reviewers.length, 2);
  assert.equal(first.settled, undefined);
  for (const reviewerId of first.reviewers) ledger.add({ taskId: task.id, digest: first.digest, reviewerId, verdict: "pass", basis: "checked" });
  const again = planRound(task, ledger, team, 2);
  assert.deepEqual(again.reviewers, []);
  assert.equal(again.settled?.verdict, "pass");
  const cite = citationFor(task, ledger, 2, names);
  assert.match(cite!, /^verified complete by [A-Z]+, [A-Z]+ on evidence [0-9a-f]{16} — cite this record rather than re-checking/);
  assert.equal(citationFor(task, ledger, 3, names), undefined, "with K=3 two records do not settle it");

  // New evidence: the same task, a new digest, the old records no longer apply.
  const reopened = store.update(task.id, { status: "doing", note: "the quarter is wrong" }, "chris")!.task;
  const resubmitted = store.update(reopened.id, { status: "review", evidence: ["/work/report.md: Q3 named now"] }, "ada")!.task;
  assert.notEqual(evidenceDigest(resubmitted), first.digest);
  const third = planRound(resubmitted, ledger, team, 2);
  assert.equal(third.reviewers.length, 2, "dispatched again under the new digest");
  assert.equal(citationFor(resubmitted, ledger, 2, names), undefined);

  // A split: one pass and one fail is not a settlement; one more reviewer is owed.
  ledger.add({ taskId: task.id, digest: third.digest, reviewerId: third.reviewers[0]!, verdict: "pass", basis: "fine" });
  ledger.add({ taskId: task.id, digest: third.digest, reviewerId: third.reviewers[1]!, verdict: "fail", basis: "not fine" });
  const fourth = planRound(resubmitted, ledger, team, 2);
  assert.equal(fourth.reviewers.length, 1);
  assert.ok(!third.reviewers.includes(fourth.reviewers[0]!));
  ledger.add({ taskId: task.id, digest: third.digest, reviewerId: fourth.reviewers[0]!, verdict: "fail", basis: "also not fine" });
  assert.equal(planRound(resubmitted, ledger, team, 2).settled?.verdict, "fail");
});

test("a round asks the owed reviewers at once and the record moves the task: pass stays in review with the citation, fail goes back to doing with the findings, a voided review is a none", async () => {
  const store = new TaskStore(null);
  const ledger = new VerificationLedger();
  const asked: string[] = [];
  const replies: Record<string, string> = { bob: PASS, cy: PASS, dee: PASS, enzo: FAIL };
  const deps = {
    ledger, k: 2, candidates: () => ["ada", "bob", "cy", "dee", "enzo"], nameOf: names, log: () => {},
    ask: async (reviewerId: string) => { asked.push(reviewerId); return { reply: replies[reviewerId] ?? "" }; },
    current: (id: string) => store.get(id),
    move: (id: string, change: { status?: "review" | "doing"; note: string }) => { store.update(id, change, "review-guard"); },
  };
  const passing = claimed(store);
  const round = await reviewRound(deps, passing);
  assert.equal(asked.length, 2);
  assert.equal(round.settled?.verdict, "pass");
  const after = store.get(passing.id)!;
  assert.equal(after.status, "review");
  assert.match(after.history.at(-1)!.note!, /^verified complete by [A-Z]+, [A-Z]+ on evidence [0-9a-f]{16}; awaiting the requester's acceptance/);
  assert.equal(after.history.at(-1)!.by, "review-guard");
  // Asked again about the same claim: nobody is woken.
  const repeat = await reviewRound(deps, after);
  assert.deepEqual(repeat.asked, []);
  assert.equal(asked.length, 2);

  // A failing claim, where one reviewer fails and the other is void: the void is a none and the claim is not settled.
  const failing = claimed(store, ["/work/other.md: nothing"]);
  const plan = planRound(failing, ledger, deps.candidates(), 2);
  const voided = new Set([plan.reviewers[0]!]);
  const deps2 = { ...deps, ask: async (reviewerId: string) => { asked.push(reviewerId); return voided.has(reviewerId) ? { reply: "", voided: "edited a file" } : { reply: FAIL }; } };
  const second = await reviewRound(deps2, failing);
  assert.equal(second.settled, undefined);
  assert.match(store.get(failing.id)!.history.at(-1)!.note!, /void or no-verdict/);
  assert.equal(ledger.recordsFor(failing.id, plan.digest).filter(r => r.verdict === "none").length, 1);
  // The next round asks one more, who fails: settled fail, back to doing with the findings.
  const third = await reviewRound({ ...deps, ask: async (reviewerId: string) => { asked.push(reviewerId); return { reply: FAIL }; } }, store.get(failing.id)!);
  assert.equal(third.settled?.verdict, "fail");
  const sent = store.get(failing.id)!;
  assert.equal(sent.status, "doing");
  assert.match(sent.history.at(-1)!.note!, /^verified not complete by [A-Z]+, [A-Z]+ on evidence [0-9a-f]{16}: audit did not pass/);
  assert.deepEqual(verdictOf(passing, "I think it is fine"), { verdict: "none", basis: "audit gave no verdict (reply did not follow the protocol); not accepted — a person decides" });
});
