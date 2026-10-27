/** Importing SKILL.md folders (INV-1367): translated into drafts, never installed, refused when unsafe. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSkillFolders, importProposal, translateSkill } from "./skill-import.ts";
import { TeachDrafts } from "./teach-drafts.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "skill-import-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const OPENCLAW = "---\nname: pr-watch\ndescription: Watch a pull request until the review bots finish\nallowed-tools: Bash, Read, WebFetch, TodoWrite, FancyTool\nlicense: MIT\n---\n# PR watch\n\nRun scripts/digest.py every minute.\n";
const RECORDER = "---\nname: Submit expense\ndescription: Use when the person asks to file this month's expense report\n---\n1. Open {{portal_url}}.\n2. Fill the amount.\n";

test("a skills/ folder of two becomes two drafts with our frontmatter, mapped tools and helper files", () => {
  const root = tree({ "pr-watch/SKILL.md": OPENCLAW, "pr-watch/scripts/digest.py": "print('ok')\n", "pr-watch/.git/HEAD": "x", "expense/SKILL.md": RECORDER, "notes.txt": "not a skill" });
  try {
    const folders = findSkillFolders(root);
    assert.deepEqual(folders.map(f => f.dir.slice(root.length + 1)), ["expense", "pr-watch"]);
    const pr = importProposal(folders[1]!, { boxId: "box", agentId: "ada", from: folders[1]!.dir });
    assert.ok(!("refused" in pr));
    const { proposal, report } = pr as Exclude<typeof pr, { refused: string }>;
    assert.match(proposal.skill!, /^---\nname: pr-watch\ndescription: Watch a pull request until the review bots finish\nscope: global\nallowed-tools: /);
    assert.ok(!proposal.skill!.includes("license:"), "keys we do not use are dropped");
    assert.match(proposal.skill!, /# PR watch\n\nRun scripts\/digest\.py every minute\./, "the body is kept as written");
    assert.deepEqual(proposal.files, { "scripts/digest.py": "print('ok')\n" }, "dotfolders are not carried");
    assert.deepEqual(proposal.unknownTools, ["FancyTool"]);
    assert.ok(report.some(line => /FancyTool/.test(line)));
    assert.equal(proposal.source?.kind, "import");

    // Published only by a person, helpers first, SKILL.md last, under imported-<slug>-<id>.
    const drafts = new TeachDrafts(join(root, ".drafts"));
    const draft = drafts.create(proposal);
    assert.equal(draft.status, "draft");
    const writes: string[] = [];
    return drafts.approve(draft.id, draft.digest, "chris", async (_box, path) => { writes.push(path); }).then(done => {
      assert.equal(done.status, "published");
      assert.equal(writes.length, 2);
      assert.match(writes[0]!, /^\/home\/box\/work\/skills\/imported-pr-watch-[a-f0-9]{8}\/scripts\/digest\.py$/);
      assert.match(writes[1]!, /^\/home\/box\/work\/skills\/imported-pr-watch-[a-f0-9]{8}\/SKILL\.md$/);
    });
  } finally {
    setTimeout(() => rmSync(root, { recursive: true, force: true }), 0);
  }
});

test("a Skill Recorder export with no allowed-tools imports as is", () => {
  const translated = translateSkill(RECORDER);
  assert.equal(translated.name, "Submit expense");
  assert.deepEqual(translated.tools, []);
  assert.match(translated.skill, /^---\nname: Submit expense\ndescription: Use when the person asks to file this month's expense report\nscope: global\n---/);
  assert.match(translated.skill, /\{\{portal_url\}\}/);
});

test("unsafe or unreadable imports are refused before a draft exists", () => {
  const root = tree({
    "nameless/SKILL.md": "---\ndescription: x\n---\nbody",
    "keyed2/SKILL.md": `---\nname: k\ndescription: d\n---\nUse token ghp_${"a".repeat(36)}\n`,
    "helper/SKILL.md": RECORDER,
    "helper/run.sh": `export OPENAI_API_KEY=sk-${"b".repeat(30)}\n`,
  });
  try {
    const results = Object.fromEntries(findSkillFolders(root).map(folder => [folder.dir.slice(root.length + 1), importProposal(folder, { boxId: "b", agentId: "a", from: folder.dir })]));
    assert.match((results.nameless as { refused: string }).refused, /no name/);
    assert.match((results.keyed2 as { refused: string }).refused, /credential/);
    const helper = results.helper as { proposal: { files?: Record<string, string> }; report: string[] };
    assert.equal(helper.proposal.files, undefined, "a helper holding a key is left out, and said so");
    assert.ok(helper.report.some(line => /left out run\.sh/.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a draft's helper files cannot escape the skill or replace SKILL.md", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-import-paths-"));
  try {
    const drafts = new TeachDrafts(root);
    const base = { boxId: "b", agentId: "a", eventsPath: "import:/x", skill: translateSkill(RECORDER).skill, question: null, source: { kind: "import" as const, from: "/x" } };
    assert.throws(() => drafts.create({ ...base, sessionId: "import-1", files: { "../evil.sh": "x" } }), /Invalid imported files/);
    assert.throws(() => drafts.create({ ...base, sessionId: "import-2", files: { "SKILL.md": "x" } }), /Invalid imported files/);
    assert.throws(() => drafts.create({ ...base, sessionId: "import-3", source: undefined, files: { "a.sh": "x" } } as never), /Invalid imported files/, "only imports carry files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Skill Recorder's YAML-list allowed-tools with Claude Code patterns map onto our tools", () => {
  const recorder = "---\nname: release-notes\ndescription: Use when asked to draft release notes from merged PRs\nallowed-tools:\n  - Bash(gh *)\n  - Read\n  - Write\n  - Glob\n---\nList merged PRs with gh, then write NOTES.md.\n";
  const translated = translateSkill(recorder);
  assert.ok(translated.tools.includes("bash") && translated.tools.includes("read_file") && translated.tools.includes("write_file"), translated.tools.join(","));
  assert.deepEqual(translated.unknown, []);
  assert.match(translated.skill, /\nallowed-tools: [a-z_, ]+\n---/);
  assert.ok(!translated.skill.includes("gh *"), "the pattern scope is dropped; the policy gate decides instead");
});
