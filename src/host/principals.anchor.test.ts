/**
 * Email-anchored identity merge (docs/48, INV-154).
 *
 * The one rule that matters: an email can only pull a *new* channel identity toward a *known*
 * person; it never invents a person and never rewrites who an existing identity belongs to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Principals, emailAnchor } from "./principals.ts";

function fresh(): { p: Principals; cleanup: () => void; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "principals-anchor-"));
  const path = join(dir, "principals.json");
  return { p: new Principals(path), cleanup: () => rmSync(dir, { recursive: true, force: true }), path };
}

test("emailAnchor lowercases so casing never splits one person in two", () => {
  assert.equal(emailAnchor(" Alice@Corp.com "), "email:alice@corp.com");
});

test("a new channel identity links to the one person holding that email", () => {
  const { p, cleanup } = fresh();
  try {
    // Alice is configured with her Feishu identity and her work email.
    p.save([{ id: "alice", name: "Alice", role: "driver", identities: ["feishu:ou_a"], anchors: ["email:alice@corp.com"] }]);
    assert.equal(p.roleOf("feishu:ou_a"), "driver");
    // Her DingTalk identity appears later carrying the same email → linked to her.
    assert.equal(p.linkByEmail("dingtalk:xyz", "Alice@corp.com"), "linked");
    // Now DingTalk resolves to Alice, same person, same authority — no re-auth needed.
    assert.equal(p.roleOf("dingtalk:xyz"), "driver");
    assert.equal(p.resolve("dingtalk:xyz").id, "alice");
    // Idempotent: linking again is a no-op "already".
    assert.equal(p.linkByEmail("dingtalk:xyz", "alice@corp.com"), "already");
  } finally {
    cleanup();
  }
});

test("no matching person means no merge and no invented principal", () => {
  const { p, cleanup } = fresh();
  try {
    p.save([{ id: "alice", name: "Alice", role: "driver", identities: ["feishu:ou_a"], anchors: ["email:alice@corp.com"] }]);
    // A stranger's email nobody holds: stays the ad-hoc viewer, no principal created.
    assert.equal(p.linkByEmail("dingtalk:stranger", "bob@corp.com"), "no-match");
    assert.equal(p.roleOf("dingtalk:stranger"), "viewer");
    assert.equal(p.list().length, 1, "no principal was minted from an email");
  } finally {
    cleanup();
  }
});

test("an email held by two people never auto-merges — it is a person's call", () => {
  const { p, cleanup } = fresh();
  try {
    p.save([
      { id: "a", name: "A", role: "driver", identities: ["feishu:ou_a"], anchors: ["email:shared@corp.com"] },
      { id: "b", name: "B", role: "admin", identities: ["feishu:ou_b"], anchors: ["email:shared@corp.com"] },
    ]);
    assert.equal(p.linkByEmail("dingtalk:new", "shared@corp.com"), "conflict");
    assert.equal(p.roleOf("dingtalk:new"), "viewer", "a conflict must not grant anyone's authority");
  } finally {
    cleanup();
  }
});

test("an email never rewrites who an existing identity belongs to", () => {
  const { p, cleanup } = fresh();
  try {
    p.save([
      { id: "alice", name: "Alice", role: "admin", identities: ["dingtalk:xyz"], anchors: [] },
      { id: "bob", name: "Bob", role: "viewer", identities: ["feishu:ou_b"], anchors: ["email:alice@corp.com"] },
    ]);
    // dingtalk:xyz is already Alice's (admin). Bob happens to carry alice@corp as his anchor.
    // linkByEmail must NOT move dingtalk:xyz to Bob — existing authority is never rewritten.
    assert.equal(p.linkByEmail("dingtalk:xyz", "alice@corp.com"), "already");
    assert.equal(p.resolve("dingtalk:xyz").id, "alice");
    assert.equal(p.roleOf("dingtalk:xyz"), "admin");
  } finally {
    cleanup();
  }
});

test("noteEmail anchors a known person and only a known person", () => {
  const { p, cleanup } = fresh();
  try {
    p.save([{ id: "alice", name: "Alice", role: "driver", identities: ["feishu:ou_a"], anchors: [] }]);
    // Learning Alice's email records it on her.
    p.noteEmail("feishu:ou_a", "Alice@corp.com");
    assert.deepEqual(p.resolve("feishu:ou_a").anchors, ["email:alice@corp.com"]);
    // A later DingTalk identity with the same email now links to her.
    assert.equal(p.linkByEmail("dingtalk:xyz", "alice@corp.com"), "linked");
    // noteEmail on an unknown identity mints nothing.
    p.noteEmail("telegram:999", "ghost@corp.com");
    assert.equal(p.isKnown("telegram:999"), false);
  } finally {
    cleanup();
  }
});

test("anchors survive a reload", () => {
  const { p, cleanup, path } = fresh();
  try {
    p.save([{ id: "alice", name: "Alice", role: "driver", identities: ["feishu:ou_a"], anchors: ["email:alice@corp.com"] }]);
    const reopened = new Principals(path);
    assert.equal(reopened.linkByEmail("dingtalk:xyz", "alice@corp.com"), "linked");
    assert.equal(reopened.resolve("dingtalk:xyz").id, "alice");
  } finally {
    cleanup();
  }
});
