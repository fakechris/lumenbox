#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentboxDir = join(homedir(), ".agentbox");
const configPath = join(agentboxDir, "config.json");
if (!existsSync(agentboxDir)) {
  mkdirSync(agentboxDir, { recursive: true });
}

let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {}
}
config.env = config.env || {};

const lark = await import("@larksuiteoapi/node-sdk");

console.log("\n=======================================================");
console.log("  LumenBox 企业版 - 飞书应用一键创建与授权向导");
console.log("=======================================================\n");

const result = await lark.registerApp({
  createOnly: true,
  appPreset: {
    name: "LumenBox 企业助手",
    desc: "MacMini 24/7 企业智能协同 Agent 平台"
  },
  addons: {
    scopes: {
      tenant: [
        "im:message",
        "im:message.group_at_msg",
        "im:message.group_msg",
        "im:chat:readonly",
        "contact:user.base:readonly",
        "docx:document:readonly",
        "wiki:wiki:readonly"
      ]
    },
    events: {
      items: {
        tenant: ["im.message.receive_v1"]
      }
    },
    callbacks: {
      items: ["card.action.trigger"]
    }
  },
  onQRCodeReady(info) {
    console.log("=======================================================");
    console.log("【飞书一键创建链接】");
    console.log("请点击或在手机飞书扫码打开以下授权链接进行一键创建：\n");
    console.log(info.url);
    console.log("\n链接有效时间约 " + Math.round(info.expireIn / 60) + " 分钟。等待手机端确认中...");
    console.log("=======================================================\n");
  },
  onStatusChange(info) {
    if (info.status === "slow_down") {
      console.log("(飞书平台限速中，继续等待...)");
    } else if (info.status === "polling") {
      process.stdout.write(".");
    }
  }
});

console.log("\n\n🎉 飞书应用创建成功！");
console.log("- App ID (Client ID): " + result.client_id);
console.log("- App Secret: " + result.client_secret.slice(0, 6) + "******");

config.env.FEISHU_APP_ID = result.client_id;
config.env.FEISHU_APP_SECRET = result.client_secret;

writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
console.log("\n已自动更新配置至: " + configPath);

// Update or create channels.json
const channelsPath = join(agentboxDir, "channels.json");
let channelsData = { channels: [] };
if (existsSync(channelsPath)) {
  try {
    channelsData = JSON.parse(readFileSync(channelsPath, "utf8"));
  } catch {}
}
channelsData.channels = channelsData.channels || [];
let boxId = "box_b551a22b-88bc-49f5-8e78-795a9e74ccd4";
try {
  const boxJson = JSON.parse(readFileSync(join(agentboxDir, "agents", "box.json"), "utf8"));
  if (boxJson.id) boxId = boxJson.id;
} catch {}

if (!channelsData.channels.some(c => c.type === "feishu")) {
  channelsData.channels.push({
    id: "feishu",
    type: "feishu",
    name: "feishu",
    incarnation: 1,
    boxId: boxId,
    createdAt: new Date().toISOString()
  });
  writeFileSync(channelsPath, JSON.stringify(channelsData, null, 2), "utf8");
  console.log("已自动在 channels.json 中注册 feishu 通道");
}
