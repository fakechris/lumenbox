import { test } from "node:test";
import assert from "node:assert/strict";
import { agentVersionOf, versionDiff } from "./agent-version.ts";

const standing = { "AGENTS.md": "rules", "SOUL.md": "I am Ada", "USER.md": "Chris", "HEARTBEAT.md": "" };
const parts = [{ key: "conduct", defaultHash: "c0" }, { key: "front", defaultHash: "f0", override: { base: "f-old" } }];

test("an agent's version is a hash per standing file, per offered skill and per prompt part, and moves when one of them does (INV-1474)", () => {
  const v1 = agentVersionOf(standing, [{ slug: "research-brief", description: "Use when asked for a brief" }], parts);
  assert.deepEqual(Object.keys(v1.standing).sort(), ["AGENTS", "HEARTBEAT", "SOUL", "USER"]);
  assert.match(v1.standing.SOUL!, /^[0-9a-f]{16}$/);
  assert.deepEqual(v1.parts, { conduct: "c0", front: "f-old" }, "an overridden part is named by the base its override was written against");
  const v2 = agentVersionOf({ ...standing, "SOUL.md": "I am Ada, and brief" }, [{ slug: "research-brief", description: "Use when asked for a brief" }], parts);
  assert.notEqual(v2.standing.SOUL, v1.standing.SOUL, "one line in SOUL.md changes the version");
  assert.equal(v2.standing.AGENTS, v1.standing.AGENTS);
  assert.deepEqual(versionDiff(v1, v2), ["SOUL"]);
  const v3 = agentVersionOf(standing, [{ slug: "research-brief", description: "Use when asked for a sourced brief" }, { slug: "gmail", description: "mail" }], [{ key: "conduct", defaultHash: "c1" }]);
  assert.deepEqual(versionDiff(v1, v3).sort(), ["part conduct", "part front", "skill gmail", "skill research-brief"]);
  assert.deepEqual(agentVersionOf(undefined, [], []).standing, {}, "an isolated turn reads no standing files");
  assert.ok(!JSON.stringify(v1).includes("I am Ada"), "hashes only, never the text");
});
