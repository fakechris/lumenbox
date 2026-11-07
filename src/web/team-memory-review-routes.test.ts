/** The team memory review routes (INV-1581): admin only; the switch; what waits; a decision. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { forTeamTier } from "../host/team-memory-review.ts";
import { dedupe } from "../host/memory.ts";
import { teamMemoryReviewRoute } from "./team-memory-review-routes.ts";

test("admin only; the switch saves; what waits is listed with its writer; a decision makes it live", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-team-review-routes-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada" }), bob = registry.create({ name: "Bob" });
    let admin = false;
    let body: Record<string, unknown> = {};
    const call = (route: string) => teamMemoryReviewRoute(route, { registry, readJson: async () => body, refusedAdmin: () => !admin, by: () => "Chris", log: () => {} });

    assert.deepEqual(await call("GET /api/memory/team-review"), { status: 0, body: null }, "a non-admin is refused");
    assert.equal(await call("GET /api/memory/agent"), undefined, "other memory routes are not this module's");
    admin = true;
    body = { on: true };
    assert.equal(((await call("POST /api/memory/team-review/setting"))!.body as { on: boolean }).on, true);
    registry.appendSharedMemory(ada.id, forTeamTier([{ at: "2026-11-05T00:00:00.000Z", kind: "fact", text: "the release train leaves on Fridays" }], true));
    registry.appendSharedMemory(bob.id, forTeamTier([{ at: "2026-11-05T00:01:00.000Z", kind: "fact", text: "the person is called Chris" }], true));
    const listed = (await call("GET /api/memory/team-review"))!.body as Record<string, unknown> & { pending: { writer: string; writerName: string; version: string; text: string; boxName: string }[] };
    assert.deepEqual(listed.pending.map(p => [p.writerName, p.text, p.boxName]), [["Ada", "the release train leaves on Fridays", registry.box.name], ["Bob", "the person is called Chris", registry.box.name]], "each names the box that reads it once approved");
    assert.equal("everyone" in listed, false, "there is no every-box list: team memory is the box's (INV-1727)");
    body = { writer: ada.id, version: listed.pending[0]!.version, decision: "approved" };
    const decided = (await call("POST /api/memory/team-review/decide"))!;
    assert.equal(decided.status, 200);
    assert.equal((decided.body as { pending: unknown[] }).pending.length, 1);
    assert.deepEqual(dedupe(registry.readSharedMemory(bob.id)).map(r => r.text), ["the release train leaves on Fridays"]);
    body = { writer: bob.id, version: listed.pending[1]!.version, decision: "approved" };
    assert.equal((await call("POST /api/memory/team-review/decide"))!.status, 200);
    assert.deepEqual(dedupe(registry.readSharedMemory(ada.id)).map(r => r.text).sort(), ["the person is called Chris", "the release train leaves on Fridays"]);
    body = { writer: ada.id, version: listed.pending[0]!.version, decision: "approved" };
    assert.equal((await call("POST /api/memory/team-review/decide"))!.status, 409, "deciding twice is refused");
    body = { decision: "maybe" };
    assert.equal((await call("POST /api/memory/team-review/decide"))!.status, 400);
  } finally {
    process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
