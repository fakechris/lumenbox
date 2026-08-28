#!/usr/bin/env node
/**
 * Turn on card callbacks for the existing Feishu app, by scan-and-confirm.
 *
 * The failure this replaces: pressing any card button popped "该应用尚未配置卡片回调"
 * at the person, and the dialog's own 一键配置 link answered "该应用不存在" — the
 * console deep link only works when the logged-in browser account owns the app, and an
 * app created through the SDK's scan flow usually is not owned by whoever is logged into
 * the console. So the consent card's buttons were dead from the day they shipped, and the
 * typed word path ("允许"/"拒绝") silently covered for them.
 *
 * The SDK's registerApp flow updates an existing app's config the same way the app was
 * created: a QR code, scanned by the phone that owns the app, showing exactly the diff
 * being authorized — here, the `card.action.trigger` callback. No console, no deep link.
 *
 *   node scripts/feishu-enable-cards.mjs
 *
 * Scan the printed URL's QR with Feishu, confirm, and buttons start arriving over the
 * websocket the bot already holds. No code change and no restart needed afterwards.
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

console.log(`Updating ${appId}: enabling the card.action.trigger callback.\n`);

const result = await lark.registerApp({
  appId,
  addons: {
    callbacks: { items: ["card.action.trigger"] },
  },
  onQRCodeReady(info) {
    console.log("用飞书扫这个链接的二维码,在手机上确认(它只会显示这一项变更):\n");
    console.log(`  ${info.url}\n`);
    console.log(`二维码 ${Math.round(info.expireIn / 60)} 分钟内有效。等待确认…`);
  },
  onStatusChange(info) {
    if (info.status === "slow_down") console.log("(平台限速,继续等…)");
  },
});

console.log(`\n确认完成:${result.client_id} 的卡片回调已开通。`);
console.log("现在去按一个卡片按钮试试 — 不用重启任何东西。");
