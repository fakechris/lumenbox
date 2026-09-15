import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeachDrafts, publishTeachingSkill } from "./teach-drafts.ts";
import { loadSkills } from "./skills.ts";

test("first approval creates the destination and publishes bytes that the real skill loader accepts", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-publication-"));
  const previous = process.env.AGENTBOX_WORK_DIR;
  process.env.AGENTBOX_WORK_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBOX_WORK_DIR;
    else process.env.AGENTBOX_WORK_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const fs = await import("../boxd/fs-service.ts");
  const local = (path: string) => path.replace(/^\/home\/box\/work/, root);
  const box = {
    writeFile: (path: string, content: string) => fs.writeFile({ path: local(path), content }),
    uploadFile: (path: string, base64: string) => fs.uploadFile({ path: local(path), base64 }),
    readFile: (path: string) => fs.readFile({ path: local(path) }),
    listDir: (path: string) => fs.listDir({ path: local(path) }),
  };
  const drafts = new TeachDrafts(join(root, "host-skills-drafts"));
  const skill = "---\nname: Resize images\ndescription: Resize an image to a chosen size\nscope: global\n---\nSelect {size} then Resize. Offer a dry run.\n";
  const draft = drafts.create({ boxId: "fixture", agentId: "ada", sessionId: "one", eventsPath: "/trace", skill, question: null });
  assert.deepEqual((await loadSkills(box)).skills, []);
  const approved = await drafts.approve(draft.id, draft.digest, "operator", async (_box, path, content) => publishTeachingSkill(box, path, content));
  assert.equal(approved.status, "published");
  const loaded = await loadSkills(box);
  assert.equal(loaded.skills.length, 1);
  assert.equal(loaded.skills[0]?.name, "Resize images");
  const read = await box.readFile(loaded.skills[0]!.path);
  assert.equal(read.content, skill);
});
