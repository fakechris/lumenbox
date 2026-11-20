import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BoxClient } from "../box/client.ts";
import { TaskStore } from "./tasks.ts";
import type { ToolContext } from "./tools.ts";
import { reportAttention, reportCard, reportCounts, reportsDir, VerificationReports, verifyTool } from "./verification-report.ts";

const AGENT = "a-ada";

function setup() {
  const tasks = new TaskStore(join(mkdtempSync(join(tmpdir(), "agentbox-verify-")), "tasks.jsonl"));
  const task = tasks.create({ title: "Ship the export", requester: "p-chris", assigneeId: AGENT, conversation: "main" })!;
  const recorder: { started: number[]; stopped: (string | undefined)[]; failNext: boolean } = { started: [], stopped: [], failNext: false };
  const box = {
    startRecording: async ({ display }: { display: number }) => { recorder.started.push(display); return { id: "r1", display, file: "verify-1.mp4", path: "/home/box/work/recordings/verify-1.mp4", started_at: "" }; },
    stopRecording: async (display?: number, id?: string) => {
      if (recorder.failNext) { recorder.failNext = false; throw new Error("box unreachable"); }
      recorder.stopped.push(`${display}/${id}`); return { id: "r1", display: display ?? 0, file: "verify-1.mp4", path: "", started_at: "" };
    },
  } as unknown as BoxClient;
  const shown: { surface: string; components?: unknown }[] = [];
  const context = {
    agent: { id: AGENT, profile: { name: "Ada" } }, tasks, taskBinding: { taskId: task.id, role: "executor" }, box, displayIndex: 3, conversation: "main",
    showUI: async (input: { surface: string; components?: unknown }) => { shown.push(input); return { where: "in the app" }; },
  } as unknown as ToolContext;
  let clock = Date.UTC(2026, 10, 20, 9, 0, 0);
  const now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };
  return { tasks, task, context, recorder, shown, now, advance, store: new VerificationReports(reportsDir(tasks.path!)) };
}

const PLAN = {
  action: "plan", title: "Export to CSV", version: "abc1234",
  scenarios: [{ name: "Export", assertions: ["the button downloads a file", "the file has a header row"] }, { name: "Empty table", assertions: ["an empty table exports only the header"] }],
};

test("a report goes plan, start, check, finish; the host stamps each check's place in the recording", async () => {
  const { context, recorder, shown, now, advance, store } = setup();
  assert.match((await verifyTool(context, PLAN, now)).text, /Planned vr-[a-f0-9]{8}\. Assertions: s1 Export: s1\.a1, s1\.a2; s2 Empty table: s2\.a1/);
  assert.match((await verifyTool(context, { action: "check", assertion: "s1.a1", result: "pass", observed: "x" }, now)).text, /not recording yet/);
  await verifyTool(context, { action: "start" }, now);
  assert.deepEqual(recorder.started, [3], "its own desktop");
  advance(4_000);
  await verifyTool(context, { action: "check", assertion: "s1.a1", result: "pass", observed: "export.csv landed in Downloads" }, now);
  advance(6_000);
  await verifyTool(context, { action: "check", assertion: "s1.a2", result: "fail", observed: "the first row is data, there is no header" }, now);
  assert.match((await verifyTool(context, { action: "check", assertion: "s9.a1", result: "pass", observed: "x" }, now)).text, /no assertion s9\.a1/);
  advance(2_000);
  // A stop that does not reach the box leaves the report recording, so finishing can be tried again.
  recorder.failNext = true;
  assert.match((await verifyTool(context, { action: "finish", conclusion: "x" }, now)).text, /did not stop \(box unreachable\); vr-[a-f0-9]{8} is still recording/);
  assert.equal(store.list("a-ada")[0]!.state, "recording");
  const done = await verifyTool(context, { action: "finish", conclusion: "The export downloads; the header row is missing." }, now);
  assert.match(done.text, /1 passed, 1 failed, 1 not checked/);
  assert.deepEqual(recorder.stopped, ["3/r1"], "its own recording by identity, never one that replaced it");

  const [report] = store.list("a-ada");
  assert.equal(report!.state, "finished");
  assert.equal(report!.recording?.file, "verify-1.mp4");
  const [a1, a2] = report!.scenarios[0]!.assertions;
  assert.deepEqual([a1!.offsetMs, a2!.offsetMs], [4_000, 10_000]);
  assert.equal(a2!.observed, "the first row is data, there is no header");
  assert.equal(report!.scenarios[1]!.assertions[0]!.result, undefined, "an unchecked assertion is shown as such, never as passed");
  assert.deepEqual(reportCounts(report!), { passed: 1, failed: 1, unchecked: 1 });

  // The card's numbers come from the report, and it links to the report's page.
  assert.equal(shown.length, 1);
  const card = shown[0]!.components as { id: string; value?: string; to?: string }[];
  assert.equal(card.find(item => item.id === "failed")?.value, "1");
  assert.equal(card.find(item => item.id === "open")?.to, report!.id);
});

test("one report at a time per conversation, and the plan is refused without what it needs", async () => {
  const { context, now, recorder } = setup();
  assert.match((await verifyTool(context, { ...PLAN, version: "" }, now)).text, /version names/);
  assert.match((await verifyTool(context, { ...PLAN, scenarios: [{ name: "x", assertions: [] }] }, now)).text, /needs 1 to 30 facts/);
  assert.match((await verifyTool(context, { action: "start" }, now)).text, /Verify plan first/);
  await verifyTool(context, PLAN, now);
  assert.match((await verifyTool(context, PLAN, now)).text, /still planned; finish or abandon it first/);
  await verifyTool(context, { action: "start" }, now);
  assert.match((await verifyTool(context, { action: "abandon" }, now)).text, /Abandoned/);
  assert.equal(recorder.stopped.length, 1, "abandoning stops the recording");
  assert.match((await verifyTool(context, PLAN, now)).text, /Planned/);
});

test("a member keeps its last reports, and a finished one on work in review is on the person's list", async () => {
  const { tasks, task, store } = setup();
  const base = { agentId: AGENT, agentName: "Ada", conversation: "main", title: "t", version: "v", scenarios: [] };
  for (let i = 0; i < 5; i++) store.save({ ...base, id: `vr-0000000${i}`, state: "finished", createdAt: `2026-11-0${i + 1}T00:00:00Z`, finishedAt: `2026-11-0${i + 1}T00:00:00Z` });
  assert.equal(store.prune(AGENT, 3), 2);
  assert.deepEqual(store.list(AGENT).map(report => report.id), ["vr-00000004", "vr-00000003", "vr-00000002"]);

  store.save({
    ...base, id: "vr-0000000a", taskId: task.id, state: "finished", createdAt: "2026-11-10T00:00:00Z", finishedAt: "2026-11-10T00:00:00Z", conclusion: "Header missing.",
    scenarios: [{ id: "s1", name: "Export", assertions: [{ id: "s1.a1", fact: "f", result: "fail", observed: "o" }] }],
  });
  assert.deepEqual(reportAttention(store, tasks, () => true), [], "not while the work is still being done");
  const inReview = { get: (id: string) => (id === task.id ? { ...task, status: "review" as const } : undefined) };
  const [item] = reportAttention(store, inReview, () => true);
  assert.equal(item?.kind, "verification");
  assert.equal(item?.ref, "vr-0000000a");
  assert.match(item!.detail, /0 passed · 1 failed — Header missing\./);
  assert.deepEqual(reportAttention(store, inReview, () => false), [], "never a report of a member the person may not see");
  assert.equal(reportCard(store.get("vr-0000000a")!).find(item => item.id === "failed")?.tone, "danger");
});
