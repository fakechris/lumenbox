import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { EVENT_RECOVERY_JS } from "./event-recovery.ts";

function fixture() {
  const applied: string[] = [], states: string[] = [], jobs: (() => void)[] = [];
  let rebuilds = 0, release: (() => void) | undefined;
  const options = { apply: (raw: { data: string }) => applied.push(JSON.parse(raw.data).value),
    connection: (state: string) => states.push(state), schedule: (job: () => void) => jobs.push(job),
    rebuild: () => { rebuilds++; return new Promise<void>(resolve => { release = resolve; }); } };
  const scope = { options, recovery: undefined as any };
  runInNewContext(EVENT_RECOVERY_JS + "\nrecovery = createEventRecovery(options);", scope);
  const send = (id: string, value: string, type = "step") => scope.recovery.receive({ lastEventId: id, data: JSON.stringify({ type, value }) });
  return { applied, states, jobs, send, recovery: scope.recovery, count: () => rebuilds, finish: () => release!() };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("the browser rejects duplicate/older cursors and rebuilds instead of applying an undeclared epoch", async () => {
  const f = fixture();
  f.recovery.checkpoint({ lastEventId: "one:4" });
  f.send("one:5", "fifth"); f.send("one:5", "duplicate"); f.send("one:3", "old");
  assert.deepEqual(f.applied, ["fifth"]);
  f.send("two:1", "wrong generation");
  await tick();
  assert.deepEqual(f.applied, ["fifth"]);
  assert.equal(f.count(), 1);
  f.finish(); await tick();
  f.send("two:2", "new generation");
  assert.deepEqual(f.applied, ["fifth", "new generation"]);
});

test("reset discards overlap, re-reads on intervening events and ignores stale asynchronous rebuild completion", async () => {
  const f = fixture();
  f.send("one:5", "", "reset"); await tick();
  f.send("one:6", "already in a snapshot");
  f.send("two:1", "", "reset");
  f.finish(); await tick();
  assert.equal(f.jobs.length, 1);
  f.jobs.shift()!(); await tick();
  assert.equal(f.count(), 2);
  f.finish(); await tick();
  assert.equal(f.states.at(-1), "connected");
  assert.deepEqual(f.applied, []);
  f.send("two:2", "after stable snapshot");
  assert.deepEqual(f.applied, ["after stable snapshot"]);
  f.recovery.failed(); assert.equal(f.states.at(-1), "reconnecting");
  f.recovery.opened(); assert.equal(f.states.at(-1), "connected");
});
