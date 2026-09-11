/**
 * Site learnings: what an agent found out about a site, kept per host, read back the
 * next time anyone opens it (INV-409, docs/49 E1).
 *
 * huashu-chrome ships twenty-three of these as hand-written notes; ego-lite calls them
 * site skills. The shape that matters is the same in both: dated, honest about what did
 * *not* work, and suspicious of anything that goes stale. A coordinate in a note is
 * marked perishable the day it is written, because a redesign turns it into a wrong
 * click with nothing to report.
 *
 * One Markdown file per host under ~/.agentbox/learnings, appended to, never rewritten
 * by a tool. Secrets are refused at the door with the same scanner templates use: a note
 * is the kind of thing that travels (docs/29), and a credential must never travel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { appendLine } from "./jsonl.ts";
import { scanText } from "./secret-scan.ts";

export function learningsDir(): string {
  return process.env.AGENTBOX_LEARNINGS ?? join(agentboxHome(), "learnings");
}

/** The host a note is filed under: lower-case, no port, `www.` dropped. */
export function hostOf(urlOrHost: string): string | undefined {
  const raw = urlOrHost.trim();
  if (raw === "") return undefined;
  let host = raw;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9.-]+$/.test(host) ? host : undefined;
}

export const MAX_LEARNING_CHARS = 400;
/** How many recent notes a fresh open shows. */
export const LEARNINGS_SHOWN = 12;

const COORDINATE = /\(\s*\d{2,4}\s*,\s*\d{2,4}\s*\)|\b\d{2,4}\s*[x×]\s*\d{2,4}\b/;

/** Why a note is refused, or undefined when it may be kept. */
export function validateLearning(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return "Say what you learned, in one or two sentences.";
  if (trimmed.includes("\n")) return "One note per line: a learning is one sentence or two, not a paragraph.";
  if (trimmed.length > MAX_LEARNING_CHARS) {
    return `A note may be ${MAX_LEARNING_CHARS} characters and this is ${trimmed.length}. It is shown on every open of this site; keep it to what the next visit needs.`;
  }
  const hit = scanText(trimmed).patterns[0];
  if (hit !== undefined) {
    return `That looks like it holds a credential (${hit.pattern}: ${hit.excerpt}). A learning never carries one — say where the credential lives instead.`;
  }
  return undefined;
}

/** The line as it is written: date, verdict, text, and a perishable marker for coordinates. */
export function formatLearning(entry: { at: Date; worked: boolean; text: string; by?: string }): string {
  const day = entry.at.toISOString().slice(0, 10);
  const mark = entry.worked ? "✅" : "❌";
  const perishable = COORDINATE.test(entry.text) ? ` # 核对 ${day}: coordinates go stale; re-check before trusting` : "";
  const who = entry.by !== undefined && entry.by !== "" ? ` (${entry.by})` : "";
  return `- ${day} ${mark} ${entry.text.trim()}${who}${perishable}`;
}

function fileFor(host: string, dir: string): string {
  return join(dir, `${host}.md`);
}

/** Appends one note under its host, creating the file with a header the first time. */
export function appendLearning(
  host: string,
  entry: { at: Date; worked: boolean; text: string; by?: string },
  dir = learningsDir()
): string {
  const refusal = validateLearning(entry.text);
  if (refusal !== undefined) throw new Error(refusal);
  mkdirSync(dir, { recursive: true });
  const path = fileFor(host, dir);
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# ${host}\n\nWhat agents here learned on this site. ✅ worked, ❌ did not; newest last. Coordinates are perishable and dated.\n\n`,
      "utf8"
    );
  }
  const line = formatLearning(entry);
  appendLine(path, line);
  return line;
}

/** The most recent notes for a host, oldest first among those shown. */
export function readLearnings(host: string, dir = learningsDir(), limit = LEARNINGS_SHOWN): string[] {
  const path = fileFor(host, dir);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(line => line.startsWith("- "));
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

/** The note shown when a site with learnings is opened, or undefined when there are none. */
export function renderLearnings(host: string, lines: readonly string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const failures = lines.filter(line => line.includes(" ❌ ")).length;
  return (
    `What you or a teammate learned on ${host} before (${lines.length} note(s)${failures > 0 ? `, ${failures} about what did not work` : ""}):\n` +
    lines.join("\n") +
    "\nAdd to this with NoteSiteLearning when you find out something the next visit needs."
  );
}
