import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPSULE_RUN_CEILING, DelegateSessions } from "./delegate-sessions.ts";

test("an engine thread is resumed while nothing that defines it changed, and rotated with a reason when something did", () => {
  const sessions = new DelegateSessions(null);
  const base = { agentId: "a", conversation: "main", preset: "claude", cwd: "/home/box/work/repo", model: "m1" };
  const first = sessions.open(base, new Date("2026-09-07T10:00:00Z"));
  assert.equal(first.resumed, false);
  const second = sessions.open(base, new Date("2026-09-07T10:05:00Z"));
  assert.equal(second.resumed, true);
  assert.equal(second.id, first.id);

  const moved = sessions.open({ ...base, cwd: "/home/box/work/other" }, new Date("2026-09-07T10:06:00Z"));
  assert.equal(moved.resumed, false);
  assert.match(moved.rotated ?? "", /working directory changed/);
  assert.notEqual(moved.id, first.id);

  const remodelled = sessions.open({ ...base, cwd: "/home/box/work/other", model: "m2" }, new Date("2026-09-07T10:07:00Z"));
  assert.match(remodelled.rotated ?? "", /model changed/);

  // The run ceiling.
  const busy = new DelegateSessions(null);
  let last = busy.open(base, new Date("2026-09-07T10:00:00Z"));
  for (let run = 1; run < CAPSULE_RUN_CEILING; run += 1) last = busy.open(base, new Date("2026-09-07T10:00:00Z"));
  assert.equal(last.resumed, true);
  const over = busy.open(base, new Date("2026-09-07T10:00:00Z"));
  assert.equal(over.resumed, false);
  assert.match(over.rotated ?? "", /ceiling/);

  // Age.
  const old = new DelegateSessions(null);
  old.open(base, new Date("2026-09-07T10:00:00Z"));
  const stale = old.open(base, new Date("2026-09-08T00:00:00Z"));
  assert.match(stale.rotated ?? "", /twelve hours/);

  // A different conversation is a different thread, not a rotation.
  const fork = sessions.open({ ...base, conversation: "feishu:oc_1" }, new Date("2026-09-07T10:08:00Z"));
  assert.equal(fork.rotated, undefined);
});
