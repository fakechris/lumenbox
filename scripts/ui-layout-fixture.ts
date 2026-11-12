import { TurnLedger } from "../src/host/resume.ts";
/** Anonymous, isolated production server for browser geometry checks. No model or box. */
import { AgentRegistry } from "../src/agents/registry.ts";
import { Principals } from "../src/host/principals.ts";
import { TaskStore } from "../src/host/tasks.ts";
import { startWebServer } from "../src/web/server.ts";
import { agentboxHome } from "../src/config.ts";
import { join } from "node:path";

new Principals().save([{ id: "layout-viewer", name: "Layout reader", role: "admin", identities: ["web:layout-viewer"] }]);
const registry = new AgentRegistry(join(agentboxHome(), "agents"));
const agent = registry.create({ name: "Nova" });
registry.appendTranscript(agent.id, { role: "assistant", text: "Anonymous layout fixture", at: new Date().toISOString() });
const tasks = new TaskStore(join(agentboxHome(), "tasks.jsonl"));
const task = tasks.create({ title: "Install the approved skill · 安装指定技能", requester: "web:layout-viewer", assigneeId: agent.id, conversation: "main", origin: { kind: "user" }, description: "## Expected result\nInstall the approved skill and retain the original files.\n\n- Verify the installed artifact\n- Return the loading evidence" })!;
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
let base = "";
const stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, token: "layout-fixture", onLog: () => {}, onReady: url => { base = url; } });
process.stdout.write(JSON.stringify({ base, agent: agent.id, task: task.id }) + "\n");
process.on("SIGTERM", () => { stop(); process.exit(); });
