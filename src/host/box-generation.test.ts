/** A slow callback from a box that was reconnected under it is dropped, with one log line (INV-1476). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxGenerations } from "./box-generation.ts";
import { JobWatch } from "./job-watch.ts";

test("a reconnect is a new generation; a stamp from before it is stale, said once per drop, and shown on the box status", () => {
  const lines: string[] = [];
  const generations = new BoxGenerations(line => lines.push(line));
  assert.equal(generations.current("b1"), 0, "never connected: generation 0");
  const before = generations.stamp("b1");
  assert.equal(generations.stale(before, "routine digest delivery"), false, "same generation: not stale");
  assert.equal(generations.bump("b1", "connected"), 1);
  assert.equal(generations.bump("b1", "connected"), 2, "recreate, attach, reconnect: each is one more");
  assert.equal(generations.stale(before, "routine digest delivery"), true);
  assert.ok(lines.some(line => /^stale-generation: routine digest delivery was for box b1 generation 0, now 2; dropped$/.test(line)));
  assert.equal(generations.stale(generations.stamp("b1"), "x"), false, "a fresh stamp is current");
  assert.equal(generations.current("b2"), 0, "another box is untouched");
  const status = generations.statusOf("b1");
  assert.equal(status.generation, 2);
  assert.equal(status.lastStaleDrop?.what, "routine digest delivery");
  assert.deepEqual(generations.statusOf("b2"), { generation: 0 });
});

test("a job that ends after its box was reconnected does not wake the agent; one that ends in the same generation does", async () => {
  const woken: string[] = [];
  const logs: string[] = [];
  let generation = 1;
  const box = { waitForJob: async () => ({ running: false, exit_code: 0, log_path: "/tmp/j.log", tail: "done" }), killJob: async () => {} };
  const watch = new JobWatch({ box: () => box as never, wake: async (_a, _c, text) => { woken.push(text); }, log: line => logs.push(line), pollMs: 5, mergeMs: 5, generation: () => generation }); // on_end wake: the policy is not what this test is about (INV-1613)
  watch.watch({ jobId: "j1", agentId: "a1", conversation: "main", command: "sleep 1", onEnd: "wake" } as never);
  generation = 2; // the box was reconnected while j1 ran
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(woken, [], "the old incarnation's job end is not a wake");
  assert.ok(logs.some(line => /^stale-generation: job watch j1 began at box generation 1, now 2; the wake is dropped$/.test(line)));
  watch.watch({ jobId: "j2", agentId: "a1", conversation: "main", command: "sleep 1", onEnd: "wake" } as never);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(woken.length, 1, "the same generation: woken as before");
});
