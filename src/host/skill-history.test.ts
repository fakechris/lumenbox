/** Skill history (INV-1376): drafts and publishes are commits, publishes are tags, rollback appends. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillHistory } from "./skill-history.ts";
import { TeachDrafts } from "./teach-drafts.ts";

const SKILL = (step: string) => `---\nname: Weekly report\ndescription: Use when asked for the weekly report\nscope: global\n---\n\n1. ${step}\n`;

test("a draft and three publishes leave a tagged history, a card per version, and files that round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-history-"));
  try {
    const history = new SkillHistory(join(root, "h"));
    history.recordDraft({ id: "d1", agentName: "Ada", source: "/teach/s1/events.jsonl", files: { "SKILL.md": SKILL("draft") } });
    const one = history.recordPublish({ dir: "taught-x", name: "Weekly report", files: { "SKILL.md": SKILL("first"), "scripts/run.sh": "echo 1\n" }, actor: "chris", source: "/teach/s1/events.jsonl", draftId: "d1" }, "2026-10-27T09:00:00.000Z");
    assert.equal(one.version, 1);
    assert.match(one.card, /^# Weekly report — v1\n\n- Published: 2026-10-27T09:00:00.000Z by chris\n- Source: \/teach\/s1\/events\.jsonl/);
    assert.match(one.card, /Not tested on:/);
    history.recordPublish({ dir: "taught-x", name: "Weekly report", files: { "SKILL.md": SKILL("second") }, actor: "chris", source: "s" });
    const back = history.recordPublish({ dir: "taught-x", name: "Weekly report", files: history.filesAt("taught-x", 1), actor: "chris", source: "s", note: "rollback to v1" });
    assert.equal(back.version, 3, "a rollback is a new version, not a rewrite");
    const versions = history.versions("taught-x");
    assert.deepEqual(versions.map(v => v.version), [1, 2, 3]);
    assert.equal(versions[0]!.author, "chris");
    assert.match(versions[2]!.message, /rollback to v1/);
    assert.deepEqual(history.filesAt("taught-x", 3), { "SKILL.md": SKILL("first"), "scripts/run.sh": "echo 1\n" }, "exact bytes, trailing newlines kept, CARD.md not among the files");
    assert.deepEqual(history.filesAt("taught-x", 2), { "SKILL.md": SKILL("second") }, "a file dropped in v2 is not resurrected");
    assert.deepEqual(history.versions("other"), []);
    assert.throws(() => history.recordPublish({ dir: "taught-x", name: "x", files: { "SKILL.md": `${SKILL("x")}token ghp_${"a".repeat(36)}` }, actor: "c", source: "s" }), /credential/);
    assert.throws(() => history.recordPublish({ dir: "../escape", name: "x", files: { "SKILL.md": "x" }, actor: "c", source: "s" }), /Not a skill directory/);
    assert.throws(() => history.filesAt("taught-x", 9));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishing a draft records it with a card in the box, and rollback republishes an old version", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-history-drafts-"));
  try {
    const drafts = new TeachDrafts(join(root, "drafts"), new SkillHistory(join(root, "history")));
    const writes: Record<string, string> = {};
    const publish = async (_box: string, path: string, content: string) => { writes[path] = content; };
    const draft = drafts.create({ boxId: "b", agentId: "ada", sessionId: "s1", eventsPath: "/teach/s1/events.jsonl", skill: SKILL("first"), question: null });
    assert.deepEqual(drafts.versions(draft.id), [], "nothing published yet");
    await drafts.approve(draft.id, draft.digest, "chris", publish);
    const dir = `/home/box/work/skills/taught-${draft.id}`;
    assert.match(writes[`${dir}/CARD.md`]!, /# Weekly report — v1/);
    assert.equal(drafts.versions(draft.id).length, 1);
    // A later edit published as v2 by hand, then a rollback to v1.
    writes[`${dir}/SKILL.md`] = "";
    await drafts.rollback(draft.id, 1, "chris", publish);
    assert.equal(writes[`${dir}/SKILL.md`], SKILL("first"));
    assert.match(writes[`${dir}/CARD.md`]!, /# Weekly report — v2\n[\s\S]*Note: rollback to v1/);
    assert.deepEqual(drafts.versions(draft.id).map(v => v.version), [1, 2]);
    await assert.rejects(() => drafts.rollback(draft.id, 1, " ", publish), /operator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
