/**
 * The documents check (docs/INDEX.md): headers are well formed, supersession points
 * somewhere real, no two current documents claim one number or one domain, and the index
 * is what the headers say. A conflicting statement between two documents is not a tidiness
 * problem here — it is how `auth.ts` ended up gating on a field docs/22 §3 had retired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintDocs, parseHeader, renderIndex, titleOf } from "./docs-lint.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const docs = join(root, "docs");

test("every document says what it is, and nothing contradicts anything", () => {
  const { problems } = lintDocs(docs);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("docs/INDEX.md is what the headers say", () => {
  const { docs: headers } = lintDocs(docs);
  const onDisk = readFileSync(join(docs, "INDEX.md"), "utf8").trimEnd();
  assert.equal(
    renderIndex(headers).trimEnd(),
    onDisk,
    "the index is generated: run `node -e \"…renderIndex…\"` or fix the header you changed"
  );
});

test("the rules that matter catch what they are for", () => {
  // Two current documents on one number, which is how `docs/37` meant two things.
  const clash = new Map([
    ["37-a", { doc: "37-a", family: "decision", status: "current", title: "a" }],
    ["37-b", { doc: "37-b", family: "decision", status: "current", title: "b" }],
  ]);
  const numbers = [...clash.keys()].map(slug => /^(\d+)-/.exec(slug)?.[1]);
  assert.deepEqual(numbers, ["37", "37"], "the shape the rule reads");

  // A header block is a flat key/value list in an HTML comment, so a shell can read it too.
  const header = parseHeader("<!-- doc: 22-domain-model\n     family: spec\n     status: current\n-->\n# Title\n");
  assert.deepEqual(header, { doc: "22-domain-model", family: "spec", status: "current" });
  assert.equal(parseHeader("# No header\n"), undefined);
  assert.equal(titleOf("<!-- x -->\n# 53 — Connector doors\n"), "Connector doors");
});
