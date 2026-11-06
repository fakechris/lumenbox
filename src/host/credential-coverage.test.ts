/**
 * The check before work starts (INV-1666). The failure it exists for: a routine that needed GitHub
 * ran at 03:00, found no token halfway through, and waited on a "needs a secret" card until morning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialCoverage, EXPIRING_WITHIN_MS, missingLine, mountedSkills, needsOf, neededBy, type CoverageAgent, type CoverageWorld } from "./credential-coverage.ts";
import { parseSkillFile, skillFrom } from "./skills.ts";
import type { SecretView } from "./vault.ts";

const NOW = new Date("2026-11-06T09:00:00Z");
const ada: CoverageAgent = { id: "a1", name: "Ada" };
const world = (secrets: SecretView[] = [], extra: Partial<CoverageWorld> = {}): CoverageWorld => ({ secrets, servers: [], env: {}, now: NOW, ...extra });

function skill(frontmatter: string) {
  const built = skillFrom("pr-review", parseSkillFile(`---\nname: PR review\ndescription: Use when a pull request needs a review.\n${frontmatter}\n---\nReview it.`));
  assert.ok("skill" in built, "the fixture is a skill");
  return built.skill;
}

test("what is needed comes from the tool list, the skills' frontmatter and the box's bundles, each with who said so", () => {
  const agent: CoverageAgent = {
    ...ada,
    tools: ["read_file", "mcp:notion__search", "mcp:notion__create_page"],
    bundles: [{ name: "release", needs: { connectors: ["github"], secretIds: ["NPM_TOKEN"] } }],
  };
  const reviewer = skill("connectors: [github, mcp:linear]\nsecrets: GH_DEPLOY_KEY");
  assert.deepEqual(reviewer.needs, { connectors: ["github", "mcp:linear"], secrets: ["GH_DEPLOY_KEY"] });
  const needs = needsOf(agent, [reviewer]).map(need => `${need.kind} ${need.id} ← ${need.by.join(" + ")}`);
  assert.deepEqual(needs, [
    "connector mcp:notion ← Ada's tools",
    "connector github ← bundle release + skill pr-review",
    "secret NPM_TOKEN ← bundle release",
    "connector mcp:linear ← skill pr-review",
    "secret GH_DEPLOY_KEY ← skill pr-review",
  ]);
  assert.equal(skill("").needs, undefined, "a skill that names nothing needs nothing");
});

test("a skill is carried into a task when it is the agent's own or its box's bundle names it; a global one is not", () => {
  const own = { ...skill("connectors: github"), scope: "agent" as const, owner: "Ada" };
  const theirs = { ...own, slug: "theirs", owner: "Bo" };
  const global = { ...skill("connectors: github"), slug: "everyone" };
  const bundled = { ...global, slug: "bundled" };
  const carried = mountedSkills([own, theirs, global, bundled], { ...ada, bundles: [{ name: "b", needs: { skills: ["bundled"] } }] });
  assert.deepEqual(carried.map(entry => entry.slug), ["pr-review", "bundled"]);
});

test("a connector is present through a configured server, a live door or an OAuth connection granted to the agent — missing otherwise, with where to fix it", () => {
  const needs = { ...ada, tools: ["mcp:notion__search", "mcp:gmail__send"], bundles: [{ name: "b", needs: { connectors: ["github", "mcp:figma"] } }] };
  const github: SecretView = { id: "oauth:github", description: "", grants: [{ holder: "agent:a1" }], oauth: { provider: "github", kind: "authorization_code" } };
  const coverage = credentialCoverage(needs, [], world([github], { servers: ["mcp:notion"], env: { GOOGLE_OAUTH_REFRESH_TOKEN: "set" } }));
  assert.deepEqual(coverage.items.map(item => `${item.id}: ${item.state}`), ["mcp:notion: present", "mcp:gmail: present", "github: present", "mcp:figma: missing"]);
  assert.equal(coverage.ok, false);
  const figma = coverage.items.find(item => item.id === "mcp:figma")!;
  assert.equal(figma.where.tab, "doors");
  assert.match(missingLine(coverage), /connector mcp:figma \(mcp:figma is not connected here .*Connected services; needed by bundle b\)/);

  const ungranted = credentialCoverage({ ...ada, bundles: [{ name: "b", needs: { connectors: ["github"] } }] }, [], world([{ ...github, grants: [{ holder: "agent:someone-else" }] }]));
  assert.equal(ungranted.items[0]!.state, "missing");
  assert.match(ungranted.items[0]!.why, /here but not granted to Ada/);
  const unconnected = credentialCoverage({ ...ada, bundles: [{ name: "b", needs: { connectors: ["oauth:github"] } }] }, [], world());
  assert.match(unconnected.items[0]!.why, /GitHub is not connected here/);
});

test("a secret is present when it exists and a live grant or the box's bundle covers the agent", () => {
  const needs = { ...ada, bundles: [{ name: "b", needs: { secretIds: ["A", "B", "C", "D", "E"] } }] };
  const secrets: SecretView[] = [
    { id: "A", description: "", grants: [{ holder: "*" }] },
    { id: "B", description: "", grants: [{ holder: "principal:chris" }] },
    { id: "C", description: "", grants: [] },
    { id: "D", description: "", grants: [{ holder: "agent:a1", expiresAt: "2026-11-01T00:00:00Z" }] },
  ];
  const states = (agent: CoverageAgent, bundle?: (id: string) => boolean) =>
    credentialCoverage(agent, [], world(secrets, bundle ? { bundleGrants: bundle } : {})).items.map(item => `${item.id}: ${item.state}`);
  assert.deepEqual(states(needs), ["A: present", "B: missing", "C: missing", "D: missing", "E: missing"]);
  assert.deepEqual(states({ ...needs, principalId: "chris" }, id => id === "C"), ["A: present", "B: present", "C: present", "D: missing", "E: missing"], "the person's grant and the bundle count; an expired grant does not");
  assert.match(credentialCoverage(needs, [], world(secrets)).items[4]!.why, /there is no secret E/);
});

test("expiring: the agent's only grant, or a token nobody can re-mint, ends inside the window — said, and the work may still start", () => {
  const soon = new Date(NOW.getTime() + EXPIRING_WITHIN_MS - 60_000).toISOString();
  const later = new Date(NOW.getTime() + EXPIRING_WITHIN_MS + 60_000).toISOString();
  const past = new Date(NOW.getTime() - 60_000).toISOString();
  const needs = { ...ada, bundles: [{ name: "b", needs: { secretIds: ["SOON", "LATER", "MIXED"], connectors: ["github", "feishu"] } }] };
  const secrets: SecretView[] = [
    { id: "SOON", description: "", grants: [{ holder: "agent:a1", expiresAt: soon }] },
    { id: "LATER", description: "", grants: [{ holder: "agent:a1", expiresAt: later }] },
    { id: "MIXED", description: "", grants: [{ holder: "agent:a1", expiresAt: soon }, { holder: "*" }] },
    { id: "oauth:github", description: "", grants: [{ holder: "*" }], oauth: { provider: "github", kind: "authorization_code", expiresAt: past } },
    { id: "oauth:feishu", description: "", grants: [{ holder: "*" }], oauth: { provider: "feishu", kind: "client_credentials", expiresAt: past, refreshable: true } },
  ];
  const coverage = credentialCoverage(needs, [], world(secrets));
  assert.deepEqual(coverage.items.map(item => `${item.id}: ${item.state}`), ["github: missing", "feishu: present", "SOON: expiring", "LATER: present", "MIXED: present"]);
  assert.match(coverage.items[0]!.why, /token expired .* cannot be renewed here/);
  assert.match(coverage.items[2]!.why, /Ada's grant runs out/);
  assert.equal(credentialCoverage({ ...ada, bundles: [{ name: "b", needs: { secretIds: ["SOON"] } }] }, [], world(secrets)).ok, true, "expiring does not stop work");
});

test("the Secrets list's 'needed by' names the agents and skills, and a connector lands on its OAuth secret", () => {
  const reviewer = skill("connectors: github\nsecrets: NPM_TOKEN");
  const rows = neededBy(
    [{ agent: { ...ada, bundles: [{ name: "b", needs: { secretIds: ["NPM_TOKEN"] } }] }, skills: [reviewer] }, { agent: { id: "b1", name: "Bo" }, skills: [] }],
    [reviewer]
  );
  assert.deepEqual(rows, { NPM_TOKEN: ["Ada", "skill pr-review"], "oauth:github": ["Ada", "skill pr-review"] });
});
