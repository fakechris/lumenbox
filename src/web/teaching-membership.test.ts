import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { TeachDrafts } from "../host/teach-drafts.ts";
import { startWebServer } from "./server.ts";

const PORT = 7988;
const BASE = `http://127.0.0.1:${PORT}`;

test("a named administrator must belong to the captured teaching box", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-teaching-membership-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const sharedAgent = registry.create({ name: "SharedTeacher" });
    const privateBox = registry.attachBox({ id: "box-private", name: "private", kind: "attached",
      endpoint: { baseUrl: "http://127.0.0.1:1", tokenFile: join(home, "unused.token") },
      displayFloor: 1, workDir: "/home/box/work", members: ["another-person"], createdAt: "2026-09-01T00:00:00.000Z" });
    const privateAgent = registry.create({ name: "PrivateTeacher", boxId: privateBox.id });
    const drafts = new TeachDrafts(join(home, "skills-drafts"));
    const visible = drafts.create({ boxId: registry.box.id, agentId: sharedAgent.id,
      sessionId: "shared-session", eventsPath: "/unused/shared-events", skill: null, question: "A shared question" });
    const hidden = drafts.create({ boxId: privateBox.id, agentId: privateAgent.id,
      sessionId: "private-session", eventsPath: "/unused/private-events", skill: null, question: "A private question" });
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "fixture-admin-token", useBox: false, onLog: () => {} });
    const operatorHeaders = { "content-type": "application/json", authorization: "Bearer fixture-admin-token" };
    const invite = await (await fetch(`${BASE}/api/channels/invite`, { method: "POST", headers: operatorHeaders,
      body: JSON.stringify({ role: "admin" }) })).json() as { code: string };
    const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: invite.code, name: "NamedAdmin" }) });
    assert.equal(login.status, 200);
    const namedHeaders = { "content-type": "application/json", cookie: login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
    const list = await (await fetch(`${BASE}/api/teaching-drafts`, { headers: namedHeaders })).json() as { drafts: { id: string }[] };
    assert.deepEqual(list.drafts.map(draft => draft.id), [visible.id]);
    for (const action of ["clarify", "approve", "reject"]) {
      const response = await fetch(`${BASE}/api/teaching-drafts/${action}`, { method: "POST", headers: namedHeaders,
        body: JSON.stringify({ id: hidden.id, digest: hidden.digest, answer: "Do it" }) });
      assert.equal(response.status, 403, `${action} must not cross captured box membership`);
      assert.equal(drafts.get(hidden.id).status, "draft");
    }
    const operatorList = await (await fetch(`${BASE}/api/teaching-drafts`, { headers: operatorHeaders })).json() as { drafts: { id: string }[] };
    assert.equal(operatorList.drafts.length, 2, "the installation credential remains an explicit administrator");
    const rejected = await fetch(`${BASE}/api/teaching-drafts/reject`, { method: "POST", headers: operatorHeaders,
      body: JSON.stringify({ id: hidden.id, digest: hidden.digest }) });
    assert.equal(rejected.status, 200);
    assert.equal(drafts.get(hidden.id).status, "rejected");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
