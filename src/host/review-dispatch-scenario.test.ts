/**
 * The 2026-11-04 shape, on a real board (INV-1614): five agents, ten claims. Before, every agent
 * re-checked every card — fifty audits for ten claims. Now each claim is dispatched to K=2 and
 * the record answers everyone else; the verdicts are the ones five independent checks would give.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { citationFor, DEFAULT_REVIEWERS_PER_CLAIM, evidenceDigest, REVIEW_ACTOR, reviewRound, VerificationLedger } from "./review-dispatch.ts";
import { TaskStore, type Task } from "./tasks.ts";

const PASS = "Status: complete\nIntegrity: clean\nContract audit: aligned\nItem acceptance: proven — ran the check\nNext action: none";
const FAIL = "Status: incomplete\nIntegrity: clean\nContract audit: aligned\nItem acceptance: contradicted — the output is missing\nNext action: produce it";

test("five agents, ten claims: at most 10 × K review turns, every claim settled as a full recompute would, the rest cite the record", async () => {
  const team = ["ada", "bob", "cy", "dee", "enzo"];
  const store = new TaskStore(null);
  const ledger = new VerificationLedger();
  const k = DEFAULT_REVIEWERS_PER_CLAIM;
  // What any honest check of claim n finds — the same for whoever does it, which is what makes a shared record legitimate.
  const truth = (task: Task) => Number(task.title.slice("claim ".length)) % 3 !== 0;
  const asks: { reviewerId: string; taskId: string }[] = [];
  const rounds = new Set<Promise<unknown>>();
  const auditing = new Set<string>();
  // The orchestrator's trigger, as it stands there: a claim in review with a named reviewer, not already in a round, not moved last by the record or a reviewer on it.
  store.onChange(task => {
    if (task.status !== "review" || task.reviewerId === undefined || auditing.has(task.id)) return;
    const last = task.history.at(-1);
    if (last?.by === REVIEW_ACTOR || last?.by === task.reviewerId || ledger.recordsFor(task.id, evidenceDigest(task)).some(r => r.reviewerId === last?.by)) return;
    auditing.add(task.id);
    const round = reviewRound({
      ledger, k, candidates: () => team, nameOf: id => id, log: () => {},
      ask: async (reviewerId, current) => { asks.push({ reviewerId, taskId: current.id }); await new Promise(resolve => setTimeout(resolve, 1)); return { reply: truth(current) ? PASS : FAIL }; },
      current: id => store.get(id),
      move: (id, change) => { store.update(id, change, REVIEW_ACTOR); },
    }, task).finally(() => { auditing.delete(task.id); rounds.delete(round); });
    rounds.add(round);
  });

  const claims: Task[] = [];
  for (let n = 1; n <= 10; n++) {
    const task = store.create({ title: `claim ${n}`, requester: "chris", assigneeId: "ada", reviewerId: "bob", contract: { acceptance: `output ${n} exists` } })!;
    store.update(task.id, { status: "doing" }, "ada");
    claims.push(store.update(task.id, { status: "review", evidence: [`/work/out-${n}.md: the output`] }, "ada")!.task);
  }
  while (rounds.size > 0) await Promise.all([...rounds]);

  assert.ok(asks.length <= 10 * k, `${asks.length} review turns for 10 claims; the ceiling is ${10 * k}, a full recompute by five would be 50`);
  assert.equal(asks.length, 10 * k);
  assert.ok(asks.every(ask => ask.reviewerId !== "ada"), "the assignee never reviews its own claim");
  for (const claim of claims) {
    const now = store.get(claim.id)!;
    const settled = ledger.settled(claim.id, evidenceDigest(now), k);
    assert.equal(settled?.verdict, truth(now) ? "pass" : "fail", `${now.title} settled as a full recompute would`);
    assert.equal(settled!.by.length, k);
    assert.equal(now.status, truth(now) ? "review" : "doing");
    assert.equal(now.history.at(-1)!.by, REVIEW_ACTOR);
    // The three who were not asked read the record instead.
    const uninvolved = team.filter(id => id !== "ada" && !settled!.by.includes(id));
    assert.equal(uninvolved.length, 2);
    assert.match(citationFor(now, ledger, k, id => id)!, truth(now) ? /^verified complete by/ : /^verified not complete by/);
  }
  // Asking again about every settled claim wakes nobody.
  for (const claim of claims) {
    const result = await reviewRound({ ledger, k, candidates: () => team, nameOf: id => id, log: () => {}, ask: async () => { throw new Error("nobody should be asked"); }, current: id => store.get(id), move: () => {} }, store.get(claim.id)!);
    assert.deepEqual(result.asked, []);
  }
  assert.equal(asks.length, 10 * k);
});
