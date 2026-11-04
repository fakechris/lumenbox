/** A `docker run` that hangs or fails is settled by what it left, and never blocks the next one on the name (INV-1561). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runContainer, type RunState } from "./run-container.ts";

/** A fake engine: the states the container reads as, in order, and a record of what was asked. */
function engine(options: { run: "ok" | "hang"; states: RunState[]; startFails?: boolean }) {
  const calls: string[] = [];
  const states = [...options.states];
  let clock = 0;
  return {
    calls,
    deps: {
      run: async () => { calls.push("run"); if (options.run === "hang") throw new Error("docker run failed: Command failed (exit 143)"); },
      state: async () => { calls.push("state"); return states.length > 1 ? states.shift()! : states[0]!; },
      start: async () => { calls.push("start"); if (options.startFails) throw new Error("image is broken"); },
      remove: async () => { calls.push("remove"); },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      settleMs: 10_000,
      pollMs: 2_000,
    },
  };
}

test("a leftover with the name is removed before every run, so going back never collides", async () => {
  const { deps, calls } = engine({ run: "ok", states: ["missing"] });
  assert.equal(await runContainer(deps), "ran");
  assert.deepEqual(calls, ["remove", "run"]);
});

test("the run timed out but the container was created: it is started, and that is a box", async () => {
  const { deps, calls } = engine({ run: "hang", states: ["created", "running"] });
  assert.equal(await runContainer(deps), "started after a failed run");
  assert.deepEqual(calls, ["remove", "run", "state", "start", "state"]);
});

test("the run failed and the container will not start: it is removed and the run's error stands", async () => {
  const { deps, calls } = engine({ run: "hang", states: ["created"], startFails: true });
  await assert.rejects(runContainer(deps), /exit 143/);
  assert.equal(calls.filter(call => call === "start").length, 1, "started once, not in a loop");
  assert.equal(calls.at(-1), "remove", "the name is free for whoever goes back");
});

test("a stuck engine that catches up: the container shows up running a few reads later", async () => {
  const { deps } = engine({ run: "hang", states: ["unknown", "unknown", "running"] });
  assert.equal(await runContainer(deps), "running after a failed run");
});

test("nothing was created: removal is harmless and the run's error stands", async () => {
  const { deps, calls } = engine({ run: "hang", states: ["missing"] });
  await assert.rejects(runContainer(deps), /exit 143/);
  assert.deepEqual(calls, ["remove", "run", "state", "remove"]);
});
