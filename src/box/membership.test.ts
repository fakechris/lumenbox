/**
 * Membership (INV-538): everyone means everyone, a list means those people, and the
 * installation's own credential is nobody's member because it is not a person.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { membersLabel, mayEnterBox, refusalToEnter } from "./membership.ts";

test("who may enter", () => {
  assert.equal(mayEnterBox({ members: "everyone" }, "p-chris"), true);
  assert.equal(mayEnterBox({ members: ["p-chris"] }, "p-chris"), true);
  assert.equal(mayEnterBox({ members: ["p-chris"] }, "p-mia"), false);
  assert.equal(mayEnterBox({ members: [] }, "p-chris"), false, "an empty set is a closed box, not an open one");
  // The operator, holding the installation's credential: not a person the roster knows.
  assert.equal(mayEnterBox({ members: ["p-chris"] }, undefined), true);
  // An admin is not automatically in the room; they add themselves, in writing.
  assert.equal(mayEnterBox({ members: ["p-chris"] }, "p-admin"), false);
});

test("the label is derived from the members, never from free text", () => {
  const nameOf = (id: string) => ({ "p-chris": "Chris", "p-mia": "Mia" })[id] ?? id;
  assert.match(membersLabel({ members: "everyone" }, nameOf), /^共享 box/);
  assert.match(membersLabel({ members: ["p-chris"] }, nameOf), /^Chris 的 box/);
  assert.match(membersLabel({ members: ["p-chris", "p-mia"] }, nameOf), /2 人的 box：Chris、Mia/);
  assert.match(membersLabel({ members: [] }, nameOf), /^无人 box/);
  assert.match(refusalToEnter("finance", "Mia"), /finance is not a box Mia is in/);
});
