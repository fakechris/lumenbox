#!/usr/bin/env node
/**
 * Grant a Feishu app the scopes that make it hear a group, by scan-and-confirm —
 * the same flow as feishu-enable-cards/docs, and for the same reason: an app made
 * through the SDK's scan flow is not owned by whoever is logged into the console,
 * so the console's one-click links answer "该应用不存在".
 *
 * The failure this fixes, measured on 2026-08-29: a second door (feishu-zongheng)
 * connected fine and its *private* messages arrived, but a message typed in a group
 * it had been added to never reached us at all — the ingress ledger showed one p2p
 * arrival and nothing else. A Feishu bot hears nothing from groups until its app
 * holds the scopes below; connecting the websocket is not the grant.
 *
 *   node scripts/feishu-enable-group-messages.mjs [door-id]
 *
 * door-id is the channel record's id (default "feishu"): it names which app's
 * credentials to read from the config env — "feishu" reads FEISHU_APP_ID,
 * "feishu-zongheng" reads FEISHU_ZONGHENG_APP_ID, the same one-rule derivation the
 * server uses.
 *
 * The scopes, and why these three:
 * - im:message.group_at_msg — messages that @ the bot in a group. The baseline.
 * - im:message.group_msg   — every message in groups the bot is in. What makes it
 *   behave like the personal bot: addressable without an @.
 * - im:chat:readonly       — read a chat's member list, which is how the adapter
 *   shows names instead of ou_… ids. The missing grant behind the logged
 *   "member names unavailable (400)".
 *
 * Scan the printed QR with the phone that owns the app and confirm; the page shows
 * exactly this diff. No restart afterwards — the websocket is already connected,
 * and the next message in the group simply arrives.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const doorId = process.argv[2] ?? "feishu";
const envBase = doorId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const config = JSON.parse(readFileSync(join(homedir(), ".agentbox", "config.json"), "utf8"));
const appId = config.env?.[`${envBase}_APP_ID`];
if (!appId) {
  console.error(
    `No ${envBase}_APP_ID in ~/.agentbox/config.json — is the "${doorId}" door set up?\n` +
      `Usage: node scripts/feishu-enable-group-messages.mjs [door-id]`
  );
  process.exit(1);
}

const lark = await import("@larksuiteoapi/node-sdk");

console.log(`Updating ${appId} (door "${doorId}"): the three scopes that make a group audible.\n`);

const result = await lark.registerApp({
  appId,
  addons: {
    scopes: {
      tenant: ["im:message.group_at_msg", "im:message.group_msg", "im:chat:readonly"],
    },
  },
  onQRCodeReady(info) {
    console.log("用飞书扫这个链接的二维码,在手机上确认(它只会显示这三项权限):\n");
    console.log(`  ${info.url}\n`);
    console.log(`二维码 ${Math.round(info.expireIn / 60)} 分钟内有效。等待确认…`);
  },
  onStatusChange(info) {
    if (info.status === "slow_down") console.log("(平台限速,继续等…)");
  },
});

console.log(`\n确认完成:${result.client_id} 能听见群聊了。`);
console.log("回到那个群发一条消息试试 — 不用重启任何东西,websocket 一直连着。");
