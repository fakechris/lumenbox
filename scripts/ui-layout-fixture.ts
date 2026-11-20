import { TurnLedger } from "../src/host/resume.ts";
/** Anonymous, isolated production server for browser geometry checks. No model or box. */
import { AgentRegistry } from "../src/agents/registry.ts";
import { Principals } from "../src/host/principals.ts";
import { TaskStore } from "../src/host/tasks.ts";
import { startWebServer } from "../src/web/server.ts";
import { agentboxHome } from "../src/config.ts";
import { join } from "node:path";
import { buildWakePrompt } from "../src/host/prompt.ts";

new Principals().save([{ id: "layout-viewer", name: "Layout reader", role: "admin", identities: ["web:layout-viewer"] }]);
const registry = new AgentRegistry(join(agentboxHome(), "agents"));
const agent = registry.create({ name: "Nova" });
registry.appendTranscript(agent.id, { role: "assistant", text: "Anonymous layout fixture", at: new Date().toISOString() });
const tasks = new TaskStore(join(agentboxHome(), "tasks.jsonl"));
const task = tasks.create({ title: "Install the approved skill · 安装指定技能", requester: "web:layout-viewer", assigneeId: agent.id, conversation: "main", origin: { kind: "user" }, signOff: true, description: "## Expected result\nInstall the approved skill and retain the original files.\n\n- Verify the installed artifact\n- Return the loading evidence" })!;
tasks.deliveryCommand(task.id, "submit", agent.id, { evidence: ["Approved artifact and loading report"] });
if (process.argv.includes("--work-scale")) {
  for (let n = 1; n < 1600; n++) tasks.create({ title: `Target work ${n} · 用户工作`, requester: "web:layout-viewer", assigneeId: agent.id, conversation: "main", origin: { kind: "user" } });
  for (let n = 0; n < 10; n++) tasks.create({ title: `Internal probe fixture ${n}`, requester: agent.id, assigneeId: agent.id, conversation: "main", origin: { kind: "internal" } });
  registry.appendTranscript(agent.id, { role: "user", fromPerson: true, text: "Install the approved skill", at: new Date().toISOString() });
  registry.appendTranscript(agent.id, { role: "user", host: true, text: "Host-only execution context that must not be shown as the user's request", at: new Date().toISOString() });
  const turns = new TurnLedger(join(agentboxHome(), "turns.jsonl"));
  const scope = { id: "fixture-turn", workId: "fixture-work", agentId: agent.id, executionId: "fixture-execution", attempt: 1, boxId: registry.box.id, conversation: "main", contextEpoch: 0, taskBinding: { taskId: task.id, role: "executor" as const } };
  turns.begin({ ...scope, about: "Synthetic retained installation steps" });
  for (let n = 0; n < 2000; n++) {
    const call = { type: "tool_use", id: `fixture-call-${n}`, name: "read_file", input: { path: `skill-part-${n}.md` } };
    registry.appendTranscript(agent.id, { role: "assistant", kind: "blocks", turnId: scope.id, executionId: scope.executionId, blocks: [call] } as never);
    turns.observeExecution({ ...scope, event: "step", recordId: `fixture-start-${n}`, toolUseId: call.id, tool: call.name, phase: "start", at: new Date(1000 + n).toISOString() });
    registry.appendTranscript(agent.id, { role: "user", kind: "results", turnId: scope.id, executionId: scope.executionId, blocks: [{ type: "tool_result", tool_use_id: call.id, content: "Verified original file bytes " + n }] } as never);
    turns.observeExecution({ ...scope, event: "step", recordId: `fixture-end-${n}`, toolUseId: call.id, tool: call.name, phase: "end", isError: false, at: new Date(5000 + n).toISOString() });
  }
  turns.end(scope.id, "done");
}
if (process.argv.includes("--conversation")) {
  // A turn with steps and a delegation, then the teammate's replies and the answer (INV-1924): what the default level folds.
  const ada = registry.create({ name: "Ada" }), bob = registry.create({ name: "Bob" }), start = Date.parse("2026-11-20T09:00:00.000Z");
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString(), turnId = "fixture-conversation";
  registry.appendTranscript(ada.id, { role: "user", fromPerson: true, text: "Fix the export time zone and have Bob check it.", at: at(0) });
  registry.appendTranscript(ada.id, { role: "assistant", kind: "blocks", turnId, at: at(4), blocks: [
    { type: "text", text: "Looking at the export now." }, { type: "tool_use", id: "c1", name: "bash", input: { command: "npm test -- export" } },
  ] } as never);
  registry.appendTranscript(ada.id, { role: "user", kind: "results", turnId, at: at(70), blocks: [{ type: "tool_result", tool_use_id: "c1", content: "1 failing: DST offset" }] } as never);
  const calls = [
    { type: "tool_use", id: "c2", name: "read_file", input: { path: "src/export.ts" } },
    { type: "tool_use", id: "c3", name: "edit_file", input: { path: "src/export.ts", old: "offset = 0", new: "offset = zoneOffset(at)" } },
    { type: "tool_use", id: "c4", name: "edit_file", input: { path: "src/export.test.ts", old: "// dst", new: "test(\"dst\", () => {})" } },
    { type: "tool_use", id: "c5", name: "SendToAgent", input: { target_id: bob.id, text: "please check the DST branch of src/export.ts" } },
  ];
  calls.forEach((call, n) => {
    registry.appendTranscript(ada.id, { role: "assistant", kind: "blocks", turnId, at: at(80 + n * 90), blocks: [call] } as never);
    registry.appendTranscript(ada.id, { role: "user", kind: "results", turnId, at: at(120 + n * 90), blocks: [{ type: "tool_result", tool_use_id: call.id, content: "ok" }] } as never);
  });
  registry.appendTranscript(ada.id, { role: "assistant", turnId, text: "Fixed the DST branch in src/export.ts; Bob is checking it.", at: at(472) });
  const inbound = (text: string, n: number) => ({ id: `m${n}`, fromId: bob.id, fromName: "Bob", text, priority: false, receivedAt: at(500 + n) });
  registry.appendTranscript(ada.id, { role: "user", text: buildWakePrompt([inbound("Checked the DST branch: correct.", 1), inbound("One nit: the test name could say which zone.", 2)]), at: at(510) });
  registry.appendTranscript(ada.id, { role: "assistant", text: "Bob confirmed the fix. The export now keeps the time zone.", at: at(530) });
}
let base = "";
const stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, token: "layout-fixture", onLog: () => {}, onReady: url => { base = url; } });
process.stdout.write(JSON.stringify({ base, agent: agent.id, task: task.id }) + "\n");
process.on("SIGTERM", () => { stop(); process.exit(); });
