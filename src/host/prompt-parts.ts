/**
 * The built-in prompt parts a team may override, and what happens when the default moves
 * (INV-1465).
 *
 * The persona and the standing files were always the team's; the built-in rules — how a turn
 * works, how the front agent keeps its turns short, how an unattended turn behaves — were
 * constants, so a team that wanted one rule worded its way had no way but a fork. Now each is
 * a named part with a default here and an optional override on disk,
 * `~/.agentbox/prompt-overrides/<key>.md`, whose frontmatter records the hash of the default it
 * was written against. When a release changes that default, the override is marked
 * *default updated* and the page shows both texts; the team keeps its words, takes the new
 * default, or edits — nothing is merged silently. An override identical to the default is
 * dropped on save so the part follows future defaults again.
 *
 * Only prompt text. Nothing here reaches the policy, the tools or any gate in code.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptOverridesDir } from "../config.ts";

export type PartKey = "conduct" | "front" | "unattended";

export interface PartDefault {
  key: PartKey;
  title: string;
  /** What the part is for, in a line a person reads before editing it. */
  about: string;
  text: string;
}

export interface PartOverride {
  text: string;
  /** The hash of the default the override was written against. */
  base: string;
}

export type PartStatus = "default" | "overridden" | "default-updated";

export interface PartView extends PartDefault {
  status: PartStatus;
  defaultHash: string;
  override?: PartOverride;
}

/** The overrides directory, or undefined where there is no home to look in (a test with no AGENTBOX_HOME): then there are no overrides. */
export function overridesDir(): string | undefined {
  try {
    return promptOverridesDir();
  } catch {
    return undefined;
  }
}

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const registry = new Map<PartKey, PartDefault>();

/** Registers a default; the prompt module does this once for each part at load. */
export function definePart(part: PartDefault): void {
  registry.set(part.key, part);
}

export function parts(): PartDefault[] {
  return [...registry.values()];
}

/** Reads one override file, or undefined when there is none or it is unreadable. */
export function readOverride(key: PartKey, dir = overridesDir()): PartOverride | undefined {
  if (dir === undefined) return undefined;
  const path = join(dir, `${key}.md`);
  if (!existsSync(path)) return undefined;
  try {
    return parseOverride(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** `---\nbase: <hash>\n---\n<text>`; a file with no frontmatter is read against no base, which reads as default-updated. */
export function parseOverride(raw: string): PartOverride {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (match === null) return { text: raw.trim(), base: "" };
  const base = /^base:\s*(\S+)/m.exec(match[1] ?? "")?.[1] ?? "";
  return { text: (match[2] ?? "").trim(), base };
}

/** The words the prompt uses for a part: the override when one is on file, else the default. */
export function partText(key: PartKey, dir = overridesDir()): string {
  const part = registry.get(key);
  if (part === undefined) return "";
  return readOverride(key, dir)?.text ?? part.text;
}

export function partView(part: PartDefault, dir = overridesDir()): PartView {
  const defaultHash = hashOf(part.text);
  const override = readOverride(part.key, dir);
  const status: PartStatus = override === undefined ? "default" : override.base === defaultHash ? "overridden" : "default-updated";
  return { ...part, status, defaultHash, ...(override !== undefined ? { override } : {}) };
}

export function partViews(dir = overridesDir()): PartView[] {
  return parts().map(part => partView(part, dir));
}

/**
 * A person's decision about a part: new words (an override against today's default; words equal
 * to the default drop the override), `keep` (the team's words re-based on today's default, which
 * clears *default updated*), or `default` (the override removed, the part follows defaults again).
 */
export function decidePart(key: PartKey, decision: { kind: "edit"; text: string } | { kind: "keep" } | { kind: "default" }, dir = overridesDir()): PartView {
  const part = registry.get(key);
  if (part === undefined) throw new Error(`no prompt part named ${key}`);
  if (dir === undefined) throw new Error("no home directory to keep prompt overrides in");
  const path = join(dir, `${key}.md`);
  const write = (text: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `---\nbase: ${hashOf(part.text)}\n---\n${text.trim()}\n`, { mode: 0o600 });
  };
  if (decision.kind === "default") {
    rmSync(path, { force: true });
  } else if (decision.kind === "keep") {
    const current = readOverride(key, dir);
    if (current !== undefined) write(current.text);
  } else if (decision.text.trim() === part.text.trim()) {
    rmSync(path, { force: true });
  } else {
    write(decision.text);
  }
  return partView(part, dir);
}

/** The override files on disk that name no part, so a typo in a filename is seen rather than ignored. */
export function strayOverrides(dir = overridesDir()): string[] {
  if (dir === undefined || !existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(".md") && !registry.has(name.slice(0, -3) as PartKey));
}
