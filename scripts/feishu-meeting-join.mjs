#!/usr/bin/env node
/**
 * Test the official meeting-bot join: `POST /open-apis/vc/v1/bots/join`.
 *
 *   node scripts/feishu-meeting-join.mjs [door-id] --meeting-number 123456789 [--password pw] [--leave]
 *
 * The request shape is read from larksuite/cli's own implementation
 * (shortcuts/vc/vc_meeting_join.go): body {meeting_no, password?, call_id?,
 * action?}, app identity via tenant_access_token. The scope is
 * vc:meeting.bot.join:write — granted by feishu-enable-meetings.mjs
 * --with-join-scope.
 *
 * What success means, and does not: the app bot appears in the participant list
 * (visible to everyone) and can use the in-meeting event/message APIs. It has
 * **no media face** — the official path cannot share a screen; that stays the
 * browser path (R37). Error codes worth knowing before blaming permissions:
 * 20017 = the tenant is not in the gray release (apply, don't debug);
 * 121003 = a join precondition failed (wrong number, password, waiting room,
 * meeting not started, bots barred by meeting settings).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const doorId = args.find(arg => !arg.startsWith("--")) ?? "feishu";
const flag = name => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const meetingNo = flag("meeting-number") ?? "";
const password = flag("password");
const envBase = doorId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

if (!/^\d{9}$/.test(meetingNo)) {
  console.error(
    "The meeting number must be exactly 9 digits (from the meeting link's tail).\n" +
      "Usage: node scripts/feishu-meeting-join.mjs [door-id] --meeting-number 123456789 [--password pw]"
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(homedir(), ".agentbox", "config.json"), "utf8"));
const appId = config.env?.[`${envBase}_APP_ID`];
const appSecret = config.env?.[`${envBase}_APP_SECRET`];
if (!appId || !appSecret) {
  console.error(`No ${envBase}_APP_ID / _APP_SECRET in ~/.agentbox/config.json.`);
  process.exit(1);
}

const host = process.env.FEISHU_DOMAIN === "lark" ? "open.larksuite.com" : "open.feishu.cn";

const tokenResponse = await fetch(`https://${host}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const tokenBody = await tokenResponse.json();
if (!tokenBody.tenant_access_token) {
  console.error(`No tenant token: ${JSON.stringify(tokenBody)}`);
  process.exit(1);
}

console.log(`Joining meeting ${meetingNo} as the "${doorId}" app bot…`);
const joinResponse = await fetch(`https://${host}/open-apis/vc/v1/bots/join`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${tokenBody.tenant_access_token}`,
  },
  // The shape from larksuite/cli's buildMeetingJoinBody: join_type 1 and the
  // number nested under join_identify — learned when the flat form answered
  // 99992402 with both fields named as missing.
  body: JSON.stringify({
    join_type: 1,
    join_identify: { meeting_no: meetingNo },
    ...(password ? { password } : {}),
  }),
});
const joinBody = await joinResponse.json();
console.log(`HTTP ${joinResponse.status}`);
console.log(JSON.stringify(joinBody, null, 2));

if (joinBody.code === 0) {
  console.log(
    "\n入会成功 — 参会人列表里应该出现应用机器人了。记下上面的 meeting.id,离会要用它。"
  );
} else if (joinBody.code === 20017) {
  console.log("\n20017 = 租户不在灰度内。这是申请早期访问的问题,不是配置错误。");
} else if (joinBody.code === 121003) {
  console.log(
    "\n121003 = 入会前置条件不满足:依次检查会议号、密码、会议是否进行中、等候室/入会审批、会议是否禁止应用机器人。" +
      "\n另外检查开放平台「权限可访问的数据范围」:按条件筛选 → 会议的归属者 包含 与应用的可用范围一致。"
  );
}
