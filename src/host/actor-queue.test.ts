/**
 * The bounded per-actor queue (INV-554).
 *
 * The consumer's tests cover the loop end to end; these cover the rules on their own, where
 * each is one line and the failure is unambiguous.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ActorQueue, ActorQueues, describeQueues } from "./actor-queue.ts";

test("one runs, the rest wait in the order they arrived, and the queue can be read", () => {
  const queue = new ActorQueue("ada", { capacity: 3, now: () => new Date("2026-09-16T10:00:00Z") });
  for (const id of ["a", "b", "c"]) assert.equal(queue.offer({ id, subject: `INV-${id}` }).accepted, true);

  assert.equal(queue.next()?.id, "a");
  assert.equal(queue.next(), undefined, "single concurrency: nothing else starts while one is in hand");

  const view = queue.view();
  assert.deepEqual(view.running.map(entry => entry.subject), ["INV-a"]);
  assert.deepEqual(view.waiting.map(entry => entry.subject), ["INV-b", "INV-c"]);
  assert.deepEqual(view.waiting.map(entry => entry.position), [1, 2]);
  assert.deepEqual(describeQueues([view]), ["ada: answering INV-a, 2 waiting (INV-b, INV-c)"]);

  queue.done("a");
  assert.equal(queue.next()?.id, "b", "and the next one starts when the slot frees");
});

test("full is a refusal in words, and re-offering what is already here is not", () => {
  const queue = new ActorQueue("ada", { capacity: 2 });
  queue.offer({ id: "a" });
  queue.offer({ id: "b" });

  const full = queue.offer({ id: "c" });
  assert.equal(full.accepted, false);
  assert.equal(full.accepted === false ? full.reason : "", "full");
  assert.match(full.accepted === false && full.reason === "full" ? full.why : "", /as many as I take at once/);

  const again = queue.offer({ id: "a" });
  assert.equal(again.accepted === false ? again.reason : "", "known", "an ordinary poll pass re-offering its own queue says nothing");
  assert.equal(queue.depth, 2, "and does not double it");
});

test("a deadline that has passed is dropped rather than run late", () => {
  let clock = Date.parse("2026-09-16T10:00:00Z");
  const queue = new ActorQueue("ada", { now: () => new Date(clock) });
  assert.equal(queue.offer({ id: "a", deadlineAt: clock + 60_000 }).accepted, true);
  assert.equal(queue.offer({ id: "b", deadlineAt: clock - 1 }).accepted, false, "already past when offered");

  clock += 120_000;
  assert.equal(queue.next(), undefined, "and past while waiting: the ledger's sweep has closed it, a second answer would be worse than none");
  assert.equal(queue.depth, 0);
});

test("cancelled stays cancelled, through a retry and past the memory it keeps", () => {
  const queue = new ActorQueue("ada", { capacity: 4 });
  queue.offer({ id: "a" });
  queue.cancel("a");
  assert.equal(queue.depth, 0);
  assert.equal(queue.offer({ id: "a" }).accepted, false, "a redelivery does not revive it");

  // Anything the source stopped listing is withdrawn too — that is the only signal there is.
  queue.offer({ id: "b" });
  queue.offer({ id: "c" });
  assert.deepEqual(queue.retainOnly(new Set(["b"])), ["c"]);
  assert.equal(queue.offer({ id: "c" }).accepted, false);

  // Bounded memory, so a long-lived process does not grow a list of every id it ever saw.
  for (let i = 0; i < 600; i += 1) queue.cancel(`old-${i}`);
  assert.equal(queue.offer({ id: "a" }).accepted, true, "the oldest cancellations are eventually forgotten, which is the trade for a bounded list");
});

test("queues are per actor, and an idle one is not reported as news", () => {
  const queues = new ActorQueues({ capacity: 2 });
  queues.for("ada").offer({ id: "a", subject: "INV-1" });
  queues.for("iris").offer({ id: "b", subject: "INV-2" });
  assert.deepEqual(queues.views().map(view => view.actor), ["ada", "iris"]);

  queues.for("ada").cancel("a");
  assert.deepEqual(queues.views().map(view => view.actor), ["iris"], "an empty queue is nothing to say");
  assert.deepEqual(queues.for("ada"), queues.for("ada"), "and the same actor gets the same queue, which is what makes it a queue");
});
