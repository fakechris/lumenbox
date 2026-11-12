/** Isolated historical inbox and deferred callbacks. No model, box or external send. */
import { AgentRegistry } from "../src/agents/registry.ts";
import { Inbox } from "../src/agents/inbox.ts";
import type { InboundMessage } from "../src/agents/admitted-message.ts";
import { writePause } from "../src/agents/pause.ts";
import { Principals } from "../src/host/principals.ts";
import { TaskStore } from "../src/host/tasks.ts";
import { PendingWork } from "../src/host/pending-work.ts";
import { Deliveries } from "../src/host/deliveries.ts";
import { startWebServer } from "../src/web/server.ts";
import { agentboxHome } from "../src/config.ts";
import { join } from "node:path";
new Principals().save([{ id: "layout-viewer", name: "Work operator", role: "admin", identities: ["web:layout-viewer"] }]);
const registry = new AgentRegistry(join(agentboxHome(), "agents")), worker = registry.create({ name: "Mia" }), other = registry.create({ name: "Nova" });
writePause(registry.dirFor(worker.id), { by: "fixture", at: new Date().toISOString(), reason: "Keep all historical messages held without running any model" });
const tasks = new TaskStore(join(agentboxHome(), "tasks.jsonl"));
for (let n = 0; n < 1600; n++) tasks.create({ title: `Legacy installation ${n} · 旧安装工作`, requester: "web:layout-viewer", assigneeId: worker.id, conversation: "main" });
for (let n = 0; n < 20; n++) { const task = tasks.create({ title: `Ended internal probe ${n}`, requester: "web:layout-viewer", assigneeId: worker.id, origin: { kind: "internal" } })!; tasks.update(task.id, { status: "dropped" }, "web:layout-viewer"); }
const inbox = new Inbox<InboundMessage>(join(agentboxHome(), "inbox.jsonl"));
for (let n = 0; n < 80; n++) inbox.admit(worker.id, { id: `held-message-${n}`, fromId: "system", fromName: "system", text: `Historical callback ${n}`, synthetic: true, origin: "host:legacy-fixture", conversation: "main", priority: false, receivedAt: new Date().toISOString() });
const pending = new PendingWork(join(agentboxHome(), "pending-work.jsonl"));
pending.prepare({ kind: "reminder", agentId: worker.id, parent: "main", child: "reminder", brief: "Old collaboration reminder · 旧协作提醒", data: { at: "2099-01-01T00:00:00Z", text: "Deferred synthetic note" } });
const deliveries = new Deliveries(join(agentboxHome(), "deliveries.jsonl"));
for (let n = 0; n < 150; n++) deliveries.open({ id: `old-reply-${n}`, chatKey: "fixture:never-send", conversation: "main", agentId: worker.id, before: 0, at: "2026-01-01T00:00:00Z", requestTitle: `Old reply ${n} · 旧回复` });
let base = "";
const stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, token: "layout-fixture", onLog: () => {}, onReady: url => { base = url; } });
process.stdout.write(JSON.stringify({ base, agent: worker.id, other: other.id }) + "\n");
process.on("SIGTERM", () => { stop(); process.exit(); });
