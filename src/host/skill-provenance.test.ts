import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillProvenance, skillSlugOf, skillsWrittenBy } from "./skill-provenance.ts";

test("a path names its skill only when it is under the skills directory", () => {
  assert.equal(skillSlugOf("/home/box/work/skills/weekly-retro/SKILL.md"), "weekly-retro");
  assert.equal(skillSlugOf("~/work/skills/weekly-retro/helper.sh"), "weekly-retro");
  assert.equal(skillSlugOf("/home/box/work/skills"), undefined);
  assert.equal(skillSlugOf("/home/box/work/notes/skills/x/SKILL.md"), undefined);
  assert.equal(skillSlugOf("/etc/skills/x/SKILL.md"), undefined);
});

test("a shell command is attributed when it looks like a write into a skill", () => {
  assert.deepEqual(skillsWrittenBy("cat > ~/work/skills/retro/SKILL.md <<'EOF'\n---\nagent: Ada\n---\nEOF"), ["retro"]);
  assert.deepEqual(skillsWrittenBy("sed -i 's/x/y/' /home/box/work/skills/a/SKILL.md; cp x /home/box/work/skills/b/run.sh"), ["a", "b"]);
  assert.deepEqual(skillsWrittenBy("cat /home/box/work/skills/retro/SKILL.md"), [], "a read is not a write");
  assert.deepEqual(skillsWrittenBy("echo hi > /tmp/out"), []);
});

test("the last writer is remembered across a restart, and the ledger tolerates a torn line", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-prov-"));
  try {
    const path = join(root, "skill-provenance.jsonl");
    const first = new SkillProvenance(path);
    assert.equal(first.noteWrite({ path: "/home/box/work/skills/retro/SKILL.md", agentId: "bob", agentName: "Bob", tool: "write_file" }), "retro");
    assert.equal(first.noteWrite({ path: "/home/box/work/notes.md", agentId: "bob", agentName: "Bob", tool: "write_file" }), undefined);
    assert.deepEqual(first.noteCommand({ command: "echo x >> ~/work/skills/retro/SKILL.md", agentId: "ada", agentName: "Ada" }), ["retro"]);
    assert.equal(first.writerOf("retro")?.agentName, "Ada");
    assert.equal(first.writerOf("retro")?.tool, "bash");

    appendFileSync(path, "{torn");
    const second = new SkillProvenance(path);
    assert.equal(second.writerOf("retro")?.agentId, "ada");
    assert.equal(second.writerOf("nothing"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
