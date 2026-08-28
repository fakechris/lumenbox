/**
 * Tests for what a box says it is.
 *
 * The claims that matter are about the *default* and about the *words*, not about the
 * lookup: an unrecorded box must land on the class that promises nothing, and the shared
 * notice must name the consequence rather than the category.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBox, sharedNotice } from "./access.ts";

test("a box nobody classified is shared, not private", () => {
  // The direction of this default is the whole design (docs/18 §0). Every mechanism that
  // would make a box private — one session resolver, box lineage on agents, the takeover
  // state — is unbuilt, so a box that defaulted to private would be making a promise the
  // software cannot keep, which is the failure v1 through v3 kept re-inventing.
  const unknown = classifyBox("agentbox-box", {});
  assert.equal(unknown.access, "shared");
  assert.ok(unknown.notice.length > 0, "and it says so");

  // Including when there is a record that does not classify it.
  assert.equal(classifyBox("agentbox-box", { boxes: {} }).access, "shared");
  assert.equal(
    classifyBox("agentbox-box", { boxes: { "agentbox-other": { access: "private" } } }).access,
    "shared",
    "another box's class is not this box's class"
  );
});

test("a box becomes private only because somebody said so, and then makes no disclaimer", () => {
  const mine = classifyBox("agentbox-identity-dana", {
    boxes: { "agentbox-identity-dana": { access: "private" } },
  });
  assert.equal(mine.access, "private");
  assert.equal(mine.notice, "", "there is nothing to warn about; the surface renders nothing");
  assert.ok(mine.badge.length > 0, "but it still says which kind it is");
});

test("the shared notice names the consequence, and the group when there is one", () => {
  // "This box is shared" reads as an administrative detail. What a person is actually
  // deciding is whether to type a password, so the sentence has to reach the screens, the
  // files, the command history and the backups — the four places their session survives.
  const named = classifyBox("agentbox-box", {
    boxes: { "agentbox-box": { access: "shared", group: "平台组" } },
  });
  assert.equal(named.group, "平台组");
  assert.match(named.notice, /平台组/, "the label says who 'shared' means");
  for (const consequence of ["屏幕", "文件", "命令历史", "备份"]) {
    assert.match(named.notice, new RegExp(consequence), `the notice must mention ${consequence}`);
  }

  // With no group named, it still says something true rather than leaving a blank.
  assert.match(sharedNotice(), /所有能打开它的人/);
  assert.doesNotMatch(sharedNotice(), /undefined/);
});

test("the notice does not claim anything is prevented", () => {
  // A shared box labels; it does not refuse (docs/18 §3.1). Wording that implied a guard
  // — "禁止", "不允许" — would be the intermittent-warning failure in text form: people
  // would rely on an enforcement that does not exist anywhere in the system.
  const notice = classifyBox("agentbox-box", {}).notice;
  for (const forbidding of ["禁止", "不允许", "不能登录", "会被阻止"]) {
    assert.doesNotMatch(notice, new RegExp(forbidding), `the label must not imply enforcement`);
  }
});
