/**
 * A box a person stopped stays stopped (INV-1550).
 *
 * The host starts a local box that was stopped from outside — a `docker stop` sweep, an engine
 * restart — because nobody meant it and turns were retrying against it. `agentbox box down` is
 * somebody meaning it, so it leaves a marker the keeper respects; `box up` (CLI or Settings)
 * removes it. One file per container name, beside the rest of this installation's state.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";

const fileFor = (containerName: string) => join(agentboxHome(), `held-down-${containerName.replace(/[^A-Za-z0-9_.-]/g, "_")}`);

export function holdBoxDown(containerName: string, by: string, now: Date = new Date()): void {
  writeFileSync(fileFor(containerName), `${JSON.stringify({ by, at: now.toISOString() })}\n`, { mode: 0o600 });
}

export function releaseBoxDown(containerName: string): void {
  rmSync(fileFor(containerName), { force: true });
}

/** Who held it down and when; a marker that cannot be read still holds, since holding is the safe reading. */
export function boxHeldDown(containerName: string): { by: string; at: string } | undefined {
  const file = fileFor(containerName);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { by?: unknown; at?: unknown };
    return { by: typeof parsed.by === "string" ? parsed.by : "someone", at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return { by: "someone (the marker could not be read)", at: "" };
  }
}
