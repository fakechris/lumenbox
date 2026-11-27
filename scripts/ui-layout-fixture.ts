import { TurnLedger } from "../src/host/resume.ts";
/** Anonymous, isolated production server for browser geometry checks. No model or box. */
// It writes a roster, tasks and an agent wherever AGENTBOX_HOME points, and without it that is the live installation:
// started by hand once, it replaced a person's roster with its one test admin (2026-11-26). Its callers pass a fresh one.
if (!process.env.AGENTBOX_HOME || process.env.AGENTBOX_HOME === join(homedir(), ".agentbox")) {
  process.stderr.write("ui-layout-fixture: set AGENTBOX_HOME to a fresh temporary directory; it writes a roster, tasks and an agent there.\n");
  process.exit(2);
}
import { AgentRegistry } from "../src/agents/registry.ts";
import { Principals } from "../src/host/principals.ts";
import { TaskStore } from "../src/host/tasks.ts";
import { startWebServer } from "../src/web/server.ts";
import { agentboxHome } from "../src/config.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildWakePrompt } from "../src/host/prompt.ts";
import { KubernetesBoxDriver } from "../src/box/kubernetes-box.ts";
import { KubeBoxes } from "../src/control/kube-box.ts";
import { staticDecision } from "../src/control/policy.ts";
import { fakeKubeApi } from "../src/control/testing/fake-kube.ts";

// --personal-boxes: two members with Kubernetes computers on a fake cluster, one stuck on its image (INV-2042).
const personal = process.argv.includes("--personal-boxes"), member = (id: string, name: string) => ({ id, name, role: "driver" as const, identities: [`web:${id}`] });
new Principals().save([{ id: "layout-viewer", name: "Layout reader", role: "admin", identities: ["web:layout-viewer"] },
  ...(personal ? [member("alice", "Alice"), member("bob", "Bob")] : [])]);
const cluster: { waitingReason?: string } = {}, image = "fakechris/lumenbox:0.4.9";
const personalBoxDriver = personal ? new KubernetesBoxDriver({ image, decision: staticDecision({}),
  boxes: new KubeBoxes({ api: fakeKubeApi(cluster).api, namespace: "fixture", defaultImage: () => image, pollIntervalMs: 1, startTimeoutMs: 50 }) }) : undefined;
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
if (process.argv.includes("--needs")) {
  // What waits on the person (INV-2189): something only they can do elsewhere, and a go-ahead with the agent's two outcomes.
  const act = tasks.create({ title: "Reconcile October · 十月对账", requester: "web:layout-viewer", assigneeId: agent.id, conversation: "main", origin: { kind: "user" } })!;
  tasks.update(act.id, { status: "blocked", note: "Please do: Sign in to the vendor portal and download the October invoice\nWhat happened: Reconciliation stopped at step 3.\nWhy you: The code goes to your phone.\nHow: Open the vendor portal and drop the PDF in inbox/.\nMeanwhile: Reconciling September.\nStill yours to check: The invoice header." }, agent.id);
  const release = tasks.create({ title: "Renewal notices · 续费通知", requester: "web:layout-viewer", assigneeId: agent.id, conversation: "main", origin: { kind: "user" } })!;
  tasks.update(release.id, { status: "blocked", options: ["Send it", "Don't send"], note: "Please approve: Send the renewal notice to 214 customers\nWhy you: It goes out under your name." }, agent.id);
}
let base = "";
const stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, token: "layout-fixture", onLog: () => {}, onReady: url => { base = url; },
  ...(personalBoxDriver ? { personalBoxDriver } : {}) });
if (personal) {
  const as = async (who: string, path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: "Bearer layout-fixture", "content-type": "application/json", "x-agentbox-user": `web:${who}` } });
    if (!response.ok) throw new Error(`${path} as ${who}: ${response.status} ${await response.text()}`);
  };
  await as("layout-viewer", "/api/quotas", { personBoxQuotas: { alice: 1, bob: 2 } });
  await as("alice", "/api/personal-boxes/create", { requestId: "alice-1", name: "Alice’s computer" });
  await as("bob", "/api/personal-boxes/create", { requestId: "bob-1", name: "Bob’s computer" });
  cluster.waitingReason = "ImagePullBackOff";
  await as("bob", "/api/personal-boxes/create", { requestId: "bob-2", name: "Bob’s second computer" });
}
process.stdout.write(JSON.stringify({ base, agent: agent.id, task: task.id }) + "\n");
process.on("SIGTERM", () => { stop(); process.exit(); });
