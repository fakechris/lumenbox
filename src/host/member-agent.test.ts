/**
 * A member's first agent (INV-2220, docs/109 §3): from the organisation's template when one is set,
 * else the built-in assistant; once per person, and only in a box that is theirs alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { ensureHomeAgent, type MemberAgentDeps } from "./member-agent.ts";
import { Principals } from "./principals.ts";
import { TEMPLATE_FORMAT } from "./template.ts";

test("a member's home agent is the organisation's template when one is set and reads, else the assistant; made once, in their own box only", () => {
  const home = mkdtempSync(join(tmpdir(), "inv2220-member-agent-"));
  try {
    const registry = new AgentRegistry(join(home, "agents")), principals = new Principals(join(home, "principals.json"));
    principals.save(["ana", "bob", "cat"].map(id => ({ id, name: id, role: "driver" as const, identities: [`ding:${id}`] })));
    const box = (id: string, members: "everyone" | string[]) => registry.attachBox({ id, name: id, kind: "attached", members, displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() }).id;
    let template: string | undefined;
    const said: string[] = [];
    const deps: MemberAgentDeps = {
      registry, principals, log: line => said.push(line), templatePath: () => template,
      assistant: () => ({ name: "Assistant", title: "coordinator", description: "Talks to its person." }),
      importTemplate: (parsed, boxId, owner) => registry.create({ name: parsed.profile.name, boxId, ownerUserId: owner, importedFrom: { id: "member", name: parsed.profile.name, at: new Date().toISOString() } }),
    };

    const anas = ensureHomeAgent(box("ana-box", ["ana"]), deps)!;
    assert.deepEqual([anas.profile.name, anas.profile.boxId, principals.byId("ana")?.homeAgentId], ["Assistant", "ana-box", anas.id]);
    assert.equal(ensureHomeAgent(box("ana-second", ["ana"]), deps), undefined, "a second box of hers gets none: she has a home agent");
    assert.equal(ensureHomeAgent(box("shared", "everyone"), deps), undefined, "nor does a box that is not one person's");
    // Every roster save keeps it, and she may be given another or none.
    principals.save(principals.list().map(({ homeAgentId: _dropped, ...person }) => person));
    assert.equal(principals.byId("ana")?.homeAgentId, anas.id);
    assert.equal(principals.setHomeAgent("ana", undefined), true);
    assert.equal(principals.byId("ana")?.homeAgentId, undefined);
    assert.equal(principals.setHomeAgent("nobody", "x"), false);

    template = join(home, "member-template.json");
    writeFileSync(template, JSON.stringify({ format: TEMPLATE_FORMAT, profile: { name: "Desk", description: "The organisation's desk agent." }, memory: [], skills: [], routines: [], connectors: [] }));
    const bobs = ensureHomeAgent(box("bob-box", ["bob"]), deps)!;
    assert.deepEqual([bobs.profile.name, principals.byId("bob")?.homeAgentId], ["Desk", bobs.id], "the Admin's template, when one is set");

    writeFileSync(template, "{ not a template");
    const cats = ensureHomeAgent(box("cat-box", ["cat"]), deps)!;
    assert.equal(cats.profile.name, "Assistant", "a template that cannot be read leaves nobody without an agent");
    assert.match(said.join("\n"), /member template .* was not used for cat/, "and says so");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
