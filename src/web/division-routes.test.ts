/**
 * The division of work through the real server (INV-1667): a thread's forks are folded under it on
 * `/api/conversations`, a task's forks ride on it on `/api/tasks`, and a fork's thread refuses a
 * message from the page — nobody but the turn that forked it talks to a fork.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { AgentRegistry } from "../agents/registry.ts";
import { ForkEvents, forkEventsPath } from "../host/fork-events.ts";
import { TaskStore } from "../host/tasks.ts";
import { startWebServer } from "./server.ts";

const PORT = await new Promise<number>((resolve, reject) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port")))); });
});
const BASE = `http://127.0.0.1:${PORT}`;

test("forks are folded under the thread that started them, ride on their task, and their threads take no message from the page", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-division-routes-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    const at = new Date().toISOString();
    registry.appendTranscript(ada, { role: "user", text: "hello", at } as never, "feishu-oc_1");
    const task = new TaskStore(join(home, "tasks.jsonl")).create({ title: "price check", requester: "operator", assigneeId: ada, conversation: "main" })!;
    const forks = new ForkEvents(forkEventsPath(join(home, "pending-work.jsonl")));
    forks.spawned({ id: "pw-1", agentId: ada, parent: "main", child: "fork/main-k-1", brief: "find pricing", taskId: task.id });
    forks.spawned({ id: "pw-2", agentId: ada, parent: "main", child: "fork/main-k-2", brief: "tell the team", taskId: task.id });
    forks.spawned({ id: "pw-3", agentId: ada, parent: "feishu-oc_1", child: "fork/feishu-oc_1-k-1", brief: "read the doc" });
    forks.reported("pw-1", "done");
    forks.fenced(ada, "fork/main-k-2", "SendToAgent");

    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const headers = { "content-type": "application/json", authorization: "Bearer t0k" };
    const get = async (path: string) => (await fetch(`${BASE}${path}`, { headers })).json();

    const { conversations } = (await get(`/api/conversations?agent=${ada}`)) as { conversations: { id: string; forks?: { id: string; brief: string; status: string }[] }[] };
    const byId = Object.fromEntries(conversations.map(conversation => [conversation.id, conversation.forks?.map(fork => [fork.id, fork.status]) ?? []]));
    assert.deepEqual(byId, {
      main: [["fork/main-k-1", "done"], ["fork/main-k-2", "fenced"]],
      "feishu-oc_1": [["fork/feishu-oc_1-k-1", "running"]],
    }, "each thread carries its own children and no other's, and no child is a thread of its own");

    const { tasks } = (await get("/api/tasks")) as { tasks: { id: string; forks?: { brief: string; status: string }[] }[] };
    assert.deepEqual(tasks.find(entry => entry.id === task.id)?.forks?.map(fork => [fork.brief, fork.status]), [["find pricing", "done"], ["tell the team", "fenced"]]);

    const refused = await fetch(`${BASE}/api/prompt`, { method: "POST", headers, body: JSON.stringify({ agent: ada, conversation: "fork/main-k-1", text: "hi" }) });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "fork-read-only");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
