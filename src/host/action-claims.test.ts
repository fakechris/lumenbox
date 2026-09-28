import { test } from "node:test";
import assert from "node:assert/strict";
import { claimedActions, describeClaim, satisfies, unmetClaim } from "./action-claims.ts";

test("completed send claims match in both languages; future, conditional and third-person forms do not", () => {
  for (const line of [
    "I've sent the email to Wang.",
    "I sent it just now.",
    "Done — sent.",
    "The email has been sent.",
    "邮件已发送给王总。",
    "已经帮你回复了。",
    "发送成功，他应该很快能看到。",
    "好了，已发出。",
  ]) assert.deepEqual(claimedActions(line), ["send"], line);
  for (const line of [
    "I'll send it once you confirm.",
    "I can send it if you want.",
    "Should I send it now?",
    "我会发给他。",
    "如果需要我可以发。",
    "要不要我现在发？",
    "你已发送的那封邮件我看到了。",
    "对方已回复：明天见。",
    "The email was sent last week by the vendor.",
  ]) assert.deepEqual(claimedActions(line), [], line);
});

test("save, schedule and check claims match only in the completed tense", () => {
  assert.deepEqual(claimedActions("I've saved that to your notes."), ["save"]);
  assert.deepEqual(claimedActions("记住了，下次用东京区域。"), ["save"]);
  assert.deepEqual(claimedActions("已保存到 notes.md。"), ["save"]);
  assert.deepEqual(claimedActions("I'll remember that."), []);
  assert.deepEqual(claimedActions("我会记住的。"), []);

  assert.deepEqual(claimedActions("I've scheduled it for Tuesday."), ["schedule"]);
  assert.deepEqual(claimedActions("I set a reminder for 9am."), ["schedule"]);
  assert.deepEqual(claimedActions("已安排在周二上午。"), ["schedule"]);
  assert.deepEqual(claimedActions("提醒设好了。"), ["schedule"]);
  assert.deepEqual(claimedActions("设了提醒，周二九点。"), ["schedule"]);
  assert.deepEqual(claimedActions("I can set a reminder if you like."), []);
  assert.deepEqual(claimedActions("要不要我帮你定时？"), []);

  assert.deepEqual(claimedActions("I've checked the release page: it exists."), ["check"]);
  assert.deepEqual(claimedActions("Checked: released 2026-08-14."), ["check"]);
  assert.deepEqual(claimedActions("我查过了，两个都在 8 月发布。"), ["check"]);
  assert.deepEqual(claimedActions("已核对，数字一致。"), ["check"]);
  assert.deepEqual(claimedActions("Let me check that."), []);
  assert.deepEqual(claimedActions("你查过吗？"), []);
  assert.deepEqual(claimedActions("我没查过。"), []);
  assert.deepEqual(claimedActions("我不确定这个型号，需要查一下。"), []);
});

test("a claim is satisfied by a tool of its category, and only that category", () => {
  // send: reach-tier tools, MCP tools, connectors, UI actions, bash; not a read or a note.
  assert.equal(satisfies("send", "google__send_email"), true);
  assert.equal(satisfies("send", "connector_request"), false, "a GET-shaped connector call is observe");
  assert.equal(satisfies("send", "browser_act"), true);
  assert.equal(satisfies("send", "computer"), true);
  assert.equal(satisfies("send", "SendToAgent"), true);
  assert.equal(satisfies("send", "read_file"), false);
  assert.equal(satisfies("send", "RememberFact"), false);
  // save
  assert.equal(satisfies("save", "RememberFact"), true);
  assert.equal(satisfies("save", "write_file"), true);
  assert.equal(satisfies("save", "WebSearch"), false);
  // schedule
  assert.equal(satisfies("schedule", "google_calendar__create_event"), true);
  assert.equal(satisfies("schedule", "write_file"), true, "a routine is a skill file with a schedule");
  assert.equal(satisfies("schedule", "ReadHistory"), false);
  // check
  assert.equal(satisfies("check", "WebSearch"), true);
  assert.equal(satisfies("check", "browser_snapshot"), true);
  assert.equal(satisfies("check", "bash"), true);
  assert.equal(satisfies("check", "SetPlan"), false);
  assert.equal(satisfies("check", "RememberFact"), false);
});

test("unmetClaim names the first claim no call this turn backs", () => {
  assert.equal(unmetClaim("邮件已发送。", []), "send");
  assert.equal(unmetClaim("邮件已发送。", ["read_file", "WebSearch"]), "send");
  assert.equal(unmetClaim("邮件已发送。", ["read_file", "google__send_email"]), undefined);
  assert.equal(unmetClaim("I checked it, and I've saved it.", ["WebFetch"]), "save");
  assert.equal(unmetClaim("I checked it, and I've saved it.", ["WebFetch", "RememberFact"]), undefined);
  assert.equal(unmetClaim("我会发给他，你确认一下。", []), undefined);
  assert.match(describeClaim("send", true), /发送/);
  assert.match(describeClaim("schedule", false), /reminder/);
});
