/**
 * The quota chain (docs/36 §5): person → department → installation, first
 * answer wins — because a department-wide 0 must be a real ceiling and a
 * per-person 1 a real exception, and the same order in one direction reads
 * them both.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  personalBoxName,
  personalBoxesOf,
  personalQuotaFor,
  type QuotaSources,
} from "./box-quota.ts";

function sources(overrides: Partial<QuotaSources> = {}): QuotaSources {
  return {
    installationDefault: 1,
    departmentQuotas: {},
    personQuotas: {},
    ...overrides,
  };
}

test("the chain answers in one direction: person, then department, then the installation default", () => {
  assert.deepEqual(personalQuotaFor("p-ada", undefined, sources()), { quota: 1, from: "installation" });

  const engineering = sources({
    departmentQuotas: { "feishu:od_eng": 1, "feishu:od_service": 0 },
  });
  assert.deepEqual(
    personalQuotaFor("p-ada", ["feishu:od_eng"], engineering),
    { quota: 1, from: "department" },
  );
  // A department's 0 is a real ceiling — not a suggestion the default may override.
  assert.deepEqual(
    personalQuotaFor("p-xiao", ["feishu:od_service"], engineering),
    { quota: 0, from: "department" },
  );
  // The directory's own order picks among a person's departments: the first
  // department with an answer answers.
  assert.deepEqual(
    personalQuotaFor("p-both", ["feishu:od_eng", "feishu:od_service"], engineering),
    { quota: 1, from: "department" },
  );

  // A person outranks every department — the exception the admin made on purpose.
  assert.deepEqual(
    personalQuotaFor("p-xiao", ["feishu:od_service"], sources({ personQuotas: { "p-xiao": 1 } })),
    { quota: 1, from: "person" },
  );
  assert.deepEqual(
    personalQuotaFor("p-ada", undefined, sources({ personQuotas: { "p-ada": 3 }, installationDefault: 0 })),
    { quota: 3, from: "person" },
  );
});

test("personal boxes are structural: exactly one member, exactly this person", () => {
  const entries = [
    { id: "b1", members: { kind: "everyone" as const } },
    { id: "b2", members: { kind: "listed" as const, principalIds: ["p-ada"] } },
    { id: "b3", members: { kind: "listed" as const, principalIds: ["p-ada", "p-bob"] } },
    { id: "b4", members: { kind: "listed" as const, principalIds: ["p-bob"] } },
    { id: "b5", members: { kind: "department" as const, channelId: "feishu", departmentVendorId: "od_1" } },
  ];
  const held = personalBoxesOf(entries, "p-ada");
  assert.deepEqual(held.map(entry => entry.id), ["b2"], "a shared list is not a personal box, a department is not either");
  assert.deepEqual(personalBoxesOf(entries, "p-nobody").length, 0);
});

test("a personal box's name is safe on a path, a command line, and a container", () => {
  assert.equal(personalBoxName("feishu:ou_ABC123"), "p-feishu-ou-abc123");
  assert.equal(personalBoxName("p-ada"), "p-p-ada");
  assert.match(personalBoxName(":::"), /^p-(member|:*)$/, "garbage degrades, never throws");
  assert.ok(personalBoxName("x".repeat(200)).length <= 42, "and it is bounded");
});
