#!/usr/bin/env node
// Duty cycle, interruption rate and conduct counters from the ledgers. Reads only.
//   node scripts/autonomy-metrics.mjs [--days 7] [--home ~/.agentbox] [--log ~/Library/Logs/LumenBox/server.log]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { computeMetrics, renderMetrics } from "../src/host/autonomy-metrics.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const days = Number(option("days", "7"));
const home = option("home", process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox"));
const logPath = option("log", join(homedir(), "Library", "Logs", "LumenBox", "server.log"));
const lines = path => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line !== "") : []);

const toMs = Date.now();
const metrics = computeMetrics({
  turns: lines(join(home, "turns.jsonl")),
  usage: lines(join(home, "usage.jsonl")),
  schedules: lines(join(home, "schedules.jsonl")),
  tasks: lines(join(home, "tasks.jsonl")),
  log: lines(logPath),
  fromMs: toMs - days * 86_400_000,
  toMs,
});
console.log(renderMetrics(metrics));
