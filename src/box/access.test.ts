/**
 * Tests for what a box says it is.
 *
 * The claims that matter are about the *default* and about the *words*, not about the
 * lookup: an unrecorded box must land on the class that promises nothing, and the shared
 * notice must name the consequence rather than the category.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PRIVATE_IS_ENFORCED, classifyBox, sharedNotice } from "./access.ts";

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

test("a box becomes private only because somebody said so, and says what that is worth", () => {
  // This test used to assert `notice === ""` — "a private box makes a promise instead of a
  // disclaimer" — which is how the regression got written and shipped. The premise was
  // wrong: a promise is only a promise if something keeps it, and nothing does. What the
  // config records is intent; what the surfaces say has to be the truth.
  const mine = classifyBox("agentbox-identity-dana", {
    boxes: { "agentbox-identity-dana": { access: "private" } },
  });
  assert.equal(mine.access, "private", "the operator's intent is not thrown away");
  assert.equal(mine.enforced, false, "but it is not in effect");
  assert.ok(mine.notice.length > 0, "and no surface may render it as a quiet, settled state");
  assert.match(mine.badge, /未生效/, "the badge carries it too, for surfaces with no room for a sentence");
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

test("marking a box private never makes the product quieter than leaving it alone", () => {
  // The regression this pins, live for a few hours on 2026-08-28: `access: "private"`
  // returned a class with an empty notice, so the shared sentence vanished from above the
  // screen, the agent's prompt paragraph vanished, and a tooltip fell through to
  // "只有你能打开这台箱子" — the strongest privacy claim in the product, from an `||`
  // fallback nobody decided on. None of steps 4-8 exists, so it was false for every box.
  //
  // The property that makes that unrepresentable: while nothing enforces privacy, no
  // config value may produce *less* warning than the default does.
  const byDefault = classifyBox("agentbox-box", {});
  const declared = classifyBox("agentbox-box", { boxes: { "agentbox-box": { access: "private" } } });

  assert.equal(declared.enforced, false, "nothing enforces it, and the class says so");
  assert.ok(declared.notice.length >= byDefault.notice.length, "at least as loud, never quieter");
  assert.match(declared.notice, /没有生效|未生效/, "and it leads with the correction");
  for (const consequence of ["屏幕", "文件", "命令历史", "备份"]) {
    assert.match(declared.notice, new RegExp(consequence));
  }
});

test("the enforced-private class is unreachable until the machinery exists", () => {
  // One switch, named, so that turning privacy on is a deliberate act in one place rather
  // than something that quietly becomes true when an unrelated config is edited.
  assert.equal(PRIVATE_IS_ENFORCED, false, "docs/18 steps 4-8 are unbuilt");
  assert.equal(
    classifyBox("b", { boxes: { b: { access: "private" } } }).notice === "",
    false,
    "so no box anywhere gets the silent, promise-making class"
  );
});
