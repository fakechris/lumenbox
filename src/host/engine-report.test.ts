/**
 * INV-908: a delegation's outcome is the engine's own report. The fixtures are real output of the
 * pinned engines (claude 2.1.250, pi 0.85.1, opencode 1.18.25) run against a stub model server
 * that answered ok, 400, 401 or 500 — see docs/25 §INV-908.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegateEndedNote, judgeDelegate, parseEngineReport, readLogEnd, settleDelegate } from "./engine-report.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PendingWork } from "./pending-work.ts";

const fixture = (name: string) =>
  readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "engine-report", `${name}.jsonl`), "utf8");

test("claude: success is done, with its answer, usage and session", () => {
  const report = parseEngineReport("claude", fixture("claude-ok"))!;
  assert.equal(report.status, "completed");
  assert.equal(report.finalText, "probe ok");
  assert.deepEqual(report.usage, { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 });
  assert.match(report.sessionId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(judgeDelegate({ exitCode: 0, report }).outcome, "done");
});

test("claude: a result frame that says success but is_error is a failure (400)", () => {
  const report = parseEngineReport("claude", fixture("claude-400"))!;
  assert.equal(report.status, "failed");
  assert.match(report.detail ?? "", /Prompt is too long/);
  assert.equal(report.finalText, undefined, "a failure's text is its reason, not an answer");
  const judged = judgeDelegate({ exitCode: 1, report });
  assert.equal(judged.outcome, "failed");
  assert.match(judged.why, /claude reported a failure: Prompt is too long/);
});

test("claude: a 401 retried ten times and then reported, still a failure", () => {
  const report = parseEngineReport("claude", fixture("claude-401"))!;
  assert.equal(report.status, "failed");
  assert.match(report.detail ?? "", /Not logged in/);
});

test("claude: a missing thread to resume is a failure that says so", () => {
  const report = parseEngineReport("claude", fixture("claude-resume-missing"))!;
  assert.equal(report.status, "failed");
  assert.equal(report.resumeFailed, true);
  assert.match(report.detail ?? "", /No conversation found/);
});

test("claude: a turn limit reached is aborted, not failed", () => {
  const log = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, session_id: "s", errors: ["max turns"] });
  assert.equal(parseEngineReport("claude", log)!.status, "aborted");
  assert.equal(judgeDelegate({ exitCode: 1, report: parseEngineReport("claude", log) }).outcome, "aborted");
});

test("pi: done when its last answer stopped normally; a 400 or 500 is a failure though pi exits 0", () => {
  const ok = parseEngineReport("pi", fixture("pi-json-ok"))!;
  assert.equal(ok.status, "completed");
  assert.equal(ok.finalText, "probe ok");
  assert.deepEqual(ok.usage, { input: 11, output: 3, cacheRead: 0, cacheWrite: 0 });
  for (const name of ["pi-json-400", "pi-json-500"]) {
    const report = parseEngineReport("pi", fixture(name))!;
    assert.equal(report.status, "failed", name);
    assert.match(report.detail ?? "", /^(400|500) /, name);
    // The case the exit code hid: pi exited 0 on each of these.
    assert.equal(judgeDelegate({ exitCode: 0, report }).outcome, "failed", name);
  }
});

test("opencode: a step that stopped is done; an error event is a failure", () => {
  const ok = parseEngineReport("opencode", fixture("opencode-json-ok"))!;
  assert.equal(ok.status, "completed");
  assert.equal(ok.finalText, "probe ok");
  assert.ok(ok.usage !== undefined);
  const bad = parseEngineReport("opencode", fixture("opencode-json-400"))!;
  assert.equal(bad.status, "failed");
  assert.equal(bad.detail, "prompt is too long");
});

test("opencode: a run cut off after a tool-calls step has no completion report", () => {
  const cut = [
    { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
    { type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "tool-calls" } },
  ].map(event => JSON.stringify(event)).join("\n");
  assert.equal(parseEngineReport("opencode", cut), undefined);
});

test("no report: exit 0 is unknown, never done; a non-zero exit is a failure; usage stays absent", () => {
  // The text-mode log of today's presets: just the answer, no events.
  assert.equal(parseEngineReport("claude", "probe ok\n"), undefined);
  assert.equal(parseEngineReport("pi", ""), undefined);
  const unknown = judgeDelegate({ exitCode: 0, report: undefined });
  assert.equal(unknown.outcome, "unknown");
  assert.match(unknown.why, /no completion report/);
  assert.equal(judgeDelegate({ exitCode: 2, report: undefined }).outcome, "failed");
  const unread = judgeDelegate({ exitCode: 0, report: undefined, missing: "its log could not be read (too big)" });
  assert.equal(unread.outcome, "unknown");
  assert.match(unread.why, /^its log could not be read \(too big\), so the exit code 0 says nothing/);
  assert.equal(judgeDelegate({ exitCode: undefined, interrupted: true, report: undefined }).outcome, "unknown");
  assert.equal(judgeDelegate({ exitCode: 143, killed: true, report: undefined }).outcome, "aborted");
});

test("the report outranks the exit code both ways, and the exit code stays in the record", () => {
  const completed = parseEngineReport("claude", fixture("claude-ok"));
  const judged = judgeDelegate({ exitCode: 1, report: completed });
  assert.equal(judged.outcome, "done");
  assert.match(judged.why, /exit code 1/);
});

test("a line that is not an event is skipped, not a reason to lose the report", () => {
  const log = `Warning: something on the same stream\n${fixture("claude-ok")}\n{not json`;
  assert.equal(parseEngineReport("claude", log)!.status, "completed");
});

test("readLogEnd reads the last lines through the box, and says why when it cannot", async () => {
  const lines = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`);
  const asked: { startLine?: number; endLine?: number }[] = [];
  const box = {
    readFile: async (_path: string, range: { startLine?: number; endLine?: number } = {}) => {
      asked.push(range);
      const start = range.startLine ?? 1;
      const end = range.endLine ?? lines.length;
      return { path: "/log", content: lines.slice(start - 1, end).join("\n"), total_lines: lines.length, truncated: true };
    },
  };
  const read = await readLogEnd(box as never, "/log");
  assert.ok("text" in read);
  assert.ok(read.text.endsWith("line 1000"));
  assert.ok(!read.text.includes("line 600\n"), "only the end is read");
  const refused = await readLogEnd({ readFile: async () => { throw new Error("over the 8388608-byte read limit"); } } as never, "/log");
  assert.deepEqual(refused, { unreadable: "over the 8388608-byte read limit" });
});

test("settleDelegate: an engine that failed with exit 0 is recorded failed, with why and no invented usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-settle-"));
  try {
    const ledger = new PendingWork(join(dir, "pending-work.jsonl"));
    ledger.prepare({ agentId: "a1", kind: "delegate", parent: "main", child: "job-1", brief: "pi: fix it", data: { engine: "pi" } });
    const log = fixture("pi-json-400").split("\n");
    const box = { readFile: async (_p: string, range: { startLine?: number; endLine?: number } = {}) => ({ content: log.slice((range.startLine ?? 1) - 1, range.endLine ?? log.length).join("\n"), total_lines: log.length }) };
    const settled = await settleDelegate({ pendingWork: ledger, box: box as never }, { job_id: "job-1", exit_code: 0, log_path: "/log" });
    assert.equal(settled?.outcome, "failed");
    assert.match(settled?.why ?? "", /pi reported a failure: 400/);
    const committed = readFileSync(join(dir, "pending-work.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).find(entry => entry.event === "committed")!;
    assert.equal(committed.how, "failed");
    // pi counted no tokens on a refused request, and said so with zeros; a missing count would be absent.
    assert.deepEqual(committed.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: "engine-report" });
    // A second observer finds nothing open.
    assert.equal(await settleDelegate({ pendingWork: ledger, box: box as never }, { job_id: "job-1", exit_code: 0, log_path: "/log" }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settleDelegate: a thread the engine could not resume is dropped with the engine's reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-settle-"));
  try {
    const ledger = new PendingWork(join(dir, "pending-work.jsonl"));
    ledger.prepare({ agentId: "a1", kind: "delegate", parent: "main", child: "job-2", brief: "claude: continue", data: { engine: "claude" } });
    const log = fixture("claude-resume-missing");
    const dropped: [string, string][] = [];
    const settled = await settleDelegate(
      { pendingWork: ledger, box: { readFile: async () => ({ content: log, total_lines: 1 }) } as never, dropSession: (id, reason) => dropped.push([id, reason]) },
      { job_id: "job-2", exit_code: 1, log_path: "/log" }
    );
    assert.equal(settled?.outcome, "failed");
    assert.deepEqual(dropped, [["3f0c7a52-1111-4222-8333-944455556666", "No conversation found with session ID: 3f0c7a52-1111-4222-8333-944455556666"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the note says what happened and on whose word, one wording per outcome", () => {
  assert.match(delegateEndedNote("job-1", "pi: fix", { outcome: "done", why: "pi reported it completed (exit code 0)" }), /finished.*Pi reported it completed/);
  assert.match(delegateEndedNote("job-1", "pi: fix", { outcome: "failed", why: "pi reported a failure: 400" }), /failed.*Do not use its output as a result/);
  assert.match(delegateEndedNote("job-1", "pi: fix", { outcome: "aborted", why: "it was stopped before it finished" }), /stopped before it finished.*partial/);
  assert.match(delegateEndedNote("job-1", "pi: fix", { outcome: "unknown", why: "the engine gave no completion report" }), /whether it did the work is unknown.*Read its log/);
});

test("the orchestrator's job-end note is the engine's outcome, one wording each, and an unread log is unknown", async () => {
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { Orchestrator } = await import("./orchestrator.ts");
  const { SkillProvenance } = await import("./skill-provenance.ts");
  const { fakeModel } = await import("./testing/fake-model.ts");
  const dir = mkdtempSync(join(tmpdir(), "agentbox-note-"));
  // The orchestrator builds its default stores under the home; this test's home is the temp dir.
  process.env.AGENTBOX_HOME = dir;
  try {
    const registry = new AgentRegistry(join(dir, "agents"));
    const ada = registry.create({ name: "Ada" });
    const files = new Map<string, string>([
      ["/jobs/done.log", fixture("claude-ok")],
      ["/jobs/failed.log", fixture("pi-json-400")],
      ["/jobs/quiet.log", "probe ok\n"],
    ]);
    const box = {
      health: async () => ({ ok: true, resolution: undefined }),
      readFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`${path} does not exist`);
        return { path, content, total_lines: content.split("\n").length, truncated: false };
      },
    };
    const pendingWork = new PendingWork(join(dir, "pending-work.jsonl"));
    const orchestrator = new Orchestrator({
      registry,
      client: fakeModel(() => ({ id: "m", type: "message", role: "assistant", model: "fake", content: [], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as never),
      useBox: true,
      boxClient: box as never,
      inbox: null, turns: null, skillProvenance: new SkillProvenance(join(dir, "prov.jsonl")),
      hooks: null, claims: null, tasks: null, scopes: null, mcp: null,
      pendingWork,
    });
    assert.equal((await orchestrator.connectBox()).connected, true);
    const notes: string[] = [];
    orchestrator.bus.deliverSystem = ((_agent: string, text: string) => { notes.push(text); return 1; }) as never;
    const delegate = (child: string, engine: string) =>
      pendingWork.prepare({ agentId: ada.id, kind: "delegate", parent: "main", child, brief: `${engine}: work`, data: { engine } });
    delegate("job-done", "claude");
    delegate("job-failed", "pi");
    delegate("job-quiet", "claude");
    delegate("job-gone", "opencode");

    assert.equal(await orchestrator.noteJobEnded("job-done", { exit_code: 0, running: false, log_path: "/jobs/done.log" }), true);
    assert.equal(await orchestrator.noteJobEnded("job-failed", { exit_code: 0, running: false, log_path: "/jobs/failed.log" }), true);
    assert.equal(await orchestrator.noteJobEnded("job-quiet", { exit_code: 0, running: false, log_path: "/jobs/quiet.log" }), true);
    assert.equal(await orchestrator.noteJobEnded("job-gone", undefined), true);
    assert.equal(await orchestrator.noteJobEnded("job-done", { exit_code: 0, running: false, log_path: "/jobs/done.log" }), false, "settled once");

    assert.match(notes[0]!, /finished: job-done.*Claude reported it completed/);
    assert.match(notes[1]!, /failed: job-failed.*Pi reported a failure: 400.*exit code 0/);
    assert.match(notes[2]!, /whether it did the work is unknown: job-quiet.*no completion report/);
    assert.match(notes[3]!, /whether it did the work is unknown: job-gone.*could not be reached/);
  } finally {
    delete process.env.AGENTBOX_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage counts cache reads and writes apart, and every attempt pi retried, not only the last", () => {
  const claude = parseEngineReport("claude", JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s",
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 } }))!;
  assert.deepEqual(claude.usage, { input: 10, output: 4, cacheRead: 9000, cacheWrite: 300 });
  const message = (input: number) => ({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", usage: { input, output: 1, cacheRead: 2, cacheWrite: 0 } } });
  const retried = [
    message(5),
    { type: "agent_end", messages: [message(5).message], willRetry: true },
    message(7),
    { type: "agent_end", messages: [{ ...message(7).message, stopReason: "stop", content: [{ type: "text", text: "done" }] }], willRetry: false },
  ].map(event => JSON.stringify(event)).join("\n");
  const pi = parseEngineReport("pi", retried)!;
  assert.equal(pi.status, "completed");
  assert.deepEqual(pi.usage, { input: 12, output: 2, cacheRead: 4, cacheWrite: 0 });
});

test("a log too big for the file read is read by its last bytes", async () => {
  const commands: string[] = [];
  const box = {
    exec: async (command: string) => { commands.push(command); return { stdout: `{"cut line\n${fixture("claude-ok")}`, stderr: "", exit_code: 0 }; },
    readFile: async () => { throw new Error("/log is 9000000 bytes, over the 8388608-byte read limit"); },
  };
  const read = await readLogEnd(box as never, "/home/box/work/.jobs/it's.log");
  assert.ok("text" in read);
  assert.equal(parseEngineReport("claude", read.text)?.status, "completed", "the cut first line is skipped");
  assert.match(commands[0]!, /^tail -c \d+ -- '\/home\/box\/work\/\.jobs\/it'\\''s\.log'$/);
});

test("a delegated job stopped with Jobs kill is recorded aborted, though the kill returns before the close", async () => {
  const { dispatchTool } = await import("./tools.ts");
  const dir = mkdtempSync(join(tmpdir(), "agentbox-kill-"));
  try {
    const ledger = new PendingWork(join(dir, "pending-work.jsonl"));
    ledger.prepare({ agentId: "a1", kind: "delegate", parent: "main", child: "job-k", brief: "claude: long work", data: { engine: "claude" } });
    const box = {
      killJob: async () => ({ job_id: "job-k", running: true, log_path: "/jobs/k.log", command: "claude", log_bytes: 0 }),
      waitForJob: async () => ({ job_id: "job-k", reason: "exited", running: false, exit_code: 1, log_path: "/jobs/k.log", log_bytes: 0, tail: "" }),
      exec: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
      readFile: async () => ({ content: "", total_lines: 1 }),
    };
    const context = { agent: { id: "a1", profile: { name: "Ada" } }, registry: {} as never, bus: {} as never, box, pendingWork: ledger } as unknown as Parameters<typeof dispatchTool>[2];
    await dispatchTool("Jobs", { action: "kill", job_id: "job-k" }, context);
    const committed = readFileSync(join(dir, "pending-work.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.event === "committed");
    assert.deepEqual(committed.map(entry => entry.how), ["aborted"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
