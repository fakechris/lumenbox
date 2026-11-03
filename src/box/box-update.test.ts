/** The one box-update sequence (INV-1538): wait for work, recreate keeping volumes, verify, go back by image id. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUpdate, type ImageState, type UpdateDeps } from "./box-update.ts";

const OLD: ImageState = { runningRef: "fakechris/lumenbox:0.3.9", runningId: "sha256:old0000000000000", expectedRef: "fakechris/lumenbox:0.3.10", expectedId: "sha256:new", available: true, needsPull: false };

function fake(overrides: Partial<{ state: ImageState; busy: string[][]; verify: (string | Error | undefined)[]; recreateFails: number }> = {}) {
  const recreated: (string | undefined)[] = [];
  const said: string[] = [];
  let backedUp = false;
  const busy = overrides.busy ?? [[]];
  const verify = overrides.verify ?? [undefined];
  let failures = overrides.recreateFails ?? 0;
  const deps: UpdateDeps = {
    state: async () => overrides.state ?? OLD,
    busy: async () => busy.length > 1 ? busy.shift()! : busy[0]!,
    recreate: async image => { recreated.push(image); if (failures-- > 0) throw new Error("pull failed"); return { containerName: "agentbox-box", state: "running" } as never; },
    verify: async () => { const v = verify.length > 1 ? verify.shift() : verify[0]; if (v instanceof Error) throw v; return v; },
    backup: async () => { backedUp = true; return ["work.tar", "config.tar"]; },
    onOutput: line => said.push(line),
    sleep: async () => {},
  };
  return { deps, recreated, said, backedUp: () => backedUp };
}

test("nothing to do when the box already runs the expected image, unless forced", async () => {
  const f = fake({ state: { ...OLD, available: false } });
  assert.equal((await applyUpdate(f.deps)).outcome, "current");
  assert.deepEqual(f.recreated, []);
  assert.equal((await applyUpdate(f.deps, { force: true })).outcome, "updated", "box up --recreate forces it");
});

test("work in flight: an update waits rather than interrupting, or waits it out when asked to", async () => {
  const now = fake({ busy: [["1 turn(s) in progress"]] });
  const waiting = await applyUpdate(now.deps);
  assert.deepEqual([waiting.outcome, waiting.busy], ["waiting", ["1 turn(s) in progress"]]);
  assert.deepEqual(now.recreated, [], "nothing was recreated");
  const idle = fake({ busy: [["job j1: npm test"], ["job j1: npm test"], []] });
  const done = await applyUpdate(idle.deps, { whenIdle: true });
  assert.equal(done.outcome, "updated", "waited until the job ended, then updated");
  assert.deepEqual(idle.recreated, [undefined]);
  let clock = 0;
  const forever = fake({ busy: [["job j2: sleep"]] });
  const timedOut = await applyUpdate({ ...forever.deps, now: () => (clock += 60_000) }, { whenIdle: true, maxWaitMs: 5 * 60_000 });
  assert.equal(timedOut.outcome, "waiting", "the wait has an end");
});

test("no backup unless asked; the volumes are not touched by an update", async () => {
  const plain = fake();
  await applyUpdate(plain.deps);
  assert.equal(plain.backedUp(), false);
  const asked = fake();
  await applyUpdate(asked.deps, { backup: true });
  assert.equal(asked.backedUp(), true);
});

test("a box that comes back broken goes back to the image it had, by id; when that fails too, it says so", async () => {
  const broken = fake({ verify: ["the browser could not be driven", undefined] });
  const rolled = await applyUpdate(broken.deps);
  assert.equal(rolled.outcome, "rolled_back");
  assert.deepEqual(broken.recreated, [undefined, "sha256:old0000000000000"], "back to the old image id, not a :previous tag");
  assert.match(rolled.detail, /browser could not be driven.*back on the image it had/);
  const unreachable = fake({ verify: [new Error("the box is not running"), undefined] });
  assert.equal((await applyUpdate(unreachable.deps)).outcome, "rolled_back", "a box that cannot be connected to is broken, and goes back");
  const worse = fake({ verify: ["no", "still no"] });
  assert.equal((await applyUpdate(worse.deps)).outcome, "failed");
  const pullFails = fake({ recreateFails: 1 });
  const afterPull = await applyUpdate(pullFails.deps);
  assert.deepEqual([afterPull.outcome, pullFails.recreated], ["rolled_back", [undefined, "sha256:old0000000000000"]], "a failed recreate also goes back");
  const fresh = fake({ state: { expectedRef: "fakechris/lumenbox:0.3.10", available: false, needsPull: true }, verify: ["no"] });
  assert.equal((await applyUpdate(fresh.deps, { force: true })).outcome, "failed", "no box before: nothing to go back to");
});

test("a person who chose Update now is not made to wait, and a refusal says how to go on (INV-1551)", async () => {
  const busy = fake({ busy: [["job j1: npm test"]] });
  assert.equal((await applyUpdate(busy.deps, { interrupt: true })).outcome, "updated", "interrupt does not wait");
  const refused = await applyUpdate(fake({ busy: [["job j1: npm test"]] }).deps);
  assert.match(refused.detail, /not updated.*Update now/, "the refusal names the way forward");
});
