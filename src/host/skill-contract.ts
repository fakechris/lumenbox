/**
 * A skill's structural contract (INV-1375).
 *
 * A skill is a directory the agent can write (skills.ts), which is the point — and the problem
 * when a person has written part of it that the agent must not rewrite: a constraint section, the
 * `allowed-tools` line, a helper script that talks to production. `skill.yaml` beside SKILL.md
 * says which parts are the agent's to change and how much:
 *
 *   learnable:                  # what may change; anything else in the skill may not
 *     - path: SKILL.md
 *       max_bytes: 20000
 *       frontmatter: [name, description]     # keys that must stay present
 *     - path: scripts/*.py
 *       max_files: 5
 *   fixed: [constraints.md]     # never written by an agent (skill.yaml itself always is)
 *   fixed_frontmatter: [allowed-tools]      # SKILL.md keys whose value never changes
 *   max_diff_lines: 200         # one write may not change more lines than this
 *
 * Every model-produced change passes five checks — fixed parts
 * unchanged, files inside learnable, size and format limits — plus the two it admits are missing:
 * a diff cap and a credential scan. A single write that fails is refused (the file stays at its
 * current version); a multi-file draft has each failing file reverted to the current version, and
 * is refused only if what remains is not a skill. A skill without skill.yaml is unaffected.
 * Writes through `bash` are not seen here; skill-provenance records them.
 */
import { createHash } from "node:crypto";
import { credentialIn } from "./secret-scan.ts";
import { skillSlugOf } from "./skill-provenance.ts";
import { SKILLS_DIR } from "./skills.ts";

export const CONTRACT_FILE = "skill.yaml";

export interface LearnableEntry {
  path: string;
  maxBytes?: number;
  maxFiles?: number;
  frontmatter?: string[];
}

export interface SkillContract {
  learnable: LearnableEntry[];
  fixed: string[];
  fixedFrontmatter: string[];
  maxDiffLines: number;
}

const DEFAULT_MAX_DIFF_LINES = 200;

/** Inline `[a, b]` or a bare scalar, without quotes. */
function scalarList(value: string): string[] {
  const inner = value.trim().replace(/^\[|\]$/g, "");
  return inner.split(",").map(item => item.trim().replace(/^["']|["']$/g, "")).filter(item => item !== "");
}

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");

/**
 * The contract in skill.yaml: JSON, or the small YAML shape in the module comment (top-level keys,
 * `- item` lists, `- path:` maps with indented keys). Anything it cannot read is an error, never a
 * contract that silently allows everything.
 */
export function parseSkillContract(text: string): SkillContract {
  const raw: Record<string, unknown> = text.trim().startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : parseYamlShape(text);
  const known = new Set(["learnable", "fixed", "fixed_frontmatter", "max_diff_lines"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`skill.yaml: unknown key "${key}"`);
  const learnable = (Array.isArray(raw.learnable) ? raw.learnable : []).map((entry, index) => {
    const item = typeof entry === "string" ? { path: entry } : (entry as Record<string, unknown>);
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (path === "" || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`skill.yaml: learnable[${index}] needs a relative path`);
    const number = (key: string) => {
      const value = item[key];
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`skill.yaml: learnable[${index}].${key} must be a positive integer`);
      return parsed;
    };
    const frontmatter = item.frontmatter === undefined ? undefined : Array.isArray(item.frontmatter) ? item.frontmatter.map(String) : scalarList(String(item.frontmatter));
    const maxBytes = number("max_bytes");
    const maxFiles = number("max_files");
    return { path, ...(maxBytes !== undefined ? { maxBytes } : {}), ...(maxFiles !== undefined ? { maxFiles } : {}), ...(frontmatter !== undefined ? { frontmatter } : {}) };
  });
  if (learnable.length === 0) throw new Error("skill.yaml: learnable lists nothing, so nothing could ever change; delete the file instead");
  const list = (value: unknown) => (value === undefined ? [] : Array.isArray(value) ? value.map(String) : scalarList(String(value)));
  const maxDiffLines = raw.max_diff_lines === undefined ? DEFAULT_MAX_DIFF_LINES : Number(raw.max_diff_lines);
  if (!Number.isSafeInteger(maxDiffLines) || maxDiffLines <= 0) throw new Error("skill.yaml: max_diff_lines must be a positive integer");
  return { learnable, fixed: list(raw.fixed), fixedFrontmatter: list(raw.fixed_frontmatter).map(key => key.toLowerCase()), maxDiffLines };
}

function parseYamlShape(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let key: string | undefined;
  let item: Record<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (line.trim() === "") continue;
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (top !== null) {
      key = top[1]!;
      item = undefined;
      out[key] = top[2]!.trim() === "" ? [] : top[2]!.trim().startsWith("[") ? scalarList(top[2]!) : unquote(top[2]!);
      continue;
    }
    const dash = /^\s+-\s+(.*)$/.exec(line);
    if (dash !== null && key !== undefined && Array.isArray(out[key])) {
      const pair = /^([a-z_]+):\s*(.*)$/.exec(dash[1]!);
      if (pair !== null) {
        item = { [pair[1]!]: unquote(pair[2]!) };
        (out[key] as unknown[]).push(item);
      } else {
        item = undefined;
        (out[key] as unknown[]).push(unquote(dash[1]!));
      }
      continue;
    }
    const nested = /^\s{3,}([a-z_]+):\s*(.*)$/.exec(line);
    if (nested !== null && item !== undefined) {
      item[nested[1]!] = nested[2]!.trim().startsWith("[") ? (scalarList(nested[2]!) as unknown as string) : unquote(nested[2]!);
      continue;
    }
    throw new Error(`skill.yaml: cannot read the line "${rawLine.trim()}"`);
  }
  return out;
}

/** `*` within a segment, `**` across segments, `?` one character. */
export function globMatches(pattern: string, path: string): boolean {
  const source = pattern
    .split("**")
    .map(part => part.split("*").map(piece => piece.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, "[^/]")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

function frontmatterOf(text: string): Map<string, string> {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = new Map<string, string>();
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0 && !/^\s/.test(line)) out.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return out;
}

/** Lines that differ, counted the cheap way: what is in one and not the other, as multisets. */
export function changedLines(before: string, after: string): number {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return Math.max(added, removed);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Why one write to `relPath` (inside the skill) breaks the contract, or undefined when it may go.
 * `before` is the file's current content (undefined when new); `siblings` are the skill's other
 * files' relative paths, for `max_files`.
 */
export function contractRefusal(contract: SkillContract, relPath: string, before: string | undefined, after: string, siblings: readonly string[] = []): string | undefined {
  if (relPath === CONTRACT_FILE) return "skill.yaml is the skill's contract and a person's to change; it is never written by an agent.";
  if (contract.fixed.some(pattern => globMatches(pattern, relPath))) {
    return before !== undefined && sha256(before) === sha256(after) ? undefined : `${relPath} is fixed in this skill's skill.yaml; a person wrote it and only a person changes it.`;
  }
  const entry = contract.learnable.find(candidate => globMatches(candidate.path, relPath));
  if (entry === undefined) return `${relPath} is not among the files this skill's skill.yaml lets an agent change (${contract.learnable.map(e => e.path).join(", ")}).`;
  const bytes = Buffer.byteLength(after);
  if (entry.maxBytes !== undefined && bytes > entry.maxBytes) return `${relPath} would be ${bytes} bytes; this skill's contract allows ${entry.maxBytes}.`;
  if (entry.maxFiles !== undefined && before === undefined) {
    const count = siblings.filter(path => path !== relPath && globMatches(entry.path, path)).length + 1;
    if (count > entry.maxFiles) return `That would make ${count} files matching ${entry.path}; this skill's contract allows ${entry.maxFiles}.`;
  }
  const meta = frontmatterOf(after);
  for (const key of entry.frontmatter ?? []) {
    if (!meta.has(key.toLowerCase())) return `${relPath} must keep its \`${key}:\` frontmatter line.`;
  }
  if (relPath === "SKILL.md" && contract.fixedFrontmatter.length > 0) {
    const was = frontmatterOf(before ?? "");
    for (const key of contract.fixedFrontmatter) {
      if (was.get(key) !== meta.get(key)) return `SKILL.md's \`${key}:\` is fixed in this skill's skill.yaml; leave it as it was.`;
    }
  }
  if (before !== undefined && changedLines(before, after) > contract.maxDiffLines) {
    return `That changes ${changedLines(before, after)} lines of ${relPath}; this skill's contract allows ${contract.maxDiffLines} in one write. Make it in smaller steps a person can follow.`;
  }
  const credential = credentialIn(after);
  if (credential !== undefined) return `${relPath} would hold something shaped like a credential (${credential}); a skill never carries one.`;
  return undefined;
}

/**
 * A multi-file draft against the skill as it stands: each file that breaks the contract goes back
 * to its current version (or is dropped when new), with the reason; refused when what remains has
 * no SKILL.md. Without a contract only the credential scan applies.
 */
export function checkSkillDraft(
  contract: SkillContract | undefined,
  current: ReadonlyMap<string, string>,
  draft: ReadonlyMap<string, string>
): { files: Map<string, string>; reverted: { path: string; reason: string }[]; refused?: string } {
  const files = new Map<string, string>();
  const reverted: { path: string; reason: string }[] = [];
  const paths = [...draft.keys()];
  for (const [path, content] of draft) {
    const before = current.get(path);
    const reason =
      contract === undefined
        ? (credentialIn(content) !== undefined ? `${path} holds something shaped like a credential (${credentialIn(content)})` : undefined)
        : contractRefusal(contract, path, before, content, paths.filter(other => other !== path && !current.has(other)).concat([...current.keys()]));
    if (reason === undefined) {
      files.set(path, content);
      continue;
    }
    reverted.push({ path, reason });
    if (before !== undefined) files.set(path, before);
  }
  if (!files.has("SKILL.md") && !current.has("SKILL.md")) return { files, reverted, refused: "After reverting what the contract forbids, the draft has no SKILL.md left." };
  return { files, reverted };
}

/**
 * For write_file and edit_file: why this write to a skill file is refused, or undefined. Reads the
 * skill's skill.yaml from the box; no contract, no refusal. A skill.yaml that does not parse
 * refuses every write to its skill — a broken contract must not read as "anything goes".
 */
export async function skillWriteRefusal(
  box: { readFile(path: string): Promise<{ content: string; truncated?: boolean }>; listDir(path: string): Promise<{ entries: { name: string; type: string }[] }> },
  absolutePath: string,
  after: string
): Promise<string | undefined> {
  const slug = skillSlugOf(absolutePath);
  if (slug === undefined) return undefined;
  const dir = `${SKILLS_DIR}/${slug}`;
  const read = async (path: string) => {
    try {
      const file = await box.readFile(path);
      return file.truncated ? undefined : file.content;
    } catch {
      return undefined;
    }
  };
  const relPath = absolutePath.replace(/^~\/work\//, "/home/box/work/").slice(dir.length + 1);
  const text = await read(`${dir}/${CONTRACT_FILE}`);
  if (text === undefined) return undefined;
  let contract: SkillContract;
  try {
    contract = parseSkillContract(text);
  } catch (error) {
    return `This skill's skill.yaml cannot be read (${error instanceof Error ? error.message : String(error)}), so nothing in the skill is written until a person fixes it.`;
  }
  const sub = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const siblings = await box
    .listDir(sub === "" ? dir : `${dir}/${sub}`)
    .then(result => result.entries.filter(entry => entry.type === "file").map(entry => (sub === "" ? entry.name : `${sub}/${entry.name}`)))
    .catch(() => [] as string[]);
  return contractRefusal(contract, relPath, await read(absolutePath.replace(/^~\/work\//, "/home/box/work/")), after, siblings);
}
