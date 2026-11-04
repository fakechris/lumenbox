/**
 * A paused agent (INV-1554): a person's "stop, and stay stopped until I say".
 *
 * The page's Stop ends the turn in flight and clears at the next turn, which is right for "not this
 * one". It could not hold four agents that woke each other with messages and job endings for hours
 * (2026-11-03). A pause is a file beside the agent's other state, so it outlives a restart; while it
 * is there the bus starts no turn for the agent and its messages wait in the queue.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PAUSED_FILE = "paused.json";

export interface Pause {
  by: string;
  at: string;
  reason: string;
}

export function readPause(agentDir: string): Pause | undefined {
  const file = join(agentDir, PAUSED_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Pause>;
    return { by: String(parsed.by ?? "someone"), at: String(parsed.at ?? ""), reason: String(parsed.reason ?? "") };
  } catch {
    // Unreadable still pauses: a person wrote it to stop the agent, and a half-written file is not consent to go on.
    return { by: "someone (the pause record could not be read)", at: "", reason: "" };
  }
}

export function writePause(agentDir: string, pause: Pause): void {
  writeFileSync(join(agentDir, PAUSED_FILE), `${JSON.stringify(pause)}\n`, { mode: 0o600 });
}

export function clearPause(agentDir: string): void {
  rmSync(join(agentDir, PAUSED_FILE), { force: true });
}
