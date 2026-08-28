#!/usr/bin/env node
/**
 * Grant the existing Feishu app the two read-only scopes the document reader needs,
 * by scan-and-confirm — the same flow that turned on card callbacks, and for the same
 * reason: this app was created through the SDK's scan flow, so the console's one-click
 * links answer "该应用不存在" to whoever is logged in there.
 *
 *   node scripts/feishu-enable-docs.mjs
 *
 * Scan the printed URL's QR with the phone that owns the app and confirm; the page
 * shows exactly the two scopes being added. After confirming, the ReadFeishuDoc tool
 * works with no restart — the token the SDK mints next carries the new scopes.
 *
 * The scopes, and why only these:
 * - docx:document:readonly — read the plain text of new-style online documents.
 * - wiki:wiki:readonly — resolve a wiki page to the document it wraps.
 * Nothing writable, nothing about drive files: the reader's whole scope is "read the
 * document a person pasted", and the grant should say no more than that.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const config = JSON.parse(readFileSync(join(homedir(), ".agentbox", "config.json"), "utf8"));
const appId = config.env?.FEISHU_APP_ID;
if (!appId) {
  console.error("No FEISHU_APP_ID in ~/.agentbox/config.json — is the Feishu channel set up?");
  process.exit(1);
}

const lark = await import("@larksuiteoapi/node-sdk");

console.log(`Updating ${appId}: adding docx:document:readonly and wiki:wiki:readonly.\n`);

const result = await lark.registerApp({
  appId,
  addons: {
    scopes: { tenant: ["docx:document:readonly", "wiki:wiki:readonly"] },
  },
  onQRCodeReady(info) {
    console.log("用飞书扫这个链接的二维码,在手机上确认(它只会显示这两项只读权限):\n");
    console.log(`  ${info.url}\n`);
    console.log(`二维码 ${Math.round(info.expireIn / 60)} 分钟内有效。等待确认…`);
  },
  onStatusChange(info) {
    if (info.status === "slow_down") console.log("(平台限速,继续等…)");
  },
});

console.log(`\n确认完成:${result.client_id} 可以读文档了。`);
console.log("现在把一个飞书文档链接丢给机器人试试 — 不用重启任何东西。");
