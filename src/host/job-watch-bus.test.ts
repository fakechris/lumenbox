/**
 * The 2026-11-04 shape, on the real bus (INV-1613): one agent lets twenty short commands run on
 * past their window, two of them fail. Before, that was twenty turns; now the two failures share
 * a wake and the eighteen that passed are one note in the next turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus, type InboundMessage } from "../agents/bus.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { recordedEndsNote } from "./job-end.ts";
import { JobWatch, type JobWatchBox } from "./job-watch.ts";

test("twenty jobs, two failures: the agent is woken at most three times, and the next turn sees the rest as one note", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-jobwatch-"));
  try {
    const registry = new AgentRegistry(root);
    const vic = registry.create({ name: "Vic" });
    // The model's place: every turn the bus opens is counted, with what woke it.
    const turns: InboundMessage[][] = [];
    const bus = new AgentBus(registry, async (_agent, inbound) => { turns.push([...inbound]); });
    // A box whose jobs end as soon as they are asked after: job-7 and job-13 fail, the rest exit 0.
    const box: JobWatchBox = {
      async waitForJob(request) {
        const n = Number(request.job_id.slice("job-".length));
        return { running: false, exit_code: n === 7 || n === 13 ? 1 : 0, log_path: `/jobs/${request.job_id}.log`, tail: n === 7 || n === 13 ? "FAILED" : "ok", reason: "exited" };
      },
      async killJob() {},
    };
    const watch = new JobWatch({
      box: () => box,
      log: () => {},
      pollMs: 5,
      mergeMs: 40,
      // The orchestrator's wiring: a host message on the background lane, then the agent's turn.
      wake: async (agentId, conversation, text) => {
        bus.sendFromUser(agentId, text, { conversation, steerable: false, lane: "background", synthetic: true, origin: "host:jobs" });
        await bus.runExclusive(agentId, { userDriven: true, conversation });
      },
    });
    for (let i = 0; i < 20; i++) {
      watch.watch({ agentId: vic.id, conversation: "main", jobId: `job-${i}`, command: `sleep 20; curl -s http://host/api/tasks?page=${i}` });
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    await bus.idle();

    assert.ok(turns.length <= 3, `woken ${turns.length} times`);
    assert.ok(turns.length >= 1, "the failures did wake it");
    const text = turns.flat().map(message => message.text).join("\n");
    assert.match(text, /job-7/);
    assert.match(text, /job-13/);
    assert.doesNotMatch(text, /job-0\b/);
    for (const message of turns.flat()) {
      assert.equal(message.lane, "background");
      assert.equal(message.origin, "host:jobs");
    }
    // What the next turn opens with: the eighteen that passed, one line each, no turn spent on any of them.
    const recorded = watch.takeRecorded(vic.id, "main");
    assert.equal(recorded.length, 18);
    assert.ok(recorded.every(end => end.exit_code === 0));
    assert.match(recordedEndsNote(recorded)!, /^\[host\] Since your last turn, 18 commands you started ended/);
    assert.deepEqual(watch.takeRecorded(vic.id, "main"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
