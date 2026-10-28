#!/usr/bin/env node
/**
 * Where would a click land? The decision model's box against the main model's own coordinates (INV-1419).
 *
 *   node --experimental-transform-types scripts/eval-click-target.mjs [--model]
 *
 * Needs TYPESAFE_TOKEN; `--model` also asks the configured provider (the same one `agentbox web`
 * would use, from ~/.agentbox/config.json) for coordinates on the same screenshot. Not part of
 * `npm test`: it spends money and reaches the network. The screenshot is our own team room
 * (assets/screens/team-room.png, 1280x800); each target's rectangle was measured on it by hand.
 * A hit is a centre inside the rectangle. The absent target must be refused, not clicked.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfigEnv, loadConfig } from "../src/config.ts";
import { CLICK_AT, locate } from "../src/host/computer-vision.ts";
import { jevClient } from "../src/host/jev.ts";

const SHOT = new URL("../assets/screens/team-room.png", import.meta.url).pathname;
const CASES = [
  { target: "the Send button", rect: [712, 718, 775, 752] },
  { target: "the 'Take over' button", rect: [1180, 137, 1257, 167] },
  { target: "the settings gear icon in the top bar", rect: [1200, 95, 1226, 118] },
  { target: "the 'record' toggle", rect: [1118, 140, 1172, 165] },
  { target: "the 'Configure' link next to the team room menu", rect: [590, 143, 648, 162] },
  { target: "the Files tab in the right panel", rect: [898, 142, 935, 162] },
  { target: "the message input box", rect: [247, 697, 700, 752] },
  { target: "the agent Ada in the sidebar", rect: [12, 218, 215, 270] },
  { target: "the new browser tab (+) button", rect: [284, 8, 306, 32] },
  { target: "the 'Delete account' button", rect: null },
];

const inside = (x, y, r) => r !== null && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

async function modelPoint(client, profile, png, target) {
  const response = await client.messages.create({
    model: profile.model,
    max_tokens: 200,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "text", text: `This screenshot is 1280x800. Where would you click for: ${target}? Reply with JSON only: {"x": <int>, "y": <int>}, or {"none": true} if it is not on the screen.` },
    ] }],
  });
  const text = response.content.map(part => (part.type === "text" ? part.text : "")).join("");
  const match = /\{[\s\S]*\}/.exec(text);
  return match ? JSON.parse(match[0]) : { none: true };
}

const ask = jevClient();
if (ask === undefined) {
  console.log("No TYPESAFE_TOKEN; nothing to evaluate.");
  process.exit(0);
}
const jpegPath = join(tmpdir(), `eval-click-${process.pid}.jpg`);
execFileSync("ffmpeg", ["-loglevel", "error", "-i", SHOT, "-q:v", "4", "-y", jpegPath]);
const jpeg = readFileSync(jpegPath).toString("base64");
rmSync(jpegPath);
const png = readFileSync(SHOT).toString("base64");

let model;
if (process.argv.includes("--model")) {
  applyConfigEnv(loadConfig());
  const { resolveProvider, createClient } = await import("../src/host/provider.ts");
  const profile = resolveProvider(undefined, loadConfig().provider);
  model = { profile, client: createClient(profile) };
}

let jevHits = 0;
let modelHits = 0;
for (const c of CASES) {
  const started = Date.now();
  const found = await locate(ask, jpeg, c.target);
  const jevOk = "why" in found ? c.rect === null : inside(found.x, found.y, c.rect);
  jevHits += jevOk ? 1 : 0;
  let modelText = "";
  if (model !== undefined) {
    const point = await modelPoint(model.client, model.profile, png, c.target).catch(error => ({ error: String(error) }));
    const modelOk = point.none === true ? c.rect === null : typeof point.x === "number" && inside(point.x, point.y, c.rect);
    modelHits += modelOk ? 1 : 0;
    modelText = ` | model ${modelOk ? "hit " : "MISS"} ${JSON.stringify(point)}`;
  }
  const where = "why" in found ? `refused` : `(${found.x}, ${found.y}) ${found.confidence.toFixed(2)}`;
  console.log(`${jevOk ? "hit " : "MISS"} ${String(Date.now() - started).padStart(4)}ms  ${c.target}: jev ${where}${modelText}`);
}
console.log(`\ndecision model: ${jevHits}/${CASES.length} (clicks at or above ${CLICK_AT})${model !== undefined ? `; ${model.profile.label} ${model.profile.model}: ${modelHits}/${CASES.length}` : ""}`);
