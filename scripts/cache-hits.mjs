#!/usr/bin/env node
/**
 * How much of each turn's first request the provider served from cache (INV-767).
 *
 * Reads the local ledgers only — no network, no credentials — and prints one line per
 * first round plus a summary, so the question "did the change help" is one command a week
 * later rather than an argument. The number that matters is the first round of a turn: later
 * rounds share their request prefix with the round before and hit regardless; the first
 * round is where a system prompt that changed since the previous turn, or a first message
 * replayed differently, costs the whole prefix.
 *
 *   node scripts/cache-hits.mjs            # ~/.agentbox
 *   node scripts/cache-hits.mjs --since 2026-09-27 --home /path/to/.agentbox
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const home = flag("--home") ?? process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
const since = flag("--since") ?? "";

const lines = file => {
  try { return readFileSync(join(home, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
const begins = new Map(lines("turns.jsonl").filter(r => r.event === "begin").map(r => [r.id, r]));
const first = lines("usage.jsonl")
  .filter(r => r.kind === "turn" && r.round === 0 && r.at >= since)
  .sort((a, b) => a.at.localeCompare(b.at));

let hits = 0, reads = 0, fresh = 0, only128 = 0;
for (const row of first) {
  const begin = begins.get(row.turnId);
  const input = (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0);
  const read = row.cacheReadTokens ?? 0;
  reads += read; fresh += row.inputTokens ?? 0;
  if (read > 128) hits += 1;
  if (read === 128) only128 += 1;
  const share = input > 0 ? Math.round((read / input) * 100) : 0;
  const fp = begin?.promptFingerprint;
  const hashes = fp
    ? `s:${fp.stable.slice(0, 6)} v:${fp.volatile.slice(0, 6)} t:${fp.tools.slice(0, 6)}${begin.promptChanged?.length ? ` changed:${begin.promptChanged.join("+")}` : ""}${begin.volatileInTail ? " tail" : ""}`
    : (begin?.promptHash ?? "").slice(0, 8);
  console.log(`${row.at.slice(0, 19)} ${(row.agentName ?? "").padEnd(8)} ${(row.conversation ?? "main").slice(0, 24).padEnd(24)} read ${String(read).padStart(6)} of ${String(input).padStart(6)} (${String(share).padStart(3)}%) ${hashes}`);
}
const total = reads + fresh;
console.log(`\n${first.length} first rounds since ${since || "the start of the log"}: ${hits} read more than 128 tokens, ${only128} read exactly 128; ` +
  `${reads} of ${total} first-round input tokens from cache (${total > 0 ? Math.round((reads / total) * 100) : 0}%).`);
