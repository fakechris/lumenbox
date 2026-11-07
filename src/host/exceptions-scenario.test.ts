/**
 * A background job that fails twice, on the real stack (INV-1741): the agent starts a build, the
 * job watch wakes it on the failure, it tries once more and it fails again — one entry on the
 * Issues view counting 2, not two. The host never re-runs the command on its own: that is the
 * agent's judgement. A person presses Retry; the command runs again in the agent's own session,
 * succeeds, and the entry is resolved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxClient } from "../box/client.ts";
import { exceptionRetryDeps, exceptionRoute } from "../web/exception-routes.ts";
import { ExceptionLedger, noteJobEnd } from "./exceptions.ts";
import { JobWatch, type JobWatchBox } from "./job-watch.ts";
import { runEpisode, type ScriptContext, type ScriptedReply } from "./scenario.ts";

const BUILD = "npm run build";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** What the conversation's last message is: the person, a job's end, or a tool's result. */
function lastIs(messages: ScriptContext["messages"]): "person" | "job-ended" | "result" {
  const last = messages.at(-1);
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  if (text.includes("A command you started earlier")) return "job-ended";
  return Array.isArray(last?.content) && last.content.some(block => (block as { type?: string }).type === "tool_result") ? "result" : "person";
}

test("a job that fails twice is one entry counting 2; a person's Retry runs it again and resolves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-exceptions-scenario-"));
  const ledger = new ExceptionLedger(join(dir, "exceptions.jsonl"));
  let wakes = 0;
  let started = 0;
  let box: BoxClient | undefined;
  let watch: JobWatch | undefined;
  const script = ({ messages }: ScriptContext): ScriptedReply => {
    const last = lastIs(messages);
    if (last === "result" || (last === "person" && started > 0)) return { say: started === 1 ? "The build is running in the background." : "Started it once more." };
    if (last === "job-ended") {
      wakes += 1;
      // The agent's judgement: one more try, then stop and say so rather than loop.
      if (wakes === 1) return { call: "bash", input: { command: BUILD, background: true, on_end: "wake_on_failure" } };
      return { say: "The build failed twice with the same error (npm ERR! build failed). I'm stopping here." };
    }
    return { call: "bash", input: { command: BUILD, background: true, on_end: "wake_on_failure" } };
  };
  try {
    const episode = await runEpisode({
      team: [{ name: "Ada" }],
      says: [],
      script,
      box: {
        startJob: (async (_command: string, options: { jobId?: string } = {}) => { started += 1; return { job_id: options.jobId ?? `job-${started}`, pid: 100 + started, log_path: "/tmp/build.log" }; }) as never,
        waitForJob: (async () => ({ running: false, exit_code: 1, log_path: "/tmp/build.log", tail: "> build\nnpm ERR! build failed", reason: "exited" })) as never,
        killJob: (async () => ({})) as never,
      },
      jobWatch: ({ bus, box: episodeBox }) => {
        box = episodeBox;
        watch = new JobWatch({
          box: () => episodeBox as unknown as JobWatchBox,
          wake: async (agentId, conversation, text) => { bus.deliverSystem(agentId, text, conversation); },
          ended: (job, end) => noteJobEnd(ledger, job, end),
          log: () => {},
          mergeMs: 1,
          pollMs: 20,
        });
        return watch;
      },
      drive: async ({ bus, say }) => {
        await say("Build the site, please.");
        for (let i = 0; i < 300 && !(ledger.list()[0]?.attempt === 2 && wakes === 2); i += 1) await sleep(10);
        await bus.idle();
      },
    });
    const ada = episode.registry.list()[0]!.id;
    const bashCalls = episode.score.trail.filter(call => call === "Ada:bash").length;
    assert.equal(bashCalls, 2, "the agent ran it twice; the host never ran it a third time on its own");
    assert.match(episode.score.said.at(-1)?.text ?? "", /failed twice/);

    // The Issues view: one entry, counting 2, with the last reason.
    const deps = {
      ledger,
      readJson: async () => ({}),
      mayRead: () => true,
      refused: () => false,
      by: () => "Chris",
      titleOf: () => undefined,
      retry: exceptionRetryDeps({
        ledger,
        prompt: async () => undefined,
        boxFor: () => box,
        ownerOf: () => undefined,
        watch: job => watch!.watch(job),
        by: () => "Chris",
        redeliver: async () => ({ tried: 0, sent: 0 }),
        runRoutine: async () => ({ ok: true }),
        reconnectBox: async () => ({ connected: true, detail: "" }),
      }),
    };
    const view = (await exceptionRoute("GET /api/exceptions", deps))!.body as { open: number; groups: { title: string; entries: { id: string; kind: string; attempt: number; reason: string; agent: string; subject: string }[] }[] };
    assert.equal(view.open, 1);
    assert.equal(view.groups.length, 1);
    const [entry] = view.groups[0]!.entries;
    assert.deepEqual({ kind: entry!.kind, attempt: entry!.attempt, agent: entry!.agent, subject: entry!.subject }, { kind: "job", attempt: 2, agent: ada, subject: BUILD });
    assert.equal(entry!.reason, "exit code 1: npm ERR! build failed");

    // A person presses Retry: the command runs again in Ada's own session, succeeds, and the entry is resolved.
    const retried = (await exceptionRoute("POST /api/exceptions/retry", { ...deps, readJson: async () => ({ id: entry!.id }) }))!.body as { ok: boolean; resolved?: boolean; entry: { resolution?: string; retriedBy?: string } };
    assert.equal(retried.ok, true);
    assert.equal(retried.resolved, true);
    assert.equal(retried.entry.resolution, "succeeded");
    assert.equal(retried.entry.retriedBy, "Chris");
    const after = (await exceptionRoute("GET /api/exceptions", deps))!.body as { open: number; groups: { entries: { resolvedAt?: string }[] }[] };
    assert.equal(after.open, 0);
    assert.ok(after.groups[0]!.entries[0]!.resolvedAt !== undefined, "kept on the view as history");
    episode.cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
