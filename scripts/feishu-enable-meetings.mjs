#!/usr/bin/env node
/**
 * Subscribe a Feishu app to meeting invitations, by scan-and-confirm — the same
 * flow as the other feishu-enable-* scripts, reaching the `events` addon this
 * time (the SDK's registerApp supports scopes, events and callbacks alike).
 *
 *   node scripts/feishu-enable-meetings.mjs [door-id] [--with-join-scope]
 *
 * door-id is the channel record's id (default "feishu"), resolved to credentials
 * by the same envBase rule as everywhere else.
 *
 * What this enables (roadmap R37): inviting the bot into a video meeting sends
 * `vc.bot.meeting_invited_v1` over the websocket the bot already holds; the
 * bridge turns it into a message telling the agent to join from the box's own
 * browser and share its screen.
 *
 * --with-join-scope additionally requests `vc:meeting.bot.join:write` — the
 * *official* meeting-bot join capability. It is in limited beta: if the tenant
 * is not in the gray release, the confirm page may refuse it or later calls
 * return code 20017 (ErrNotInGray), which is an access-application problem and
 * not a configuration one. The browser-join path needs none of it, which is why
 * this flag is off by default.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const withJoinScope = args.includes("--with-join-scope");
const doorId = args.find(arg => !arg.startsWith("--")) ?? "feishu";
const envBase = doorId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const config = JSON.parse(readFileSync(join(homedir(), ".agentbox", "config.json"), "utf8"));
const appId = config.env?.[`${envBase}_APP_ID`];
if (!appId) {
  console.error(
    `No ${envBase}_APP_ID in ~/.agentbox/config.json — is the "${doorId}" door set up?\n` +
      `Usage: node scripts/feishu-enable-meetings.mjs [door-id] [--with-join-scope]`
  );
  process.exit(1);
}

const lark = await import("@larksuiteoapi/node-sdk");

console.log(
  `Updating ${appId} (door "${doorId}"): the meeting-invitation event` +
    (withJoinScope ? " and the beta bot-join scope" : "") +
    ".\n"
);

const result = await lark.registerApp({
  appId,
  addons: {
    events: { items: { tenant: ["vc.bot.meeting_invited_v1"] } },
    ...(withJoinScope ? { scopes: { tenant: ["vc:meeting.bot.join:write"] } } : {}),
  },
  onQRCodeReady(info) {
    console.log("用飞书扫这个链接的二维码,在手机上确认(它只会显示这次的变更):\n");
    console.log(`  ${info.url}\n`);
    console.log(`二维码 ${Math.round(info.expireIn / 60)} 分钟内有效。等待确认…`);
  },
  onStatusChange(info) {
    if (info.status === "slow_down") console.log("(平台限速,继续等…)");
  },
});

console.log(`\n确认完成:${result.client_id} 能收到会议邀请了。`);
console.log("开个会,把机器人像真人一样邀进来 — 事件走已有的长连接,不用重启。");
