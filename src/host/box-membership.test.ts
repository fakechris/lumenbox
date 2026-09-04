/**
 * The box's inner gate: one check, three bindings, fail closed everywhere
 * it can. The cases under test hardest are the department binding (live
 * subtree resolution, the docs/35 §3 amendment) and the two ways a
 * department box admits nobody — never synced, and the person left the org.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { audienceOf, type MembershipWorld, mayReach, subtreeOf } from "./box-membership.ts";
import type { BoxMembers } from "../box/boxes.ts";

function world(overrides: Partial<MembershipWorld> = {}): MembershipWorld {
  return {
    // One person: two identities on two doors, one on the bound door.
    principalIdOf: identity =>
      ["feishu:ou_ada", "dingtalk:staff_ada", "feishu:ou_bob"].includes(identity)
        ? identity.replace(/[:].*$/, "") === "feishu" && identity.endsWith("ou_ada")
          ? "p-ada"
          : identity === "dingtalk:staff_ada"
            ? "p-ada"
            : "p-bob"
        : undefined,
    identitiesOf: principalId =>
      principalId === "p-ada" ? ["feishu:ou_ada", "dingtalk:staff_ada"] : principalId === "p-bob" ? ["feishu:ou_bob"] : [],
    directoryPerson: (channelId, subject) =>
      channelId === "feishu" && subject === "ou_ada"
        ? { departmentVendorIds: ["od_2"] } // inside 研发部's subtree
        : channelId === "feishu" && subject === "ou_bob"
          ? { departmentVendorIds: ["od_9"] } // 市场部, outside
          : undefined,
    departmentsOf: channelId =>
      channelId === "feishu"
        ? [
            { vendorId: "od_1", name: "研发部", parentVendorId: "0" },
            { vendorId: "od_2", name: "后端组", parentVendorId: "od_1" },
            { vendorId: "od_9", name: "市场部", parentVendorId: "0" },
          ]
        : undefined,
    ...overrides,
  };
}

test("subtreeOf: the root, its children, and their children — not their parents", () => {
  const tree = [
    { vendorId: "1", parentVendorId: null },
    { vendorId: "10", parentVendorId: "1" },
    { vendorId: "11", parentVendorId: "10" },
    { vendorId: "20", parentVendorId: "1" },
  ];
  assert.deepEqual([...subtreeOf(tree, "10")].sort(), ["10", "11"], "downward only");
  assert.deepEqual([...subtreeOf(tree, "1")].sort(), ["1", "10", "11", "20"]);
  assert.deepEqual([...subtreeOf(tree, "nowhere")], ["nowhere"], "an unknown root is just itself");
});

test("everyone admits anyone past the outer gate; the operator passes every gate", () => {
  assert.equal(mayReach({ kind: "everyone" }, "feishu:ou_stranger", world()), true);
  assert.equal(mayReach({ kind: "everyone" }, undefined, world()), true);
  // Even a listed or department box: the operator has no identity, and the
  // person running the machine must never be locked out of it by data.
  assert.equal(mayReach({ kind: "listed", principalIds: ["someone-else"] }, undefined, world()), true);
  assert.equal(mayReach({ kind: "department", channelId: "feishu", departmentVendorId: "od_1" }, undefined, world()), true);
});

test("listed: a member by any identity; a stranger by none", () => {
  const members: BoxMembers = { kind: "listed", principalIds: ["p-ada"] };
  assert.equal(mayReach(members, "feishu:ou_ada", world()), true);
  assert.equal(mayReach(members, "dingtalk:staff_ada", world()), true, "any of the person's identities");
  assert.equal(mayReach(members, "feishu:ou_bob", world()), false);
  assert.equal(mayReach(members, "feishu:ou_nobody", world()), false, "a stranger is not a member");
});

test("department: the subtree resolves live, and only through the bound door", () => {
  const members: BoxMembers = { kind: "department", channelId: "feishu", departmentVendorId: "od_1" };
  // Ada's department is od_2 (后端组), a child of od_1 (研发部): inside.
  assert.equal(mayReach(members, "feishu:ou_ada", world()), true);
  // The same person's DingTalk identity cannot prove Feishu membership — the
  // binding names one door, and other doors' directories say nothing about it.
  const singleDoor = world({
    identitiesOf: principalId => (principalId === "p-ada" ? ["dingtalk:staff_ada"] : []),
  });
  assert.equal(mayReach(members, "dingtalk:staff_ada", singleDoor), false, "no identity on the bound door");
  // Bob is in 市场部, a sibling: outside the subtree.
  assert.equal(mayReach(members, "feishu:ou_bob", world()), false);
});

test("department: fail closed — never synced admits nobody, and neither does a departure", () => {
  const members: BoxMembers = { kind: "department", channelId: "feishu", departmentVendorId: "od_1" };
  assert.equal(mayReach(members, "feishu:ou_ada", world({ departmentsOf: () => undefined })), false);
  // The person left the org: the directory no longer offers them, so not a member.
  assert.equal(
    mayReach(members, "feishu:ou_ada", world({ directoryPerson: () => undefined })),
    false,
  );
});

test("the audience statement derives from the members, honestly in every state", () => {
  const w = world();
  assert.equal(audienceOf({ kind: "everyone" }, w), "anyone this installation admits");
  assert.equal(audienceOf({ kind: "listed", principalIds: ["p-ada"] }, w), "one named member");
  assert.equal(audienceOf({ kind: "listed", principalIds: ["p-ada", "p-bob"] }, w), "2 named members");
  assert.equal(audienceOf({ kind: "department", channelId: "feishu", departmentVendorId: "od_1" }, w), "研发部 (feishu)");
  // A binding whose door never synced says so — never a hopeful label.
  assert.match(
    audienceOf({ kind: "department", channelId: "telegram", departmentVendorId: "x" }, w),
    /not yet synced — admits nobody/,
  );
});
