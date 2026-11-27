/**
 * The deprecation list (docs/106 §7): what the start-up report says, and when an item may go.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Deprecation, deprecationOf, deprecationsInUse, releaseLine, removable } from "./deprecations.ts";

const list: Deprecation[] = [
  { item: "config/boxImage", since: "0.5", replacement: "the image the release pins", removableFrom: "0.6" },
  { item: "env/AGENTBOX_IMAGE", since: "0.9", replacement: "config.json boxImage", removableFrom: "0.10" },
  { item: "cli/box logs", since: "0.5", replacement: "docker logs", removableFrom: "0.6" },
];

test("the start-up report names only what this installation still uses, with what replaces it and when it stops", () => {
  assert.deepEqual(deprecationsInUse({ configKeys: ["activityLimit"], envNames: ["PATH"] }, list), [], "nothing deprecated in use, nothing said");
  const lines = deprecationsInUse({ configKeys: ["boxImage"], envNames: ["AGENTBOX_IMAGE"] }, list);
  assert.deepEqual(lines, [
    'deprecated: config.json key "boxImage" (since 0.5) stops working in 0.6. Use instead: the image the release pins',
    "deprecated: environment variable AGENTBOX_IMAGE (since 0.9) stops working in 0.10. Use instead: config.json boxImage",
  ]);
  assert.deepEqual(deprecationsInUse({ configKeys: ["boxImage"], envNames: ["AGENTBOX_IMAGE"] }), [], "and the list as it stands today has nothing on it");
});

test("an item may go from its line on, lines compare as numbers, and an entry covers what is under it", () => {
  const image = list[1]!;
  assert.equal(releaseLine("0.4.9"), "0.4");
  assert.equal(removable(image, "0.9.7"), false);
  assert.equal(removable(image, "0.10.0"), true, "0.10 is after 0.9");
  assert.equal(removable(list[0]!, "0.10.0"), true);
  assert.equal(deprecationOf("cli/box logs/--tail", list)?.item, "cli/box logs");
  assert.equal(deprecationOf("cli/box logs-all", list), undefined, "a name that merely starts the same is not covered");
});
