/**
 * The standing-file routes (INV-777) through the real server: read the four, write one, refuse a
 * write over the cap and a name that is not one of the four, and refuse an agent the caller may
 * not drive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { readStanding, STANDING_BYTE_CAP } from "../host/standing.ts";
import { startWebServer } from "./server.ts";

const PORT = 7937;
const BASE = `http://127.0.0.1:${PORT}`;

test("standing files are read and written on the host through the agent's API, capped and named", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-standing-routes-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const headers = { "content-type": "application/json", authorization: "Bearer t0k" };
    const get = async (path: string) => fetch(`${BASE}${path}`, { headers });
    const post = async (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    const read = (await (await get(`/api/standing?agent=${ada}`)).json()) as { cap: number; files: Record<string, string> };
    assert.equal(read.cap, STANDING_BYTE_CAP);
    assert.deepEqual(Object.keys(read.files), ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"]);
    assert.match(read.files["USER.md"]!, /Call me:/);

    const wrote = await post("/api/standing", { agent: ada, name: "USER.md", text: "- Call me: Skipper\n" });
    assert.equal(wrote.status, 200);
    assert.equal(readStanding(registry.dirFor(ada), "Ada")["USER.md"], "- Call me: Skipper\n", "the host copy is what was written");

    const over = await post("/api/standing", { agent: ada, name: "SOUL.md", text: "x".repeat(STANDING_BYTE_CAP + 1) });
    assert.equal(over.status, 413);
    assert.match(((await over.json()) as { error: string }).error, /capped/);

    const wrongName = await post("/api/standing", { agent: ada, name: "notes.md", text: "" });
    assert.equal(wrongName.status, 400);
    assert.equal((await get("/api/standing?agent=nobody")).status, 404);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
