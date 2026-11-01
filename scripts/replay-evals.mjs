#!/usr/bin/env node
/**
 * Replays an agent's eval cases under its current prompt and reports the pass rate (INV-1474).
 *
 *   node --experimental-transform-types scripts/replay-evals.mjs <agent> [--dir ~/.agentbox/evals] [--limit N]
 *
 * Each case is a reply the answer review judged bad (eval-cases.ts), kept with the hashes of the
 * agent's version at the time. The request is sent again to the same agent name on the real
 * stack with the configured provider (the one `agentbox web` would use), the answer is judged by
 * the same review prompt, and the result is one line per case: recorded label → label now, and
 * which of the agent's parts changed since (agent-version.ts). Not part of `npm test`: it spends
 * money and reaches the network. No cases is a quiet exit, not an error.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { applyConfigEnv, loadConfig } from "../src/config.ts";
import { agentVersionOf, versionDiff } from "../src/host/agent-version.ts";
import { AnswerReviewer } from "../src/host/answer-review.ts";
import { readEvalCases } from "../src/host/eval-cases.ts";
import { buildSystemPrompt } from "../src/host/prompt.ts";
import { readStanding } from "../src/host/standing.ts";

const flag = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const agentName = process.argv.slice(2).find(arg => !arg.startsWith("--") && process.argv[process.argv.indexOf(arg) - 1]?.startsWith("--") !== true);
if (agentName === undefined) {
  console.error("Usage: replay-evals.mjs <agent> [--dir <evals dir>] [--limit N]");
  process.exit(2);
}
const dir = flag("--dir") ?? join(process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox"), "evals");
const limit = Number(flag("--limit") ?? 50);
const cases = readEvalCases(dir, agentName).slice(-limit);
if (cases.length === 0) {
  console.log(`No eval cases for ${agentName} under ${dir}; nothing to replay.`);
  process.exit(0);
}

applyConfigEnv(loadConfig());
const { resolveProvider, createClient } = await import("../src/host/provider.ts");
const provider = resolveProvider(process.env.AGENTBOX_PROVIDER ?? loadConfig().provider);
const client = createClient(provider);
const { AgentRegistry } = await import("../src/agents/registry.ts");
const registry = new AgentRegistry();
const agent = registry.resolve(agentName);
const standing = readStanding(registry.dirFor(agent.id), agent.profile.name);
const current = agentVersionOf(standing, []);
// The agent's current system prompt as the turn assembles it — persona, standing files, built-in parts — without
// the per-turn volatile state (memory recall, tasks, heard lines) and without tools, so the replay is of the words.
const system = buildSystemPrompt({ agent, teammates: [], memory: [], standing });

const askModel = async prompt => {
  const response = await client.messages.create({ model: provider.model, max_tokens: 300, messages: [{ role: "user", content: prompt }] });
  return response.content.map(part => (part.type === "text" ? part.text : "")).join("");
};
const reviewer = new AnswerReviewer({ ask: askModel, mode: () => "shadow" });

let passed = 0;
console.log(`Replaying ${cases.length} case(s) for ${agentName} with ${provider.label} ${provider.model}\n`);
for (const { path, case: c } of cases) {
  const started = Date.now();
  let answer;
  try {
    const response = await client.messages.create({ model: provider.model, max_tokens: 800, system, messages: [{ role: "user", content: c.request }] });
    answer = response.content.map(part => (part.type === "text" ? part.text : "")).join("");
  } catch (error) {
    console.log(`infra ${path}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const verdict = await reviewer.review({ agentName, messageId: c.messageId, conversation: c.conversation ?? "main", request: c.request, answer });
  const ok = verdict.category === "PASS";
  passed += ok ? 1 : 0;
  const changed = c.version === undefined ? "version unknown" : versionDiff(c.version, current).join(", ") || "same version";
  console.log(`${ok ? "pass" : "FAIL"} ${String(Date.now() - started).padStart(5)}ms  ${c.category} → ${verdict.category}  (${changed})  ${path}`);
}
console.log(`\nrecorded: 0/${cases.length} pass (every case was a reply judged bad); now: ${passed}/${cases.length} pass`);
