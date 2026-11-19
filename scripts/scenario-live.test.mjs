/**
 * The live scenario harness and the installation's own box (INV-1828).
 *
 * `npm run scenario` lets a real model run shell commands and write files in a box, and a connect
 * applies a CPU ceiling to it. For a while that box was the one a person was working in: only the
 * home was swapped, and the container name fell through to the default. What would be wrong is
 * exactly that — a live run reaching the default container — so that is what this holds, without
 * Docker or a model: the orchestrator is a stand-in that records which box it was handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_PREFIX, evalBoxName, openEvalBox } from "./lib/eval-box.mjs";
import { liveEpisode } from "./scenario-live.mjs";
import { DEFAULT_CONTAINER } from "../src/box/docker.ts";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_CONTAINER", "AGENTBOX_TOKEN", "AGENTBOX_BOXD_URL"];

/** Runs `body` with these variables and a scratch home, and puts the environment back. */
async function withEnv(vars, body) {
  const before = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const home = mkdtempSync(join(tmpdir(), "lumenbox-scenario-live-test-"));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { AGENTBOX_HOME: home }, vars);
  try {
    return await body();
  } finally {
    for (const key of KEYS) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** Stands where the orchestrator does and records the boxes live episodes were given. */
function recordingOrchestrator() {
  const boxes = [];
  class Orchestrator {
    bus = { idle: async () => {} };
    constructor(options) {
      boxes.push(options.boxProvisioner?.boxName ?? DEFAULT_CONTAINER);
    }
    async prompt() {}
  }
  return { Orchestrator, boxes };
}

const scenario = { name: "t", say: "hello", expect: {} };

test("a live scenario never runs in the installation's own box", async () => {
  // No eval box open: the name would fall through to the default. Refused before an orchestrator exists.
  for (const vars of [{}, { AGENTBOX_CONTAINER: DEFAULT_CONTAINER }, { AGENTBOX_CONTAINER: "" }]) {
    const stand = recordingOrchestrator();
    await withEnv(vars, () => assert.rejects(liveEpisode(scenario, {}, stand), /installation's own box/, JSON.stringify(vars)));
    assert.deepEqual(stand.boxes, [], "nothing was started");
  }

  // With the eval box open, the orchestrator is handed that box by name — and an attached-box
  // URL in the environment does not take its place.
  const name = evalBoxName("scenario-t1");
  const stand = recordingOrchestrator();
  await withEnv({ AGENTBOX_CONTAINER: name, AGENTBOX_TOKEN: "t", AGENTBOX_BOXD_URL: "http://127.0.0.1:1" }, () => liveEpisode(scenario, {}, stand));
  assert.deepEqual(stand.boxes, [name]);
  assert.ok(name.startsWith(EVAL_PREFIX));
});

test("the scenarios' box cannot be pointed at the installation's own, by a flag or by the environment", async () => {
  await withEnv({}, () => assert.rejects(openEvalBox({ argv: ["--box", "use", DEFAULT_CONTAINER], isolated: true }), /installation's own box/));
  await withEnv({ AGENTBOX_CONTAINER: DEFAULT_CONTAINER }, () => assert.rejects(openEvalBox({ argv: [], isolated: true }), /installation's own box/));
});
