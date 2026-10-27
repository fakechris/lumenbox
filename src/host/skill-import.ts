/**
 * Importing SKILL.md folders from elsewhere (INV-1367): OpenClaw and Hermes `skills/` folders,
 * Rakazo's `.agents/skills`, Microsoft Skill Recorder's generic export — all one shape, a
 * directory with a SKILL.md (name / description / allowed-tools frontmatter) and files beside it.
 *
 * An import is never installed directly. Each skill becomes a teaching draft (teach-drafts.ts), the
 * same gate a demonstration goes through: a person reads it and publishes it, or does not. What
 * this module adds is the translation: frontmatter reduced to ours (name, description,
 * scope: global, allowed-tools mapped onto our tool names, unknown names reported), helper files
 * carried beside it, and the refusals — a skill naming the host's own records, a credential in any
 * file — decided before a draft exists. The body is never rewritten.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { namesControlSurface } from "./control-surfaces.ts";
import { checkSkillDraft } from "./skill-contract.ts";
import { allowedToolsFrom, KNOWN_TOOL_NAMES, parseSkillFile } from "./skills.ts";
import type { TeachProposal } from "./teach-drafts.ts";

export const IMPORT_MAX_FILES = 50;
export const IMPORT_MAX_FILE_BYTES = 512 * 1024;
export const IMPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** A skill folder read from disk: its path and its text files, relative path → content. */
export interface SkillFolder {
  dir: string;
  files: Map<string, string>;
  /** What was left out and why (a symlink, a binary, over a limit). */
  skipped: string[];
}

function readFolder(dir: string): SkillFolder {
  const files = new Map<string, string>();
  const skipped: string[] = [];
  let total = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path);
      if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        skipped.push(`${rel}: a symlink`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (files.size >= IMPORT_MAX_FILES) {
        skipped.push(`${rel}: over ${IMPORT_MAX_FILES} files`);
        continue;
      }
      if (stat.size > IMPORT_MAX_FILE_BYTES || total + stat.size > IMPORT_MAX_TOTAL_BYTES) {
        skipped.push(`${rel}: too large`);
        continue;
      }
      const buffer = readFileSync(path);
      if (buffer.includes(0)) {
        skipped.push(`${rel}: binary`);
        continue;
      }
      total += stat.size;
      files.set(rel.split("\\").join("/"), buffer.toString("utf8"));
    }
  };
  walk(dir);
  return { dir, files, skipped };
}

/** The skill folders under a path: the path itself when it holds a SKILL.md, else each child that does. */
export function findSkillFolders(root: string): SkillFolder[] {
  const has = (dir: string) => {
    try {
      return lstatSync(join(dir, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  };
  if (has(root)) return [readFolder(root)];
  return readdirSync(root)
    .sort()
    .map(name => join(root, name))
    .filter(dir => lstatSync(dir).isDirectory() && has(dir))
    .map(readFolder);
}

/**
 * `allowed-tools` as other hosts write it: inline (`Bash, Read`), bracketed, or a YAML list on the
 * lines below (Skill Recorder), with Claude Code permission patterns like `Bash(gh *)` reduced to
 * the tool they scope — the scope itself has no equivalent here and the policy gate decides instead.
 */
export function allowedToolsRaw(text: string): string | undefined {
  const head = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (head === undefined) return undefined;
  const lines = head.split(/\r?\n/);
  const at = lines.findIndex(line => /^allowed-tools\s*:/i.test(line));
  if (at < 0) return undefined;
  const items = [lines[at]!.replace(/^allowed-tools\s*:/i, "").trim()];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item === null) break;
    items.push(item[1]!.trim());
  }
  const names = items
    .join(",")
    .replace(/^\s*\[|\]\s*$/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .split(",")
    .map(name => name.trim().replace(/^["']|["']$/g, ""))
    .filter(name => name !== "");
  return names.length === 0 ? undefined : [...new Set(names)].join(", ");
}

/** Our frontmatter for an imported SKILL.md: name, description, scope, mapped allowed-tools; body kept. */
export function translateSkill(text: string, ours: ReadonlySet<string> = KNOWN_TOOL_NAMES): { skill: string; tools: string[]; unknown: string[]; name: string } {
  const parsed = parseSkillFile(text);
  const name = (parsed.meta.name ?? "").trim();
  const description = (parsed.meta.description ?? "").replace(/\s+/g, " ").trim();
  if (name === "" || description === "") throw new Error("its SKILL.md has no name or no description in the frontmatter");
  const raw = allowedToolsRaw(text);
  const mapped = raw === undefined ? { tools: [], unknown: [] } : allowedToolsFrom(raw, ours);
  const quote = (value: string) => (/: |\s#|^["']/.test(value) ? JSON.stringify(value) : value);
  const head = [`name: ${quote(name)}`, `description: ${quote(description)}`, "scope: global", ...(mapped.tools.length > 0 ? [`allowed-tools: ${mapped.tools.join(", ")}`] : [])];
  return { skill: `---\n${head.join("\n")}\n---\n\n${parsed.body}\n`, tools: mapped.tools, unknown: mapped.unknown, name };
}

/** What one folder becomes: a draft proposal, or the reason it does not. */
export function importProposal(
  folder: SkillFolder,
  target: { boxId: string; agentId: string; from: string },
  ours: ReadonlySet<string> = KNOWN_TOOL_NAMES
): { proposal: TeachProposal; report: string[] } | { refused: string } {
  const original = folder.files.get("SKILL.md");
  if (original === undefined) return { refused: "no SKILL.md" };
  let translated: ReturnType<typeof translateSkill>;
  try {
    translated = translateSkill(original, ours);
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  for (const [path, content] of folder.files) {
    const named = namesControlSurface(content);
    if (named !== undefined) return { refused: `${path} names the host's own records or secrets (${named})` };
  }
  const helpers = new Map([...folder.files].filter(([path]) => path !== "SKILL.md"));
  const checked = checkSkillDraft(undefined, new Map(), new Map([["SKILL.md", translated.skill], ...helpers]));
  if (checked.refused !== undefined || !checked.files.has("SKILL.md")) {
    return { refused: checked.reverted.find(r => r.path === "SKILL.md")?.reason ?? checked.refused ?? "SKILL.md was refused" };
  }
  const files = Object.fromEntries([...checked.files].filter(([path]) => path !== "SKILL.md"));
  const digest = createHash("sha256").update(JSON.stringify([target.from, translated.skill, files])).digest("hex").slice(0, 32);
  const proposal: TeachProposal = {
    boxId: target.boxId,
    agentId: target.agentId,
    sessionId: `import-${digest}`,
    eventsPath: `import:${target.from}`,
    skill: translated.skill,
    question: null,
    source: { kind: "import", from: target.from },
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(translated.unknown.length > 0 ? { unknownTools: translated.unknown } : {}),
  };
  const report = [
    `${translated.name}: ${Object.keys(files).length} helper file(s)${translated.tools.length > 0 ? `; tools ${translated.tools.join(", ")}` : ""}`,
    ...(translated.unknown.length > 0 ? [`  tools with no equivalent here, dropped: ${translated.unknown.join(", ")}`] : []),
    ...checked.reverted.map(r => `  left out ${r.reason}`),
    ...folder.skipped.map(reason => `  skipped ${reason}`),
  ];
  return { proposal, report };
}

/**
 * `agentbox skills import <dir> [--agent <name>]`: each skill under <dir> becomes a draft in the
 * teaching review (web: Settings → Skills → drafts), for the installation's own box, credited to
 * the named agent or the box's first. Nothing is published here.
 */
export async function cmdSkillsImport(argv: string[], out: (line: string) => void = line => console.log(line)): Promise<number> {
  const dir = argv.find(arg => !arg.startsWith("--") && argv[argv.indexOf(arg) - 1] !== "--agent");
  if (dir === undefined) {
    out("Usage: agentbox skills import <dir> [--agent <name>]   (a folder with SKILL.md, or a folder of them)");
    return 1;
  }
  const { resolve } = await import("node:path");
  const { agentboxHome } = await import("../config.ts");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { TeachDrafts } = await import("./teach-drafts.ts");
  const registry = new AgentRegistry();
  const boxId = registry.box.id;
  const wanted = argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : undefined;
  const agents = registry.agentsIn(boxId);
  const agent = wanted === undefined ? agents[0] : agents.find(record => record.profile.name.toLowerCase() === wanted.toLowerCase());
  if (agent === undefined) {
    out(wanted === undefined ? "This installation has no agent to credit the drafts to." : `No agent called ${wanted}. Have: ${agents.map(a => a.profile.name).join(", ")}`);
    return 1;
  }
  const root = resolve(dir);
  const folders = findSkillFolders(root);
  if (folders.length === 0) {
    out(`No SKILL.md in ${root} or in any folder directly under it.`);
    return 1;
  }
  const drafts = new TeachDrafts(join(agentboxHome(), "skills-drafts"));
  let made = 0;
  for (const folder of folders) {
    const result = importProposal(folder, { boxId, agentId: agent.id, from: folder.dir });
    if ("refused" in result) {
      out(`refused ${relative(root, folder.dir) || "."}: ${result.refused}`);
      continue;
    }
    drafts.create(result.proposal);
    made += 1;
    for (const line of result.report) out(line);
  }
  out(`${made} draft(s) for ${agent.profile.name}; review and publish them in the web UI. Nothing was installed.`);
  return made > 0 ? 0 : 1;
}
