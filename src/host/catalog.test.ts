/**
 * The catalog is data, so the tests pin the properties that keep it from
 * rotting the way the marketplaces we read had: briefing-in-persona, frozen
 * tool names, crews that name missing people, tools that do not exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { ALL_TOOLS } from "./orchestrator.ts";
import { toolAllowed } from "./scopes.ts";
import {
  CATALOG_CONNECTORS,
  CATALOG_CREWS,
  CATALOG_EXPERTS,
  catalogDataDir,
  catalogMenu,
  crewNamed,
  expertNamed,
  hubSkillSlugs,
  intersectTools,
  profilesFor,
} from "./catalog.ts";

test("catalog experts are small, distinct, and standing identity", () => {
  assert.ok(CATALOG_EXPERTS.length >= 4 && CATALOG_EXPERTS.length <= 12);
  const slugs = CATALOG_EXPERTS.map(entry => entry.slug);
  const names = CATALOG_EXPERTS.map(entry => entry.name);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(new Set(names).size, names.length);

  for (const entry of CATALOG_EXPERTS) {
    assert.doesNotMatch(
      entry.description,
      /\b(start by|begin by|right now|currently|today|at the moment|for now)\b/i,
      `${entry.slug} reads like a briefing`
    );
    assert.doesNotMatch(
      entry.description,
      /SendToAgent|SetTodos|SetPlan|RememberFact|CreateAgent|Delegate/,
      `${entry.slug} names a tool`
    );
    assert.ok(entry.description.length > 400, `${entry.slug} is too thin to be a role`);
    assert.ok(entry.description.length < 8_000, `${entry.slug} is paid for on every turn`);
    assert.ok(entry.skills.length >= 2, `${entry.slug} is a persona plus skills, not a one-liner`);
    assert.ok(entry.summary.length > 20 && entry.summary.length < 160);
    for (const tool of entry.tools) {
      assert.ok(ALL_TOOLS.includes(tool), `${entry.slug} offers unknown tool ${tool}`);
    }
    // A connected service is usable by every expert but the reviewer (INV-759), which reviews
    // without the means to change what it reviews.
    assert.equal(toolAllowed(entry.tools, "anyservice__anytool"), entry.slug !== "heng", `${entry.slug} and MCP services`);
    // One exception, on purpose: the Team designer (docs/39 §3) exists to build the team,
    // and stays afterwards, quiet by default (Chris, 2026-09-08). Every other expert is a
    // worker and must not be able to grow the roster.
    if (entry.slug !== "designer") {
      assert.ok(!entry.tools.includes("CreateAgent"), `${entry.slug} must not build the team`);
    }
    assert.ok(!entry.tools.includes("computer"), `${entry.slug} does not need a desktop`);
  }
});

test("catalog experts differ in what they touch", () => {
  const by = (slug: string) => CATALOG_EXPERTS.find(entry => entry.slug === slug);
  assert.match(by("lin")?.description ?? "", /diagnose/);
  assert.match(by("heng")?.description ?? "", /code-review/);
  assert.match(by("mo")?.description ?? "", /grill-me/);
  assert.match(by("jian")?.description ?? "", /khazix-writer/);
  assert.match(by("he")?.description ?? "", /xiaohongshu-note/);
  assert.match(by("jing")?.description ?? "", /short-video-script/);
  assert.match(by("xi")?.description ?? "", /minimax-xlsx/);
  assert.ok(by("lin")?.tools.includes("Delegate"));
  assert.ok(!by("mo")?.tools.includes("Delegate"));
  assert.ok(!by("heng")?.tools.includes("Delegate"));
  assert.ok(!by("jing")?.tools.includes("WebSearch"));
});

test("crews name experts that exist, without duplicating the starter team", () => {
  const starter = new Set(["Ada", "Rex", "Ops", "Vera"]);
  for (const crew of CATALOG_CREWS) {
    assert.ok(crew.members.length >= 2);
    assert.equal(new Set(crew.members).size, crew.members.length);
    for (const member of crew.members) {
      const expert = expertNamed(member);
      assert.ok(expert, `${crew.slug} names missing expert ${member}`);
      assert.ok(!starter.has(expert!.name), `${crew.slug} would clone ${expert!.name}`);
    }
    const resolved = profilesFor(crew.slug);
    assert.equal(resolved?.length, crew.members.length);
  }
  assert.equal(crewNamed("nope"), undefined);
  assert.equal(profilesFor("nope"), undefined);
  assert.equal(profilesFor("lin")?.length, 1);
});

test("connectors are honest about what is missing", () => {
  assert.ok(CATALOG_CONNECTORS.some(entry => entry.slug === "mcp"));
  const mcp = CATALOG_CONNECTORS.find(entry => entry.slug === "mcp")!;
  assert.match(mcp.how, /Unconfigured means none|mcpServers/);
  const feishu = CATALOG_CONNECTORS.find(entry => entry.slug === "feishu")!;
  assert.match(feishu.how, /not writable|Not a full/i);
});

test("intersectTools never grants what the creator does not hold", () => {
  assert.deepEqual(intersectTools(["bash", "Delegate"], undefined), ["bash", "Delegate"]);
  assert.deepEqual(intersectTools(["bash", "Delegate"], ["bash"]), ["bash"]);
  assert.deepEqual(intersectTools(["bash"], ["Delegate"]), []);
});

test("bound skills exist on disk or as box adapters", () => {
  const hub = new Set(hubSkillSlugs());
  const adapters = new Set([
    "code-review",
    "wechat-longform",
    "xiaohongshu-note",
    "short-video-script",
    "data-brief",
  ]);
  assert.ok(hub.has("humanizer") && hub.has("khazix-writer") && hub.has("diagnose"));
  for (const expert of CATALOG_EXPERTS) {
    for (const slug of expert.skills) {
      assert.ok(
        hub.has(slug) || adapters.has(slug),
        `${expert.slug} binds missing skill ${slug}`
      );
    }
  }
  assert.ok(existsSync(join(catalogDataDir(), "experts", "lin.md")));
});

test("the CreateAgent menu names every slug", () => {
  const menu = catalogMenu();
  for (const entry of CATALOG_EXPERTS) assert.match(menu, new RegExp(`\\b${entry.slug}\\b`));
  for (const crew of CATALOG_CREWS) assert.match(menu, new RegExp(`\\b${crew.slug}\\b`));
});

// Through the route the New agent dialog calls, not a copy of its loop: the copy passed while
// the route forgot the team, and a crew landed under NO TEAM (INV-1680).
test("installing a crew creates each member once, on the crew's team, with catalog tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-catalog-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const { startWebServer } = await import("../web/server.ts");
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "catalog-fixture", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const install = async (slug: string) => {
      const response = await fetch(`${base}/api/catalog/install`, {
        method: "POST",
        headers: { authorization: "Bearer catalog-fixture", "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { created: { name: string }[]; skipped: string[] };
    };
    const first = await install("ship");
    assert.deepEqual(first.created.map(row => row.name).sort(), ["Heng", "Lin", "Mo"]);
    const agents = () => new AgentRegistry(join(home, "agents")).list();
    for (const name of ["Heng", "Lin", "Mo"]) {
      assert.deepEqual(agents().find(agent => agent.profile.name === name)?.profile.tags, ["ship"], `${name} is on the ship team`);
    }
    const lin = agents().find(agent => agent.profile.name === "Lin")!;
    assert.ok(lin.profile.tools?.includes("Delegate"));
    assert.ok(!lin.profile.tools?.includes("CreateAgent"));
    const again = await install("ship");
    assert.equal(again.created.length, 0);
    assert.equal(again.skipped.length, 3);
    const expert = CATALOG_EXPERTS.find(entry => !CATALOG_CREWS.some(crew => crew.members.includes(entry.slug)))!;
    const single = await install(expert.slug);
    const added = agents().find(agent => agent.profile.name === single.created[0]!.name)!;
    assert.deepEqual(added.profile.tags ?? [], [], "a single expert joins no team");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
