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
const task = tasks.create({ title: "Anonymous first work", requester: "web:layout-viewer", assigneeId: agent.id });
tasks.update(task.id, { status: "review" }, "web:layout-viewer");
let base = "";
const stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, token: "layout-fixture", onLog: () => {}, onReady: url => { base = url; } });
process.stdout.write(JSON.stringify({ base, agent: agent.id }) + "\n");
process.on("SIGTERM", () => { stop(); process.exit(); });
