/**
 * INV-861: host-only tools and the effects a tool result may ask for. Real policy gate, real
 * pending-work ledger, real in-process server; the only fakes are the inbox and the clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effects, parseEffects } from "./effects.ts";
import { Extensions } from "./extensions.ts";
import { McpManager, VirtualServer, type VirtualToolEntry } from "./mcp.ts";
import { PendingWork } from "./pending-work.ts";
import { PolicyGate } from "./policy.ts";

function harness(entries: VirtualToolEntry[], clock = { now: new Date("2026-09-29T08:00:00Z") }) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-effects-"));
  const mcp = new McpManager([]);
  mcp.setVirtual(new VirtualServer("ext", entries));
  const policy = new PolicyGate({
    path: join(dir, "policy.jsonl"),
    limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] },
    spentSince: () => 0,
  });
  const delivered: { agentId: string; text: string; conversation: string }[] = [];
  const ledgerPath = join(dir, "pending-work.jsonl");
  const make = () =>
    new Effects({
      pendingWork: new PendingWork(ledgerPath),
      policy,
      mcp: () => mcp,
      deliver: (agentId, text, conversation) => {
        delivered.push({ agentId, text, conversation });
        return true;
      },
      now: () => clock.now,
    });
  return { dir, mcp, policy, delivered, effects: make(), restart: make, ledger: () => new PendingWork(ledgerPath), clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const agent = { agentId: "ada", agentName: "Ada", conversation: "main" };

test("a host-only tool is out of every list the model reads, and only the harness can call it", async () => {
  const h = harness([
    { name: "publish", description: "Publish the site.", inputSchema: { type: "object" }, run: async () => "ok" },
    { name: "_resume", description: "Harness callback.", inputSchema: { type: "object" }, hostOnly: true, run: async () => "resumed" },
  ]);
  try {
    assert.deepEqual(h.mcp.tools().map(tool => tool.name), ["ext__publish"]);
    assert.doesNotMatch(h.mcp.describeTools(), /_resume/);
    assert.equal(h.mcp.describeTools({ tool: "ext___resume" }), "No tool named ext___resume.");
    await assert.rejects(h.mcp.call("ext___resume", {}), /called by the harness, not by agents/);
    await assert.rejects(h.mcp.callDetailed("ext___resume", {}), /called by the harness, not by agents/);
    assert.deepEqual(await h.mcp.callFromHost("ext___resume", {}), { text: "resumed" });
  } finally { h.cleanup(); }
});

test("a configured MCP server's hostOnlyTools are hidden the same way", () => {
  const mcp = new McpManager([{ name: "crm", command: "true", hostOnlyTools: ["_sync"] }]);
  try {
    assert.equal(mcp.isHostOnly("crm___sync"), true);
    assert.equal(mcp.isHostOnly("crm__lookup"), false);
  } finally { mcp.stop(); }
});

test("effects are a closed set: malformed and unknown entries are dropped with a reason", () => {
  const { effects, problems } = parseEffects([
    { type: "pause_turn", reason: "Publish to production?", resumeTool: "_resume", resumeInput: { site: "a" } },
    { type: "pause_turn", reason: "" },
    { type: "run_shell", command: "rm -rf /" },
    { type: "reminder", text: "check the deploy", at: "2026-09-30T09:00:00Z" },
  ]);
  assert.deepEqual(effects.map(effect => effect.type), ["pause_turn", "reminder"]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /unknown effect "run_shell" ignored/);
  assert.deepEqual(parseEffects("nope"), { effects: [], problems: ["effects must be a list"] });
});

test("pause_turn asks the person; the answer runs the callback once and the agent hears what it said", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness([
    {
      name: "_resume", description: "", inputSchema: { type: "object" }, hostOnly: true,
      run: async input => { calls.push(input); return `published ${String(input.site)}`; },
    },
  ]);
  try {
    const applied = h.effects.apply({ ...agent, tool: "ext__publish", effects: [{ type: "pause_turn", reason: "Publish site a to production?", resumeTool: "_resume", resumeInput: { site: "a" } }] });
    assert.ok(applied.approval);
    assert.match(applied.notes.join(" "), /End your turn now/);
    const waiting = h.policy.pending();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]!.description, "Publish site a to production?");
    assert.equal(waiting[0]!.harnessResumes, true);

    assert.equal(h.policy.grant(waiting[0]!.id), true);
    assert.equal(await h.effects.settleApproval(waiting[0]!.id, "allowed"), true);
    assert.deepEqual(calls, [{ site: "a", approved: true }]);
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.text, /they confirmed\.\] published a/);
    assert.equal(h.delivered[0]!.conversation, "main");

    // Settled once: a second answer finds nothing waiting.
    assert.equal(await h.effects.settleApproval(waiting[0]!.id, "allowed"), false);
    assert.equal(calls.length, 1);
    assert.equal(h.ledger().open().length, 0);
  } finally { h.cleanup(); }
});

test("a declined pause passes approved: false", async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness([{ name: "_resume", description: "", inputSchema: {}, hostOnly: true, run: async input => { calls.push(input); return "left as draft"; } }]);
  try {
    const { approval } = h.effects.apply({ ...agent, tool: "ext__publish", effects: [{ type: "pause_turn", reason: "Publish?", resumeTool: "_resume" }] });
    h.policy.deny(approval!.id);
    await h.effects.settleApproval(approval!.id, "refused");
    assert.deepEqual(calls, [{ approved: false }]);
    assert.match(h.delivered[0]!.text, /they declined\.\] left as draft/);
  } finally { h.cleanup(); }
});

test("a callback must be a host-only tool of the same server", () => {
  const h = harness([{ name: "visible", description: "", inputSchema: {}, run: async () => "x" }]);
  try {
    const applied = h.effects.apply({ ...agent, tool: "ext__publish", effects: [
      { type: "pause_turn", reason: "Go?", resumeTool: "visible" },
      { type: "background_job", jobId: "j1", resumeTool: "missing" },
    ] });
    assert.equal(applied.approval, undefined);
    assert.equal(h.policy.pending().length, 0);
    assert.equal(h.ledger().open().length, 0);
    assert.equal(applied.notes.length, 2);
  } finally { h.cleanup(); }
});

test("a background job survives a restart: the sweep hands it back, jobDone delivers once", async () => {
  const recovered: Record<string, unknown>[] = [];
  const h = harness([{ name: "_recover", description: "", inputSchema: {}, hostOnly: true, run: async input => { recovered.push(input); return "picked up"; } }]);
  try {
    const applied = h.effects.apply({ ...agent, tool: "ext__render", effects: [{ type: "background_job", jobId: "render-7", resumeTool: "_recover", brief: "render the report" }] });
    assert.match(applied.notes.join(" "), /render-7 is running/);

    const afterRestart = h.restart();
    assert.deepEqual(await afterRestart.recover(), { resumedJobs: 1, lostJobs: 0, closedPauses: 0 });
    assert.deepEqual(recovered, [{ jobId: "render-7", recovering: true }]);

    assert.equal(afterRestart.jobDone("ext", "render-7", "report.pdf is ready"), true);
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!.text, /Background job render-7 \(render the report\) finished\] report\.pdf is ready/);
    assert.equal(afterRestart.jobDone("ext", "render-7", "again"), false);
    assert.equal(h.delivered.length, 1);
  } finally { h.cleanup(); }
});

test("a background job whose callback is gone after a restart is reported lost, not left open", async () => {
  const h = harness([{ name: "_recover", description: "", inputSchema: {}, hostOnly: true, run: async () => "x" }]);
  try {
    h.effects.apply({ ...agent, tool: "ext__render", effects: [{ type: "background_job", jobId: "j", resumeTool: "_recover" }] });
    h.mcp.setVirtual(new VirtualServer("ext", []));
    assert.deepEqual(await h.restart().recover(), { resumedJobs: 0, lostJobs: 1, closedPauses: 0 });
    assert.match(h.delivered[0]!.text, /was lost in a restart/);
    assert.equal(h.ledger().open().length, 0);
  } finally { h.cleanup(); }
});

test("a pause whose approval no longer waits after a restart is reported and closed", async () => {
  const h = harness([{ name: "_resume", description: "", inputSchema: {}, hostOnly: true, run: async () => "x" }]);
  try {
    const { approval } = h.effects.apply({ ...agent, tool: "ext__publish", effects: [{ type: "pause_turn", reason: "Go?", resumeTool: "_resume" }] });
    // Still waiting: recovery leaves it for the person.
    assert.deepEqual(await h.restart().recover(), { resumedJobs: 0, lostJobs: 0, closedPauses: 0 });
    h.policy.deny(approval!.id);
    assert.deepEqual(await h.restart().recover(), { resumedJobs: 0, lostJobs: 0, closedPauses: 1 });
    assert.match(h.delivered[0]!.text, /no longer waiting after a restart/);
  } finally { h.cleanup(); }
});

test("a reminder is delivered once when due, and survives a restart; one past a year is refused", () => {
  const h = harness([]);
  try {
    const set = h.effects.apply({ ...agent, tool: "ext__notes", effects: [
      { type: "reminder", text: "check the deploy", at: "2026-09-29T09:00:00Z" },
      { type: "reminder", text: "too far", at: "2028-01-01T00:00:00Z" },
    ] });
    assert.match(set.notes[0]!, /Reminder set for 2026-09-29T09:00:00.000Z/);
    assert.match(set.notes[1]!, /not a time within a year/);

    assert.equal(h.effects.deliverDue(), 0);
    h.clock.now = new Date("2026-09-29T09:00:30Z");
    const afterRestart = h.restart();
    assert.equal(afterRestart.deliverDue(), 1);
    assert.equal(afterRestart.deliverDue(), 0);
    assert.deepEqual(h.delivered.map(entry => entry.text), ["[Reminder you set: check the deploy]"]);
  } finally { h.cleanup(); }
});

test("an extension registers a host-only tool and returns effects; jobDone reaches the runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-ext-effects-"));
  try {
    const file = join(dir, "publisher.mjs");
    writeFileSync(
      file,
      `export default function (api) {
         api.tool({ name: "publish", description: "Publish.", run: () => ({ text: "staged", effects: [
           { type: "pause_turn", reason: "Publish?", resumeTool: "_resume" }, { type: "bogus" } ] }) });
         api.tool({ name: "_resume", description: "cb", hostOnly: true, run: input => "done " + input.approved });
         api.tool({ name: "done", description: "Report.", run: () => String(api.jobDone("j1", "all good")) });
       }`
    );
    chmodSync(file, 0o644);
    const lines: string[] = [];
    const extensions = new Extensions(dir, line => lines.push(line));
    const jobs: string[] = [];
    extensions.onJobDone = (jobId, text) => { jobs.push(`${jobId}:${text}`); return true; };
    await extensions.load();
    const mcp = new McpManager([]);
    mcp.setVirtual(extensions.server());
    assert.deepEqual(mcp.tools().map(tool => tool.name).sort(), ["ext__done", "ext__publish"]);
    const result = await mcp.callDetailed("ext__publish", {});
    assert.equal(result.text, "staged");
    assert.deepEqual(result.effects?.map(effect => effect.type), ["pause_turn"]);
    assert.ok(lines.some(line => /unknown effect "bogus" ignored/.test(line)));
    assert.deepEqual(await mcp.callFromHost("ext___resume", { approved: true }), { text: "done true" });
    assert.equal((await mcp.callDetailed("ext__done", {})).text, "true");
    assert.deepEqual(jobs, ["j1:all good"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
