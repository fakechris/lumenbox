/**
 * The documents check (docs/INDEX.md): headers are well formed, supersession points
 * somewhere real, no two current documents claim one number or one domain, and the index
 * is what the headers say. A conflicting statement between two documents is not a tidiness
 * problem here — it is how `auth.ts` ended up gating on a field docs/22 §3 had retired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as awaitImported from "./docs-lint.mjs";
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

test("a translation shares its original's number; one without an original is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-lint-"));
  try {
    const doc = (slug, title) => writeFileSync(join(dir, `${slug}.md`), `<!-- doc: ${slug}\n     title: ${title}\n     family: decision\n     status: current\n-->\n# ${title}\n`);
    doc("89-thesis", "Thesis");
    doc("89-thesis.zh", "论文");
    assert.deepEqual(lintDocs(dir).problems, [], "the original and its translation are one number");
    doc("90-alone.zh", "孤本");
    assert.ok(lintDocs(dir).problems.some(p => /90-alone\.zh: a translation of 90-alone, which is not a document here/.test(p)));
    doc("89-other", "Other");
    assert.ok(lintDocs(dir).problems.some(p => /two current documents are numbered 89: (89-other, 89-thesis|89-thesis, 89-other)\./.test(p)), "two originals still clash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a solution page needs its frontmatter and its four paragraphs; a page that cannot say how to verify is refused", () => {
  const { lintSolutions, parseSolutionFrontmatter } = awaitImported;
  assert.deepEqual(lintSolutions(join(docs, "solutions")), [], "every shipped page is whole");
  assert.ok(readdirSync(join(docs, "solutions")).filter(f => f.endsWith(".md")).length >= 8, "the first batch is in");
  const dir = mkdtempSync(join(tmpdir(), "solutions-"));
  try {
    writeFileSync(join(dir, "a.md"), "---\nmodule: x\ntags: [y]\nproblem_type: guesswork\nfound: 2026-11-01\n---\n# A\n\n**Symptom.** s\n\n**Cause.** c\n\n**Fix.** f\n");
    const problems = lintSolutions(dir);
    assert.ok(problems.some(p => /problem_type guesswork is not one of/.test(p)));
    assert.ok(problems.some(p => /no \*\*Verify\.\*\* paragraph/.test(p)));
    assert.deepEqual(parseSolutionFrontmatter("no front"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("user-facing pages use the glossary's words, and the glossary names every concept in five columns (INV-1657)", () => {
  const { lintVocabulary, parseGlossary, GLOSSARY } = awaitImported;
  assert.deepEqual(lintVocabulary(root), [], lintVocabulary(root).join("\n"));
  const glossary = parseGlossary(readFileSync(join(root, GLOSSARY), "utf8"));
  assert.ok(glossary.concepts.length >= 19, `${glossary.concepts.length} concepts; the audit named 19`);
  assert.ok(glossary.deprecated.some(rule => rule.term === "door" && rule.instead === "channel"));
});

test("a deprecated synonym is reported by file and line, in the listed files and in audience: user pages; code, links, allowed names and specs are not checked", () => {
  const { lintVocabulary, GLOSSARY } = awaitImported;
  const dir = mkdtempSync(join(tmpdir(), "vocabulary-"));
  try {
    writeFileSync(join(dir, "guide.md"), [
      "# Guide",
      "",
      "Open Settings → Channels and add a channel.",
      "Then message the bot in the group chat.",
      "Run `agentbox door list` or read [the spec](docs/22-door.md); Grok Bot is a product.",
      "```",
      "a door inside a code block",
      "```",
      "把它放进箱子里。",
    ].join("\n"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "22-spec.md"), "<!-- doc: 22-spec\n     family: spec\n-->\n# A spec\n\nThe door grants nothing.\n");
    writeFileSync(join(dir, "docs", "manual.md"), "<!-- doc: manual\n     audience: user\n-->\n# A page\n\nEvery door opens into one box.\n");
    const problems = lintVocabulary(dir, ["gui*.md"], join(root, GLOSSARY));
    assert.deepEqual(problems, [
      'docs/manual.md:6: "door" is a deprecated synonym; write "channel" (docs/glossary.md).',
      'guide.md:4: "bot" is a deprecated synonym; write "agent" (docs/glossary.md).',
      'guide.md:9: "箱子" is a deprecated synonym; write "box" (docs/glossary.md).',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the manual: one page per concept, named by the concept, each with the skeleton, and listed in the index (INV-1661)", () => {
  const { lintManual, renderIndex } = awaitImported;
  const shipped = lintManual(join(docs, "manual"));
  assert.deepEqual(shipped.problems, [], shipped.problems.join("\n"));
  for (const concept of ["box", "agent", "channels", "templates", "skills", "memory", "tasks-and-records", "approvals", "automations", "supervision"]) {
    assert.ok(shipped.pages.has(concept), `the manual has a ${concept} page`);
  }
  assert.match(renderIndex(lintDocs(docs).docs), /## manual\n[\s\S]*\| \[manual\/box\]\(manual\/box\.md\) \|/, "the index lists the manual under its own heading");

  const dir = mkdtempSync(join(tmpdir(), "manual-"));
  try {
    const skeleton = "Intro line.\n\n## What it is\n\nx\n\n## How to do it\n\n### In the app\n\nx\n\n### In a chat\n\nx\n\n### From the command line\n\nx\n\n## Where to see the result\n\nx\n\n## Limits\n\nx\n\n## Next\n\n- [Box](box.md)\n";
    const page = (slug, covers, body = skeleton, extra = "     audience: user\n") =>
      writeFileSync(join(dir, `${slug}.md`), `<!-- doc: ${slug}\n     title: ${slug}\n     family: manual\n     status: current\n     covers: ${covers}\n${extra}-->\n# ${slug}\n\n${body}`);
    page("box", "box");
    assert.deepEqual(lintManual(dir).problems, [], "a whole page passes");

    page("boxes", "box");
    assert.ok(lintManual(dir).problems.some(p => p === "two current manual pages cover box: box, boxes. One concept, one page; merge them or supersede one."), "one concept, one page");
    rmSync(join(dir, "boxes.md"));

    page("12-agent", "agent");
    assert.ok(lintManual(dir).problems.some(p => /12-agent\.md: a manual page is named by its concept, not by a number/.test(p)));
    rmSync(join(dir, "12-agent.md"));

    page("memory", "memory", skeleton.replace("### In a chat\n\nx\n\n", "").replace("[Box](box.md)", "[Gone](gone.md)"), "");
    const problems = lintManual(dir).problems;
    assert.ok(problems.some(p => /memory\.md: the skeleton is .*In a chat.*; this page has /.test(p)), "the three ways in are the skeleton");
    assert.ok(problems.some(p => /memory\.md: a written manual page says audience: user/.test(p)), "the glossary's words are checked on it");
    assert.ok(problems.some(p => /memory\.md: links to gone\.md, which is not there/.test(p)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
