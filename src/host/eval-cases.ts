/**
 * A reply the answer review judged bad, kept as a case a person can turn into a test (INV-1474).
 *
 * `~/.agentbox/evals/<agent>/<date>-<messageId>.md`: the request, the answer, the review's label
 * and reason, and the hashes of the agent's version at the time (agent-version.ts). The person
 * edits the *Expected* section into what should have been said; `scripts/replay-evals.mjs` runs
 * the request again under the current prompt and reports the pass rate against the recorded one.
 * One file per message: a second review of the same reply does not write a second case. Text is
 * redacted by the caller before it arrives here, so a case never holds a credential.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentVersion } from "./agent-version.ts";

export interface EvalCase {
  agent: string;
  messageId: string;
  conversation?: string;
  at: string;
  category: string;
  confidence: number;
  reason: string;
  request: string;
  answer: string;
  /** What the person says should have been answered; empty until they write it. */
  expected?: string;
  version?: AgentVersion;
}

const slugOf = (text: string): string => text.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

export function evalCasePath(dir: string, c: Pick<EvalCase, "agent" | "messageId" | "at">): string {
  return join(dir, slugOf(c.agent), `${c.at.slice(0, 10)}-${slugOf(c.messageId)}.md`);
}

/** Writes the case unless one for this message exists; returns the path, or undefined when nothing was written. */
export function writeEvalCase(dir: string, c: EvalCase): string | undefined {
  const path = evalCasePath(dir, c);
  if (existsSync(path)) return undefined;
  mkdirSync(join(dir, slugOf(c.agent)), { recursive: true, mode: 0o700 });
  const front = {
    agent: c.agent, messageId: c.messageId, ...(c.conversation !== undefined ? { conversation: c.conversation } : {}),
    at: c.at, category: c.category, confidence: c.confidence, reason: c.reason, ...(c.version !== undefined ? { version: c.version } : {}),
  };
  const expected = (c.expected ?? "").trim();
  writeFileSync(path, `---\n${JSON.stringify(front, null, 2)}\n---\n\n## Request\n\n${c.request.trim()}\n\n## Answer\n\n${c.answer.trim()}\n\n## Expected\n\n${expected === "" ? "" : `${expected}\n`}`, { mode: 0o600 });
  return path;
}

export function parseEvalCase(text: string): EvalCase | undefined {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return undefined;
  let front: Record<string, unknown>;
  try { front = JSON.parse(match[1]!) as Record<string, unknown>; } catch { return undefined; }
  const section = (name: string): string => {
    const found = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(match[2]!);
    return (found?.[1] ?? "").trim();
  };
  if (typeof front.agent !== "string" || typeof front.messageId !== "string" || typeof front.at !== "string") return undefined;
  return {
    agent: front.agent, messageId: front.messageId, at: front.at,
    ...(typeof front.conversation === "string" ? { conversation: front.conversation } : {}),
    category: typeof front.category === "string" ? front.category : "UNKNOWN",
    confidence: typeof front.confidence === "number" ? front.confidence : 0,
    reason: typeof front.reason === "string" ? front.reason : "",
    request: section("Request"), answer: section("Answer"),
    ...(section("Expected") !== "" ? { expected: section("Expected") } : {}),
    ...(typeof front.version === "object" && front.version !== null ? { version: front.version as AgentVersion } : {}),
  };
}

/** Every case kept for an agent, oldest first; a file that does not parse is skipped. */
export function readEvalCases(dir: string, agent: string): { path: string; case: EvalCase }[] {
  const folder = join(dir, slugOf(agent));
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => name.endsWith(".md")).sort().flatMap(name => {
    const path = join(folder, name);
    const parsed = parseEvalCase(readFileSync(path, "utf8"));
    return parsed === undefined ? [] : [{ path, case: parsed }];
  });
}
