/** An agent's configuration versions (INV-1669): saved, compared, gone back to, and held by the turn that began under one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { changesFor, configDiff, ConfigVersions, permissionsInEffect } from "./config-versions.ts";

function world() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-config-versions-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Nova", boxId: registry.box.id, description: "Writes the weekly report." });
  return { registry, agent, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("each save that changes something is a version; the first save keeps what came before as version 1; an unchanged save is not one", () => {
  const { registry, agent, root, cleanup } = world();
  try {
    const before = registry.get(agent.id).profile;
    const after = registry.update(agent.id, { tools: ["read_file", "bash"], toolPermissions: { tools: { bash: "ask" } } }).profile;
    const v2 = registry.configVersions.saved(agent.id, after, "Chris", { before });
    assert.equal(v2.n, 2);
    assert.equal(v2.by, "Chris");
    assert.equal(registry.configVersions.get(agent.id, 1)?.by, "before version history");
    assert.equal(registry.configVersions.get(agent.id, 1)?.config.tools, undefined, "version 1 is the agent as it was: every tool");
    assert.equal(registry.configVersions.saved(agent.id, registry.get(agent.id).profile, "Chris").n, 2, "saving the same settings again is not a version");

    // On disk, read back by a fresh store: the history outlives the process.
    const reread = new ConfigVersions(id => join(root, id));
    assert.deepEqual(reread.list(agent.id).map(v => v.n), [1, 2]);
    assert.deepEqual(reread.get(agent.id, 2)?.config.toolPermissions, { tools: { bash: "ask" } });
  } finally { cleanup(); }
});

test("a diff says which tools went off, which ask, and which file's hash moved", () => {
  const changes = configDiff(
    { tools: ["bash", "browser_open", "read_file"], toolPermissions: { groups: { web: "ask" } }, standing: { SOUL: "aaaaaaaa11" } },
    { tools: ["bash", "read_file"], toolPermissions: { tools: { bash: "ask" } }, model: "big", standing: { SOUL: "bbbbbbbb22" } }
  );
  assert.deepEqual(changes, [
    { field: "tools off", before: "on", after: "off: browser_open" },
    { field: "web tools", before: "ask me", after: "default" },
    { field: "bash", before: "default", after: "ask me" },
    { field: "model", before: "provider default", after: "big" },
    { field: "SOUL.md", before: "aaaaaaaa", after: "bbbbbbbb" },
  ]);
});

test("going back to a version makes a new one with its settings and rewrites nothing", () => {
  const { registry, agent, cleanup } = world();
  try {
    const before = registry.get(agent.id).profile;
    registry.configVersions.saved(agent.id, registry.update(agent.id, { model: "big", tools: ["read_file"] }).profile, "Chris", { before });
    const v1 = registry.configVersions.get(agent.id, 1)!;
    const restored = registry.configVersions.saved(agent.id, registry.update(agent.id, changesFor(v1.config)).profile, "Chris", { restoredFrom: 1 });
    assert.equal(restored.n, 3);
    assert.equal(restored.restoredFrom, 1);
    assert.deepEqual(restored.config, v1.config, "the new version has the old one's settings");
    assert.equal(registry.get(agent.id).profile.model, undefined);
    assert.equal(registry.get(agent.id).profile.tools, undefined, "every tool again");
    assert.equal(registry.get(agent.id).profile.description, "Writes the weekly report.");
    assert.deepEqual(registry.configVersions.list(agent.id).map(v => v.n), [1, 2, 3], "history only grows");
    assert.equal(registry.configVersions.get(agent.id, 2)?.config.model, "big");
  } finally { cleanup(); }
});

test("a turn holds the version it began under; the task and the conversation record where they switched", () => {
  const { registry, agent, cleanup } = world();
  try {
    const t1 = registry.configVersions.beginTurn({ agentId: agent.id, profile: registry.get(agent.id).profile, turnId: "turn-1", conversation: "main", task: "t7" });
    assert.equal(t1.n, 1);
    assert.equal(t1.by, "as first seen");
    // A person sets bash to ask while turn-1 runs.
    registry.configVersions.saved(agent.id, registry.update(agent.id, { toolPermissions: { tools: { bash: "ask" } } }).profile, "Chris");
    assert.equal(permissionsInEffect(registry, agent.id, "turn-1"), undefined, "the running turn keeps what it began with");
    assert.deepEqual(permissionsInEffect(registry, agent.id, undefined), { tools: { bash: "ask" } }, "a call outside a turn reads the profile");
    registry.configVersions.release("turn-1");
    const t2 = registry.configVersions.beginTurn({ agentId: agent.id, profile: registry.get(agent.id).profile, turnId: "turn-2", conversation: "main", task: "t7" });
    assert.equal(t2.n, 2, "the next turn runs under the saved version, not a copy of it");
    assert.deepEqual(permissionsInEffect(registry, agent.id, "turn-2"), { tools: { bash: "ask" } });
    registry.configVersions.beginTurn({ agentId: agent.id, profile: registry.get(agent.id).profile, turnId: "turn-3", conversation: "main", task: "t7" });
    assert.deepEqual(registry.configVersions.usesFor(agent.id, "t7").map(use => [use.n, use.turn]), [[1, "turn-1"], [2, "turn-2"]], "a switch point per version, not a line per turn");
    assert.deepEqual(registry.configVersions.usesIn(agent.id, "main").map(use => use.n), [1, 2]);
  } finally { cleanup(); }
});

test("a turn handed a profile older than a save reuses that older version rather than minting a copy; a change outside Configure is named as one", () => {
  const { registry, agent, cleanup } = world();
  try {
    const stale = registry.get(agent.id).profile;
    registry.configVersions.saved(agent.id, registry.update(agent.id, { model: "big" }).profile, "Chris", { before: stale });
    assert.equal(registry.configVersions.beginTurn({ agentId: agent.id, profile: stale, turnId: "t", conversation: "main" }).n, 1);
    registry.update(agent.id, { model: "small" }); // the CLI, say
    const outside = registry.configVersions.beginTurn({ agentId: agent.id, profile: registry.get(agent.id).profile, turnId: "u", conversation: "main" });
    assert.equal(outside.n, 3);
    assert.equal(outside.by, "changed outside Configure");
    const soul = registry.configVersions.beginTurn({ agentId: agent.id, profile: registry.get(agent.id).profile, turnId: "v", conversation: "main", standing: { SOUL: "0123456789abcdef" } });
    assert.equal(soul.by, "standing files changed in the box");
  } finally { cleanup(); }
});

test("the History routes list each version with what it changed, compare two, and go back by making a new one", async () => {
  const { configVersionRoute } = await import("../web/config-version-routes.ts");
  const { registry, agent, cleanup } = world();
  try {
    const before = registry.get(agent.id).profile;
    registry.configVersions.saved(agent.id, registry.update(agent.id, { toolPermissions: { groups: { code: "ask" } } }).profile, "Chris", { before });
    const lines: string[] = [];
    const call = (route: string, query: string, body: Record<string, unknown> = {}, refused = false) =>
      configVersionRoute(route, new URL(`http://x/?${query}`), { registry, refused: () => refused, readJson: async () => body, by: () => "Ada", log: line => lines.push(line) });

    const listed = await call("GET /api/agents/config-versions", `agent=${agent.id}&conversation=main`) as { status: number; body: { current: number; versions: { n: number; changes: { field: string }[] }[]; switches: unknown[] } };
    assert.equal(listed.status, 200);
    assert.equal(listed.body.current, 2);
    assert.deepEqual(listed.body.versions.map(v => [v.n, v.changes.map(c => c.field)]), [[1, []], [2, ["code tools"]]]);
    assert.deepEqual(listed.body.switches, [], "no turn has run here yet");

    const diff = await call("GET /api/agents/config-versions/diff", `agent=${agent.id}&from=2&to=1`) as { body: { changes: { field: string; before: string; after: string }[] } };
    assert.deepEqual(diff.body.changes, [{ field: "code tools", before: "ask me", after: "default" }]);

    const restored = await call("POST /api/agents/config-versions/restore", "", { agent: agent.id, version: 1 }) as { status: number; body: { version: number } };
    assert.equal(restored.body.version, 3);
    assert.equal(registry.get(agent.id).profile.toolPermissions, undefined);
    assert.equal(registry.configVersions.get(agent.id, 3)?.by, "Ada");
    assert.match(lines[0]!, /went back to configuration version 1 as version 3/);

    assert.equal((await call("POST /api/agents/config-versions/restore", "", { agent: agent.id, version: 9 }))?.status, 404);
    assert.equal((await call("GET /api/agents/config-versions", `agent=${agent.id}`, {}, true))?.status, 0, "refused is answered by the caller's own refusal");
    assert.equal(await call("GET /api/elsewhere", ""), undefined);
  } finally { cleanup(); }
});
