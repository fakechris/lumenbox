/**
 * Live smoke for the Feishu adapter, against the real API through our own code path.
 *
 * Reads FEISHU_APP_ID / FEISHU_APP_SECRET from the environment. Connects the long
 * connection (which proves the credentials and prints any inbound event it sees),
 * finds a chat the bot is in, and walks the outbound surface in order: task card,
 * two in-place updates, a result message, an image. Exits nonzero when a step fails,
 * because a smoke that shrugs is not a smoke.
 *
 *   FEISHU_APP_ID=… FEISHU_APP_SECRET=… node --experimental-transform-types scripts/feishu-smoke.mjs
 */

import { FeishuChannel } from "../src/channels/feishu.ts";

const appId = process.env.FEISHU_APP_ID ?? "";
const appSecret = process.env.FEISHU_APP_SECRET ?? "";
if (appId === "" || appSecret === "") {
  console.error("set FEISHU_APP_ID and FEISHU_APP_SECRET");
  process.exit(2);
}

const log = line => console.error(`[smoke] ${line}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const base = process.env.FEISHU_DOMAIN === "lark"
  ? "https://open.larksuite.com"
  : "https://open.feishu.cn";

async function rest(path, options = {}, token) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const parsed = await response.json();
  if (parsed.code !== 0 && parsed.code !== undefined) {
    throw new Error(`${path}: code ${parsed.code} ${parsed.msg}`);
  }
  return parsed;
}

// ── 1. credentials and identity ────────────────────────────────────────────────
const token = (
  await rest("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
).tenant_access_token;
log("tenant token: ok");

const bot = await rest("/open-apis/bot/v3/info", { method: "GET" }, token);
log(`bot: ${bot.bot?.app_name ?? "?"} (open_id ${bot.bot?.open_id ?? "?"})`);

// ── 2. the long connection, through our adapter ────────────────────────────────
const channel = new FeishuChannel(appId, appSecret, log);
await channel.start(async message => {
  log(`INBOUND ${JSON.stringify(message)}`);
  return "smoke: received — the adapter answers by push, this line is the wire reply.";
});
log("websocket: started");

// ── 3. a chat to talk to ───────────────────────────────────────────────────────
const chats = await rest("/open-apis/im/v1/chats?page_size=20", { method: "GET" }, token);
const items = chats.data?.items ?? [];
if (items.length === 0) {
  log("the bot is in no chat: add it to a group, then re-run. WS stays up 60s for inbound tests…");
  await sleep(60_000);
  process.exit(1);
}
const chat = items[0];
const chatKey = `feishu:${chat.chat_id}`;
log(`chat: ${chat.name ?? chat.chat_id} (${items.length} total)`);

// ── 4. outbound surface, in the order a task uses it ───────────────────────────
const card = {
  title: "smoke: 整理上周数据周报",
  agentName: "Rex",
  requesterLabel: "chris",
  status: "queued",
  ahead: 1,
};
const handle = await channel.postTaskCard(chatKey, card);
if (handle === undefined) throw new Error("postTaskCard returned no handle");
log(`task card posted: ${handle}`);
await sleep(1500);

await channel.updateTaskCard(handle, {
  ...card,
  status: "working",
  action: "bash: build-report --week 34",
  ahead: undefined,
});
log("card updated: working");
await sleep(1500);

await channel.updateTaskCard(handle, { ...card, status: "done", ahead: undefined });
log("card updated: done");

await channel.sendToChat(chatKey, "smoke: 任务完成 — 这是异步结果推送的样子。");
log("result message: sent");

// 1x1 PNG, enough to prove upload-then-reference works.
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await channel.sendImage(chatKey, pixel);
log("image: sent");

log("outbound surface: ALL OK. WS stays up 45s — @ the bot in the group to test inbound…");
await sleep(45_000);
process.exit(0);
