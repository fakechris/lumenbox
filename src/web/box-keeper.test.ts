/** The local box's keeper (INV-1550): what it does when the box goes away, and what it leaves alone. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxKeeper, type KeeperDeps } from "./box-keeper.ts";

function world(over: Partial<{ held: boolean; recreating: boolean; startFails: boolean }> = {}) {
  let up = true, state = "running", clock = 0;
  const said: string[] = [], logs: string[] = [], woken: string[] = [], interrupted: string[][] = [];
  let starts = 0;
  const deps: KeeperDeps = {
    client: () => ({ health: async () => { if (!up) throw new Error("fetch failed"); return {}; } }) as never,
    connect: async () => (up ? { connected: true, detail: "box ready" } : { connected: false, detail: "not running" }),
    container: { name: "agentbox-box", status: async () => ({ state, containerName: "agentbox-box" }) as never, start: async () => { starts += 1; if (over.startFails) throw new Error("engine busy"); up = true; state = "running"; } },
    heldDown: () => (over.held ? { by: "agentbox box down", at: "2026-11-03T12:00:00Z" } : undefined),
    recreating: () => over.recreating === true,
    agentsOnBox: () => ["bob", "vic"],
    interrupt: ids => { interrupted.push([...ids]); return [...ids]; },
    wake: id => woken.push(id),
    notify: text => said.push(text),
    log: line => logs.push(line),
    now: () => clock,
  };
  return { keeper: new BoxKeeper(deps), stop: () => { up = false; state = "exited"; }, advance: (ms: number) => { clock += ms; }, said, logs, woken, interrupted, starts: () => starts };
}

test("a box stopped from outside: admins told once, its turns stopped, the box started, the agents told it is back", async () => {
  const w = world();
  assert.deepEqual(await w.keeper.tick(), { connected: true, detail: "answering" });
  w.stop();
  const after = await w.keeper.tick();
  assert.equal(after.connected, true, "started and reconnected in the same tick");
  assert.equal(w.starts(), 1);
  assert.deepEqual(w.interrupted[0], ["bob", "vic"], "the turns that could only fail were stopped");
  assert.match(w.said[0] ?? "", /stopped answering/);
  assert.match(w.said[1] ?? "", /The box is back/);
  assert.deepEqual(w.woken, ["bob", "vic"], "each agent whose turn was stopped hears the box is back");
  assert.ok(w.logs.some(line => /nobody stopped it on purpose; starting it/.test(line)));
  w.stop(); // stopped again half a minute later: a new outage, not the same one's cooldown
  w.advance(30_000);
  assert.equal((await w.keeper.tick()).connected, true);
  assert.equal(w.starts(), 2);
});

test("a box a person stopped is left stopped, and said once", async () => {
  const w = world({ held: true });
  await w.keeper.tick();
  w.stop();
  await w.keeper.tick(); await w.keeper.tick();
  assert.equal(w.starts(), 0);
  assert.equal(w.logs.filter(line => /so it is left stopped/.test(line)).length, 1);
});

test("starting is bounded: a cooldown between tries, three tries, then admins are told it needs a person", async () => {
  const w = world({ startFails: true });
  await w.keeper.tick();
  w.stop();
  await w.keeper.tick();
  await w.keeper.tick();
  assert.equal(w.starts(), 1, "not again within the cooldown");
  for (let i = 0; i < 5; i++) { w.advance(3 * 60_000); await w.keeper.tick(); }
  assert.equal(w.starts(), 3, "three tries an episode");
  assert.ok(w.said.some(text => /could not be started/.test(text)));
});

test("an update or reset recreating the box is downtime somebody chose: nothing is stopped, started or announced", async () => {
  const w = world({ recreating: true });
  await w.keeper.tick();
  w.stop();
  await w.keeper.tick();
  assert.deepEqual([w.starts(), w.said.length, w.interrupted.length], [0, 0, 0]);
});

test("the marker: box down holds it, box up releases it, and an unreadable marker still holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-held-"));
  process.env.AGENTBOX_HOME = root;
  try {
    const { boxHeldDown, holdBoxDown, releaseBoxDown } = await import("../box/held-down.ts");
    assert.equal(boxHeldDown("agentbox-box"), undefined);
    holdBoxDown("agentbox-box", "agentbox box down", new Date("2026-11-03T12:00:00Z"));
    assert.deepEqual(boxHeldDown("agentbox-box"), { by: "agentbox box down", at: "2026-11-03T12:00:00.000Z" });
    assert.equal(boxHeldDown("other-box"), undefined, "per container");
    releaseBoxDown("agentbox-box");
    assert.equal(boxHeldDown("agentbox-box"), undefined);
  } finally {
    delete process.env.AGENTBOX_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});
