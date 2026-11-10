import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runEpisode } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";
import { newPursuit, VERIFIER_TOOLS } from "./goal-mode.ts";
import { progressScope, summarizeTaskProgress } from "./task-progress.ts";
import { taskRecord } from "../web/mcp-record.ts";
import { progressLines } from "./task-progress-view.ts";
import { taskProgressSurface } from "./task-progress-surface.ts";
import { surfaceCard } from "../channels/surface-card.ts";

function result(messages: readonly Anthropic.MessageParam[]): Record<string, any> {
  const texts = messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(block => block.type === "tool_result" ? typeof block.content === "string" ? [block.content] : (block.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []) : []) : []);
  return JSON.parse(texts.at(-1)!);
}

test("real task turns keep 70 objects, 3 failures and only 8 independently checked versions across the shared views", async () => {
  const tasks = new TaskStore(null);
  let taskId = "", phase = "executor", round = 0, descriptor: Record<string, any>, sourceId = "";
  let checked: { id: string; version: string }[] = [];
  let oldFile = "";
  const episode = await runEpisode({
    team: [{ name: "Nova", tools: ["TaskProgress", "Tasks", "read_file"] }], says: [], tasks,
    files: Object.fromEntries(Array.from({ length: 8 }, (_, n) => ["/home/box/work/object-" + n + ".txt", n < 3 ? "Recorded failure" : "Recorded success"])),
    script: ({ messages, offered }) => {
      assert.ok(offered.includes("TaskProgress"));
      const n = round++;
      if (n === 0) return { call: "TaskProgress", input: { action: "read", stage: phase === "executor" ? "processing" : "sample" } };
      if (phase === "executor") {
        if (n === 1) {
          descriptor = result(messages); sourceId = descriptor.sourceId;
          const input = { ...descriptor, action: "report", unit: "objects", total: 70, reportId: "executor-1", objects: Array.from({ length: 70 }, (_, index) => ({ id: "object-" + index, state: index < 3 ? "failed" : "succeeded", version: "v1" })) };
          oldFile = JSON.stringify({ ...input, observedAt: new Date().toISOString() });
          return { call: "TaskProgress", input };
        }
        return { say: "70 processed, including 3 failures. Verification remains separate." };
      }
      if (n === 1) { descriptor = result(messages); return { call: "TaskProgress", input: { action: "objects", sourceId } }; }
      if (n === 2) checked = result(messages).objects.slice(0, 8);
      if (n >= 2 && n < 10) return { call: "read_file", input: { path: "/home/box/work/" + checked[n - 2]!.id + ".txt" } };
      if (n === 10) return { call: "TaskProgress", input: { ...descriptor, action: "report", unit: "objects", total: null, reportId: "sample-1", objects: [], checks: checked.map(row => ({ sourceId, ...row })) } };
      return { say: "I checked 8 reported object versions; this does not accept all 70 objects." };
    },
    drive: async ({ bus, frontId }) => {
      const task = tasks.create({ title: "Inspect the collection", requester: "p", assigneeId: frontId, conversation: "main", pursuit: newPursuit({ objective: "Inspect 70 objects", workId: "business-work" }) })!;
      taskId = task.id;
      bus.sendFromUser(frontId, "Inspect the retained collection", { goal: { taskId, workId: "business-work", seq: 1, personSeq: 0, progressScope: progressScope(task) } });
      await bus.wake(frontId); await bus.idle();
      assert.equal(tasks.progress.file(oldFile, { agentId: frontId, conversation: "main", taskId }), false, "the finished executor cannot keep writing its file");
      tasks.setPursuit(taskId, pursuit => ({ ...pursuit, status: "verifying", verifying: { agentId: frontId, taskConversation: "main", conversation: "verification", attempt: 1, startedAt: new Date().toISOString() } }), "independent sample");
      phase = "verifier"; round = 0;
      bus.sendFromUser(frontId, "Check eight actual object files", { conversation: "verification", toolScope: VERIFIER_TOOLS, goal: { taskId, workId: "business-work", seq: 2, personSeq: 0, progressScope: progressScope(tasks.get(taskId)!), verify: { conversation: "verification", attempt: 1, confirmedCommands: [] } } });
      await bus.wake(frontId); await bus.idle();
    },
  });
  try {
    const task = tasks.get(taskId)!, summary = summarizeTaskProgress(task)!;
    assert.equal(summary.sources.find(source => source.source === "agent-reported")!.processed, 70);
    assert.equal(summary.sources.find(source => source.source === "agent-reported")!.failed, 3);
    assert.equal(summary.sources.find(source => source.source === "independent-verifier")!.verified, 8);
    assert.equal(episode.observations.filter(observation => observation.kind === "call" && observation.name === "read_file").length, 8);
    assert.equal(task.status, "doing"); assert.equal(task.pursuit!.status, "verifying");
    assert.deepEqual(taskRecord(task, { nameOf: id => id }).progress, summary);
    const messages = taskProgressSurface([{ version: "v0.9", updateComponents: { surfaceId: "progress", components: [{ id: "root", component: "TaskProgress", taskId, value: 100 }] } }], id => id === taskId ? summary : undefined, "en");
    const card = surfaceCard({ surfaceId: "progress", agentName: "Nova", messages });
    assert.deepEqual(card.lines, [progressLines(summary, "en").join("\n")]);
    assert.match(card.lines[0]!, /processed 70\/70.*failed 3/);
    assert.match(card.lines[0]!, /Version-matched independent checks 8/);
    assert.equal(card.lines[0]!.includes("100%"), false, "an agent's numeric prop cannot replace canonical task progress");
  } finally { episode.cleanup(); }
});
