/**
 * `agentbox supervise` (INV-1518, docs/90 §3.5): one objective, one goal, watched to its end by an
 * OpenAI model through the side door. The door token comes from --token-file or --token; the model
 * key from the environment the CLI read. Each run writes ~/.agentbox/supervisor/<run>/ with the
 * transcript and a summary; neither ever holds a key or a token.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendLine } from "../host/jsonl.ts";
import { doorClient } from "../watchdog/client.ts";
import { DEFAULT_SUPERVISOR_LIMITS, Supervisor, summaryOf } from "./loop.ts";
import { openaiResponses } from "./openai.ts";

export const DEFAULT_SUPERVISOR_MODEL = "gpt-6.1-sol";

export async function cmdSupervise(argv: string[], env: { openaiToken?: string; doorToken?: string }, out: (line: string) => void = line => console.error(line)): Promise<number> {
  const value = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const objective = value("--objective");
  const tokenFile = value("--token-file");
  const doorToken = value("--token") ?? (tokenFile !== undefined ? readFileSync(tokenFile, "utf8").trim() : env.doorToken);
  if (objective === undefined || objective.trim() === "" || doorToken === undefined || doorToken === "") {
    out("Usage: agentbox supervise --objective \"<what done looks like>\" --token-file <side-door token file> [--url http://127.0.0.1:7777] [--agent <name>] [--budget N] [--model gpt-6.1-sol] [--max-minutes 120] [--max-model-calls 60]\nThe model key is OPENAI_TOKEN (or OPENAI_API_KEY); the door token may also be AGENTBOX_SUPERVISOR_TOKEN.");
    return 1;
  }
  if (env.openaiToken === undefined || env.openaiToken === "") {
    out("supervise: no OpenAI key in OPENAI_TOKEN or OPENAI_API_KEY.");
    return 1;
  }
  const number = (name: string) => { const raw = value(name); const parsed = raw === undefined ? NaN : Number(raw); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; };
  const model = value("--model") ?? DEFAULT_SUPERVISOR_MODEL;
  const { agentboxHome } = await import("../config.ts");
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = join(agentboxHome(), "supervisor", runId);
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "transcript.jsonl");
  const supervisor = new Supervisor({
    door: doorClient(value("--url") ?? "http://127.0.0.1:7777", doorToken),
    ask: openaiResponses({ token: env.openaiToken, model }),
    record: entry => appendLine(transcript, JSON.stringify(entry)),
    log: out,
    runId,
    limits: {
      maxMinutes: number("--max-minutes") ?? DEFAULT_SUPERVISOR_LIMITS.maxMinutes,
      maxModelCalls: number("--max-model-calls") ?? DEFAULT_SUPERVISOR_LIMITS.maxModelCalls,
    },
  });
  out(`supervise: ${model} watching one goal; run ${runId}`);
  const agent = value("--agent");
  const budget = number("--budget");
  const result = await supervisor.run(objective, { ...(agent !== undefined ? { agent } : {}), ...(budget !== undefined ? { budget } : {}) });
  const summary = `${summaryOf(objective, result)}Model: ${model}\nTranscript: ${transcript}\n`;
  writeFileSync(join(dir, "summary.md"), summary);
  out(summary);
  return result.outcome === "completed" ? 0 : 2;
}
