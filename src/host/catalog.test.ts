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
    assert.ok(!entry.tools.includes("CreateAgent"), `${entry.slug} must not build the team`);
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

test("installing a crew creates each member once, with catalog tools", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-catalog-"));
  const registry = new AgentRegistry(root);
  try {
    const rows = profilesFor("ship")!;
    const existing = new Set(registry.list().map(agent => agent.profile.name));
    for (const row of rows) {
      if (existing.has(row.name)) continue;
      registry.create({
        name: row.name,
        description: row.description,
        title: row.title,
        tools: [...row.tools],
      });
      existing.add(row.name);
    }
    const names = registry.list().map(agent => agent.profile.name).sort();
    assert.deepEqual(names, ["Heng", "Lin", "Mo"]);
    const lin = registry.list().find(agent => agent.profile.name === "Lin")!;
    assert.ok(lin.profile.tools?.includes("Delegate"));
    assert.ok(!lin.profile.tools?.includes("CreateAgent"));
    const again = profilesFor("ship")!;
    const skipped = again.filter(row => existing.has(row.name));
    assert.equal(skipped.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
