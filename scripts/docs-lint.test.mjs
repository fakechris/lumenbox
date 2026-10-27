/**
 * The documents check (docs/INDEX.md): headers are well formed, supersession points
 * somewhere real, no two current documents claim one number or one domain, and the index
 * is what the headers say. A conflicting statement between two documents is not a tidiness
 * problem here — it is how `auth.ts` ended up gating on a field docs/22 §3 had retired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("research material is not tracked (c11f918: it lives in /research/, ignored)", () => {
  // Research notes and competitive analysis are kept locally, never shipped. They kept landing
  // in docs/research/ and scripts/research/ instead, 46 files by 2026-09-28, so the rule is a
  // check rather than a comment. Outside a git checkout (a packed source tree) there is nothing
  // to check.
  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "research", "docs/research", "scripts/research"], { cwd: root, encoding: "utf8" });
  } catch {
    return;
  }
  const files = tracked.split("\n").filter(line => line !== "");
  assert.deepEqual(files, [], `research material is tracked; move it to /research/ and git rm --cached it:\n${files.join("\n")}`);
});

import { publicContentProblems, scanPublic } from "./public-content.mjs";
import { createHash } from "node:crypto";

test("public docs carry no home directory, private address, tailnet name, personal email or internal name (INV-1381)", () => {
  const problems = scanPublic(root);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the public-content rules catch what they are for and leave the product's own words alone", () => {
  const hash = createHash("sha256").update("secret-vm").digest("hex");
  const config = { internalNameHashes: [hash] };
  const one = text => publicContentProblems(text, config);
  assert.match(one("see /Users/alice/repo/x").join(), /local home directory \(\/Users\/alice\/\)/);
  assert.match(one("cd /home/alice/work").join(), /\/home\/alice\//);
  assert.deepEqual(one("the box writes /home/box/work and hostd runs as /home/hostd/x"), [], "the product's own homes");
  assert.match(one("attached at 100.114.30.43").join(), /private network address/);
  assert.match(one("at 192.168.1.20 on the LAN").join(), /192\.168\.1\.20/);
  assert.deepEqual(one("deny 10.0.0.0/8 and 192.168.0.0/16"), [], "a CIDR is a rule, not a machine");
  assert.deepEqual(one("docker's bridge 172.17.0.1"), [], "the docker bridge is everyone's");
  assert.match(one("my.tailnet-x1.ts.net").join(), /tailnet name/);
  assert.deepEqual(one("host.example.ts.net is the placeholder"), []);
  assert.match(one("mail someone@gmail.com").join(), /email address \(…@gmail\.com\)/);
  assert.deepEqual(one("alice@example.com, admin@involute.local, bot@corp.com"), []);
  const named = one("ssh into Secret-VM. tonight");
  assert.equal(named.length, 1);
  assert.ok(!named[0].includes("secret-vm"), "the message never echoes the hashed name");
  assert.deepEqual(one("INV-1381 and docs/84 are fine to cite"), []);
});
