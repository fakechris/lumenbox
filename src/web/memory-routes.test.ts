/**
 * The memory routes (INV-426) through the real server: a driver sees the agents in the
 * boxes they are in — and not one in a box they are not, which is what replaced the
 * retired per-agent `visibility` (INV-540, docs/22 §3); a viewer cannot read what agents
 * remember about people at all; a stale version is a 409 with the current line; and a
 * change is recalled by the next read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { startWebServer } from "./server.ts";

const PORT = 7931;
const BASE = `http://127.0.0.1:${PORT}`;

test("memory is browsed by what the caller may drive, changed with a version, refused when stale", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-memory-routes-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    // In a box of its own, whose members will not include Dana: the box is the boundary.
    const other = registry.attachBox({
      id: "box-other",
      name: "finance",
      kind: "attached",
      endpoint: { baseUrl: "http://127.0.0.1:1", tokenFile: join(home, "unused.token") },
      displayFloor: 1,
      workDir: "/home/box/work",
      members: ["nobody-here"],
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const secret = registry.create({ name: "Secret", boxId: other.id }).id;
    registry.appendMemoryRecords(ada, [{ at: "2026-09-01T00:00:00.000Z", kind: "fact", text: "the deploy region is eu-west-1", from: ["message:region"] }]);
    registry.appendMemoryRecords(secret, [{ at: "2026-09-01T00:00:00.000Z", kind: "fact", text: "a private thing" }]);

    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const signIn = async (role: string, name: string): Promise<string> => {
      const invite = (await (await fetch(`${BASE}/api/channels/invite`, { method: "POST", headers: ui, body: JSON.stringify({ role }) })).json()) as { code: string };
      const response = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, name }) });
      return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    };
    const dana = await signIn("driver", "Dana");
    const vic = await signIn("viewer", "Vic");
    const call = async (path: string, jar: string, body?: unknown) =>
      fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie: jar }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    // A1: an agent in a box Dana is not a member of is not in her summary, and not
    // openable by name. Before INV-540 this was a per-agent flag; authority lives on the
    // box, so the box answers it.
    const summary = (await (await call("/api/memory", dana)).json()) as { agents: { agentId: string; live: number }[] };
    assert.deepEqual(summary.agents.map(a => a.agentId), [ada]);
    assert.equal(summary.agents[0]?.live, 1);
    assert.equal((await call(`/api/memory/agent?agent=${secret}`, dana)).status, 403);
    assert.equal((await call("/api/memory/change", dana, { agent: secret, scope: "own", key: "private thing", version: "x" })).status, 403);
    assert.equal((await call("/api/memory/source", dana, { agent: secret, action: "preview", source: "message:region" })).status, 403);

    // A viewer can watch the room, not read what agents remember about people: 403 on the summary too.
    assert.equal((await call("/api/memory", vic)).status, 403);
    const detail = (await (await call(`/api/memory/agent?agent=${ada}`, dana)).json()) as { own: { key: string; version: string; text: string; status: string }[] };
    const line = detail.own[0]!;
    assert.equal((await call("/api/memory/change", vic, { agent: ada, scope: "own", key: line.key, version: line.version })).status, 403);

    // A2/A3: edit with the seen version; the same version again is a 409 carrying the current line.
    const edited = await call("/api/memory/change", dana, { agent: ada, scope: "own", key: line.key, version: line.version, text: "the deploy region is us-east-1" });
    assert.equal(edited.status, 200);
    const stale = await call("/api/memory/change", dana, { agent: ada, scope: "own", key: line.key, version: line.version });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { error: string; current: { text: string } | null };
    assert.equal(conflict.current, null, "the edit changed the value, so that key has no live line: said, not guessed");
    assert.match(conflict.error, /no longer live/);

    // A4: the next read shows the correction, and the old line as withdrawn — from the registry the turns read.
    const again = (await (await call(`/api/memory/agent?agent=${ada}`, dana)).json()) as { own: { text: string; status: string }[] };
    assert.deepEqual(again.own.map(v => [v.text, v.status]), [["the deploy region is eu-west-1", "retracted"], ["the deploy region is us-east-1", "live"]]);
    const previewResponse = await call("/api/memory/source", dana, { agent: ada, action: "preview", source: "message:region" });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { version: string; own: unknown[]; shared: unknown[] };
    assert.equal(preview.own.length, 1);
    assert.equal((await call("/api/memory/source", dana, { agent: ada, action: "withdraw", source: "message:region", version: "stale" })).status, 409);
    assert.equal((await call("/api/memory/source", dana, { agent: ada, action: "withdraw", source: "message:region", version: preview.version })).status, 200);
    const sourceGone = (await (await call(`/api/memory/agent?agent=${ada}`, dana)).json()) as { own: { text: string; status: string }[] };
    assert.equal(sourceGone.own.find(item => /us-east/.test(item.text))?.status, "retracted");
    const missing = await call("/api/memory/agent?agent=nobody", dana);
    assert.equal(missing.status, 404, "A5: a missing agent is distinguishable from an empty one");
  } finally {
    stop?.();
    process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
