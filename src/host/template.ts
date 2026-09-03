/**
 * Bot templates: the recipe a bot packs of itself, and the recipe a new bot installs from.
 *
 * The shape is docs/29. Two agents do the judgment — the exporting bot chooses and rewrites,
 * the importing bot writes its own skills and memories on its first turn — and this module is
 * the rails between them: the format, what may never travel (§1), the secret prefilter, the
 * mechanical generalisation of a routine's installation-specific ids into `{placeholders}`,
 * the readable recipe the new bot is handed, the cue that starts its first turn, and the
 * reconciliation that says honestly what landed.
 *
 * Everything here is pure or takes an injected source, because the mistake this feature can
 * make — a secret or a person's name in a public file — has to be testable without a box.
 */

import { type CatalogExpert, CODE_TOOLS, DESK_TOOLS, WEB_TOOLS } from "./catalog.ts";
import type { MemoryRecord } from "./memory.ts";
import { scanText } from "./secret-scan.ts";
import { SKILL_FILENAME, SKILLS_DIR, parseSkillFile, slugify } from "./skills.ts";

export const TEMPLATE_FORMAT = "lumenbox-template/1";
/** The whole document. Two mebibytes is a bot, not a dataset. */
export const TEMPLATE_MAX_BYTES = 2 * 1024 * 1024;
/** One helper file. Past this it is data that belongs in the work directory, not a recipe. */
export const TEMPLATE_FILE_MAX_BYTES = 256 * 1024;
/** Where an imported recipe is put for the new bot to read. */
export const TEMPLATES_DIR = "/home/box/work/templates";
/** Prefix on the cue that opens a template setup turn; `reviewInputFor` files it as untrusted. */
export const TEMPLATE_CUE = "[template setup]";
/** `source` on a memory record and `authored_by` on a skill the setup turn wrote. */
export const TEMPLATE_SOURCE_PREFIX = "template:";

/** Sharing is on unless the operator turned it off. One switch for the skill, the tool and the routes. */
export function templatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTBOX_TEMPLATES !== "0";
}

/**
 * What a setup turn may hold: files and memory, and a way to ask. Nothing that reaches
 * out — no shell, no browser, no teammates, no host — because installing yourself is not a
 * reason to message anyone, and the recipe being installed is third-party text.
 */
export const TEMPLATE_SETUP_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "RememberFact",
  "Recall",
  "SetPlan",
  "SetTodos",
  "ReadHistory",
  "AskUser",
  "OtherThreads",
];

export type ToolTier = "desk" | "web" | "code";
export const TOOL_TIERS: Readonly<Record<ToolTier, readonly string[]>> = {
  desk: DESK_TOOLS,
  web: WEB_TOOLS,
  code: CODE_TOOLS,
};

export interface TemplateProfile {
  name: string;
  title?: string;
  /** The storefront line: what it does and who it is for, in a sentence or three. */
  description: string;
  avatarColor?: string;
  /** A tier name, or an explicit list when the bot's set is not a tier. Absent means the importer's default. */
  tools?: ToolTier | readonly string[];
}

export interface TemplateMemory {
  kind: "fact" | "pitfall";
  text: string;
  /** ISO date or timestamp of the original record, so decay treats it honestly. */
  at?: string;
}

export interface TemplateFillIn {
  id: string;
  label: string;
}

export interface TemplateSkill {
  slug: string;
  name: string;
  description: string;
  /** Relative path → text. `SKILL.md` is required; helpers ride beside it. */
  files: Record<string, string>;
}

export interface TemplateRoutine extends TemplateSkill {
  /** What the importing person has to supply before this can run. */
  fillIns: TemplateFillIn[];
}

export interface BotTemplate {
  format: typeof TEMPLATE_FORMAT;
  profile: TemplateProfile;
  memory: TemplateMemory[];
  skills: TemplateSkill[];
  routines: TemplateRoutine[];
  /** Catalog connector slugs the work needs: `feishu`, `dingtalk`, `browser`, `mcp:<server>`. */
  connectors: string[];
  /** A skill the new bot reads before it speaks. Must name one of `skills`. */
  gettingStarted?: { skill: string };
  meta?: { createdAt?: string; createdBy?: string; sourceName?: string };
}

// ── validation ───────────────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FILE_PATH = /^(?!\.)(?!.*\/\.)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const NAME_MAX = 72;
const DESCRIPTION_MAX = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Reads a template from JSON text or a parsed object, and says exactly what is wrong when
 * something is. Lenient about unknown keys (a newer minor may add them), strict about the
 * boundary: a field that must never travel has no place here to land in.
 */
export function parseTemplate(raw: unknown): { template: BotTemplate } | { problem: string } {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > TEMPLATE_MAX_BYTES) {
      return { problem: `The template is larger than ${TEMPLATE_MAX_BYTES} bytes.` };
    }
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { problem: `Not JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!isRecord(value)) return { problem: "A template is a JSON object." };
  if (value.format !== TEMPLATE_FORMAT) {
    return { problem: `Unknown template format "${stringOr(value.format, "(none)")}"; this reads ${TEMPLATE_FORMAT}.` };
  }

  const profileRaw = value.profile;
  if (!isRecord(profileRaw)) return { problem: "profile is missing." };
  const name = stringOr(profileRaw.name).trim();
  if (name === "" || name.length > NAME_MAX) return { problem: `profile.name must be 1–${NAME_MAX} characters.` };
  const description = stringOr(profileRaw.description).trim();
  if (description === "") return { problem: "profile.description is empty; it is the line people choose by." };
  if (description.length > DESCRIPTION_MAX) return { problem: `profile.description is over ${DESCRIPTION_MAX} characters; detail belongs in skills and memories.` };
  let tools: TemplateProfile["tools"];
  if (typeof profileRaw.tools === "string") {
    if (!(profileRaw.tools in TOOL_TIERS)) return { problem: `profile.tools tier "${profileRaw.tools}" is not one of ${Object.keys(TOOL_TIERS).join(", ")}.` };
    tools = profileRaw.tools as ToolTier;
  } else if (Array.isArray(profileRaw.tools)) {
    if (!profileRaw.tools.every(tool => typeof tool === "string" && tool !== "")) return { problem: "profile.tools must be a tier name or a list of tool names." };
    tools = [...(profileRaw.tools as string[])];
  } else if (profileRaw.tools !== undefined) {
    return { problem: "profile.tools must be a tier name or a list of tool names." };
  }
  const profile: TemplateProfile = {
    name,
    description,
    ...(stringOr(profileRaw.title).trim() !== "" ? { title: stringOr(profileRaw.title).trim().slice(0, 64) } : {}),
    ...(stringOr(profileRaw.avatarColor).trim() !== "" ? { avatarColor: stringOr(profileRaw.avatarColor).trim() } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };

  const memory: TemplateMemory[] = [];
  for (const [index, entry] of (Array.isArray(value.memory) ? value.memory : []).entries()) {
    if (!isRecord(entry)) return { problem: `memory[${index}] is not an object.` };
    const kind = entry.kind === "pitfall" ? "pitfall" : entry.kind === "fact" || entry.kind === undefined ? "fact" : undefined;
    if (kind === undefined) return { problem: `memory[${index}].kind "${String(entry.kind)}" is not fact or pitfall; episodes and notes do not travel.` };
    const text = stringOr(entry.text).trim();
    if (text === "") return { problem: `memory[${index}].text is empty.` };
    if (text.length > 500) return { problem: `memory[${index}] is over 500 characters; a memory is a sentence or two.` };
    memory.push({ kind, text, ...(stringOr(entry.at).trim() !== "" ? { at: stringOr(entry.at).trim() } : {}) });
  }

  const readSkill = (entry: unknown, where: string): { skill: TemplateSkill } | { problem: string } => {
    if (!isRecord(entry)) return { problem: `${where} is not an object.` };
    const slug = stringOr(entry.slug).trim();
    if (!SLUG.test(slug)) return { problem: `${where}.slug "${slug}" is not a directory name (lowercase letters, digits, . _ -).` };
    if (!isRecord(entry.files)) return { problem: `${where}.files is missing.` };
    const files: Record<string, string> = {};
    for (const [path, content] of Object.entries(entry.files)) {
      if (!FILE_PATH.test(path)) return { problem: `${where}.files has an unsafe path "${path}".` };
      if (typeof content !== "string") return { problem: `${where}.files["${path}"] is not text; binaries do not travel.` };
      if (Buffer.byteLength(content, "utf8") > TEMPLATE_FILE_MAX_BYTES) return { problem: `${where}.files["${path}"] is over ${TEMPLATE_FILE_MAX_BYTES} bytes.` };
      files[path] = content;
    }
    const skillText = files[SKILL_FILENAME];
    if (skillText === undefined || skillText.trim() === "") return { problem: `${where} has no ${SKILL_FILENAME}.` };
    const parsed = parseSkillFile(skillText);
    const skillName = stringOr(entry.name).trim() || parsed.meta.name?.trim() || slug;
    const skillDescription = stringOr(entry.description).trim() || parsed.meta.description?.trim() || "";
    if (skillDescription === "") return { problem: `${where} has no description; it is the only thing read when choosing it.` };
    for (const key of ["owner", "authored_by", "because"]) {
      if (parsed.meta[key] !== undefined) return { problem: `${where}: ${SKILL_FILENAME} carries "${key}:", which never travels.` };
    }
    return { skill: { slug, name: skillName.slice(0, NAME_MAX), description: skillDescription.slice(0, 400), files } };
  };

  const skills: TemplateSkill[] = [];
  for (const [index, entry] of (Array.isArray(value.skills) ? value.skills : []).entries()) {
    const result = readSkill(entry, `skills[${index}]`);
    if ("problem" in result) return result;
    skills.push(result.skill);
  }
  const routines: TemplateRoutine[] = [];
  for (const [index, entry] of (Array.isArray(value.routines) ? value.routines : []).entries()) {
    const result = readSkill(entry, `routines[${index}]`);
    if ("problem" in result) return result;
    const meta = parseSkillFile(result.skill.files[SKILL_FILENAME]!).meta;
    if (meta.schedule === undefined && meta.trigger === undefined) {
      return { problem: `routines[${index}] has neither schedule: nor trigger:, so it is a skill, not a routine.` };
    }
    const fillIns: TemplateFillIn[] = [];
    for (const fillIn of Array.isArray((entry as Record<string, unknown>).fillIns) ? ((entry as Record<string, unknown>).fillIns as unknown[]) : []) {
      if (!isRecord(fillIn)) continue;
      const id = stringOr(fillIn.id).trim();
      const label = stringOr(fillIn.label).trim();
      if (id !== "" && label !== "") fillIns.push({ id, label });
    }
    routines.push({ ...result.skill, fillIns });
  }
  const seen = new Set<string>();
  for (const entry of [...skills, ...routines]) {
    if (seen.has(entry.slug)) return { problem: `"${entry.slug}" appears twice.` };
    seen.add(entry.slug);
  }

  const connectors = (Array.isArray(value.connectors) ? value.connectors : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map(entry => entry.trim());

  let gettingStarted: BotTemplate["gettingStarted"];
  if (value.gettingStarted !== undefined) {
    const skill = isRecord(value.gettingStarted) ? stringOr(value.gettingStarted.skill).trim() : "";
    if (!skills.some(entry => entry.slug === skill || entry.name === skill)) {
      return { problem: `gettingStarted.skill "${skill}" is not one of this template's skills.` };
    }
    gettingStarted = { skill: skills.find(entry => entry.slug === skill || entry.name === skill)!.slug };
  }

  const metaRaw = isRecord(value.meta) ? value.meta : {};
  const meta: BotTemplate["meta"] = {
    ...(stringOr(metaRaw.createdAt).trim() !== "" ? { createdAt: stringOr(metaRaw.createdAt).trim() } : {}),
    ...(stringOr(metaRaw.createdBy).trim() !== "" ? { createdBy: stringOr(metaRaw.createdBy).trim().slice(0, NAME_MAX) } : {}),
    ...(stringOr(metaRaw.sourceName).trim() !== "" ? { sourceName: stringOr(metaRaw.sourceName).trim().slice(0, NAME_MAX) } : {}),
  };

  const template: BotTemplate = {
    format: TEMPLATE_FORMAT,
    profile,
    memory,
    skills,
    routines,
    connectors,
    ...(gettingStarted !== undefined ? { gettingStarted } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(template), "utf8") > TEMPLATE_MAX_BYTES) {
    return { problem: `The template is larger than ${TEMPLATE_MAX_BYTES} bytes.` };
  }
  const secret = secretsIn(template)[0];
  if (secret !== undefined) {
    return { problem: `${secret.where} looks like it holds a credential (${secret.pattern}: ${secret.excerpt}). Take it out; a template never carries one.` };
  }
  return { template };
}

/** Every string in the document, against the credential shapes secret-scan.ts knows. */
export function secretsIn(template: BotTemplate): { where: string; pattern: string; excerpt: string }[] {
  const hits: { where: string; pattern: string; excerpt: string }[] = [];
  const check = (where: string, text: string): void => {
    for (const hit of scanText(text).patterns) hits.push({ where, pattern: hit.pattern, excerpt: hit.excerpt });
  };
  check("profile.description", template.profile.description);
  for (const [index, entry] of template.memory.entries()) check(`memory[${index}]`, entry.text);
  for (const entry of [...template.skills, ...template.routines]) {
    for (const [path, content] of Object.entries(entry.files)) check(`${entry.slug}/${path}`, content);
  }
  return hits;
}

// ── frontmatter surgery ─────────────────────────────────────────────────────────────

interface FrontmatterEntry {
  key: string;
  /** The key line and any indented continuation lines of a `|` / `>` block. */
  lines: string[];
}

function splitFrontmatter(text: string): { entries: FrontmatterEntry[]; body: string } | undefined {
  const normalised = text.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalised);
  if (match === null) return undefined;
  const entries: FrontmatterEntry[] = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const continuation = /^(?: {2}|\t)/.test(line) && entries.length > 0;
    if (continuation) {
      entries[entries.length - 1]!.lines.push(line);
      continue;
    }
    const at = line.indexOf(":");
    const key = at > 0 ? line.slice(0, at).trim().toLowerCase() : "";
    entries.push({ key, lines: [line] });
  }
  return { entries, body: normalised.slice(match[0].length) };
}

function joinFrontmatter(entries: readonly FrontmatterEntry[], body: string): string {
  const lines = entries.flatMap(entry => entry.lines).filter((line, index, all) => !(line.trim() === "" && index === all.length - 1));
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\r?\n/, "")}`;
}

/**
 * Rewrites a skill file's frontmatter without touching what it does not know about:
 * drops the keys named, replaces the value of the keys given, and adds the keys that are
 * absent. Continuation lines of a replaced or dropped block go with their key.
 */
export function rewriteFrontmatter(
  text: string,
  edits: { drop?: readonly string[]; set?: Record<string, string>; add?: Record<string, string> }
): string {
  const split = splitFrontmatter(text);
  if (split === undefined) return text;
  const drop = new Set(edits.drop ?? []);
  const set = edits.set ?? {};
  const entries: FrontmatterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of split.entries) {
    if (drop.has(entry.key)) continue;
    if (entry.key in set) {
      entries.push({ key: entry.key, lines: [`${entry.key}: ${set[entry.key]}`] });
      seen.add(entry.key);
      continue;
    }
    entries.push(entry);
    if (entry.key !== "") seen.add(entry.key);
  }
  for (const [key, value] of Object.entries(set)) {
    if (!seen.has(key)) entries.push({ key, lines: [`${key}: ${value}`] });
  }
  for (const [key, value] of Object.entries(edits.add ?? {})) {
    if (!seen.has(key) && !(key in set)) entries.push({ key, lines: [`${key}: ${value}`] });
  }
  return joinFrontmatter(entries, split.body);
}

/** The keys a skill file may carry into a template. Everything else is this installation's. */
const NEVER_TRAVELS = ["owner", "authored_by", "because", "paused"];

/** A skill as it travels: global, and without the lines that describe where it came from. */
export function packSkillText(text: string): string {
  return rewriteFrontmatter(text, { drop: [...NEVER_TRAVELS, "agent", "deliver", "chat"], set: { scope: "global" } });
}

// ── routines: placeholders and fill-ins ─────────────────────────────────────────────

export interface GeneraliseContext {
  /** This bot's own name, which becomes `{self}`. */
  self: string;
  /** Every other agent on the roster: a mention becomes `{teammate}`. */
  teammates?: readonly string[];
}

const CHAT_KEY = /\b(feishu|dingtalk|telegram):[A-Za-z0-9_+/=@.-]{4,}/g;
const CHAT_LABELS: Record<string, string> = {
  feishu: "Feishu chat to deliver to",
  dingtalk: "DingTalk chat to deliver to",
  telegram: "Telegram chat to deliver to",
};

function chatPlaceholder(key: string): { id: string; label: string } {
  const vendor = key.split(":")[0]!.toLowerCase();
  return CHAT_LABELS[vendor] !== undefined
    ? { id: `${vendor}_chat`, label: CHAT_LABELS[vendor]! }
    : { id: "chat", label: "Chat to deliver to" };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turns one installation's routine into everyone's: the chat it delivers to, the agent it
 * runs as, the zone its times are read in, and any teammate it names become `{placeholders}`,
 * and the body ends with the list of what the importing person has to supply — the same
 * "Ask the importing user for:" Grok Bot appends, so the new bot sees it without parsing.
 */
export function generaliseRoutine(text: string, context: GeneraliseContext): { text: string; fillIns: TemplateFillIn[] } {
  const split = splitFrontmatter(text);
  const fillIns = new Map<string, string>();
  const replacements: { from: string; to: string }[] = [];
  const remember = (from: string, placeholder: { id: string; label: string }): string => {
    fillIns.set(placeholder.id, placeholder.label);
    replacements.push({ from, to: `{${placeholder.id}}` });
    return `{${placeholder.id}}`;
  };
  const set: Record<string, string> = { scope: "global" };
  const drop = [...NEVER_TRAVELS];
  let hasSchedule = false;
  if (split !== undefined) {
    for (const entry of split.entries) {
      const value = entry.lines[0]!.slice(entry.lines[0]!.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
      switch (entry.key) {
        case "schedule":
          hasSchedule = value !== "";
          break;
        case "deliver":
        case "chat":
          if (value !== "") set[entry.key] = remember(value, chatPlaceholder(value));
          break;
        case "agent":
          set.agent = "{self}";
          if (value !== "") replacements.push({ from: value, to: "{self}" });
          break;
        case "timezone":
          if (value !== "") set.timezone = remember(value, { id: "timezone", label: "Timezone" });
          break;
        default:
          break;
      }
    }
  }
  if (hasSchedule && !fillIns.has("timezone")) fillIns.set("timezone", "Timezone");
  let rewritten = rewriteFrontmatter(text, { drop, set });
  const split2 = splitFrontmatter(rewritten);
  let body = split2?.body ?? rewritten;

  // Chat keys in the body, then names. Longest first so a name inside a longer name is safe.
  body = body.replace(CHAT_KEY, key => remember(key, chatPlaceholder(key)));
  for (const teammate of [...(context.teammates ?? [])].sort((a, b) => b.length - a.length)) {
    if (teammate.trim() === "" || teammate === context.self) continue;
    const mention = new RegExp(`@?\\b${escapeRegExp(teammate)}\\b`, "g");
    if (mention.test(body)) {
      body = body.replace(new RegExp(`@?\\b${escapeRegExp(teammate)}\\b`, "g"), () => remember(teammate, { id: "teammate", label: "Teammate to hand work to" }));
    }
  }
  if (context.self.trim() !== "") {
    body = body.replace(new RegExp(`@?\\b${escapeRegExp(context.self)}\\b`, "g"), "{self}");
  }
  for (const { from, to } of replacements.sort((a, b) => b.from.length - a.from.length)) {
    if (from.length >= 4) body = body.split(from).join(to);
  }
  body = body.replace(/\n*Ask the importing user for:\n(?:- .*\n?)*$/s, "").trimEnd();
  if (fillIns.size > 0) {
    body += `\n\nAsk the importing user for:\n${[...fillIns].map(([id, label]) => `- ${label} (\`{${id}}\`)`).join("\n")}\n`;
  }
  rewritten = split2 === undefined ? body : joinFrontmatter(split2.entries, body);
  return { text: rewritten, fillIns: [...fillIns].map(([id, label]) => ({ id, label })) };
}

/** `{self}` and any supplied fill-ins substituted; unknown placeholders are left for the bot to ask about. */
export function resolvePlaceholders(text: string, values: Record<string, string>, self: string): string {
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole: string, id: string): string => {
    if (id === "self") return self;
    const value = values[id];
    return value !== undefined && value !== "" ? value : whole;
  });
}

/** Which `{placeholders}` a text still carries, `{self}` excluded. */
export function unresolvedPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)) {
    if (match[1] !== "self") found.add(match[1]!);
  }
  return [...found];
}

// ── what the setup turn writes, stamped ─────────────────────────────────────────────

/**
 * What the host does to a skill file the new bot writes during its setup turn: the routine
 * starts paused whether or not the bot remembered, and the file says where it came from.
 * A claim for the audit trail; the provenance ledger holds the observed fact.
 */
export function stampTemplateWrite(content: string, templateId: string): string {
  const split = splitFrontmatter(content);
  if (split === undefined) return content;
  const meta = parseSkillFile(content).meta;
  const isRoutine = (meta.schedule ?? "").trim() !== "" || (meta.trigger ?? "").trim() !== "";
  return rewriteFrontmatter(content, {
    add: {
      authored_by: `${TEMPLATE_SOURCE_PREFIX}${templateId}`,
      ...(isRoutine ? { paused: "true" } : {}),
    },
    ...(isRoutine && (meta.paused ?? "").trim() !== "" && meta.paused !== "true" ? { set: { paused: "true" } } : {}),
  });
}

// ── the recipe the new bot reads ────────────────────────────────────────────────────

/** Where a template's files land in the box, per importing agent. */
export function recipeDirFor(agentName: string): string {
  return `${TEMPLATES_DIR}/${slugify(agentName)}`;
}

/**
 * The recipe as markdown the new bot reads and copies from. `{self}` is already its own
 * name; the other placeholders stay, and the fill-in list under each routine says what to
 * ask for. This, not the JSON, is what the cue points at: a model copies prose faithfully
 * and JSON with escaped newlines badly.
 */
export function renderRecipe(template: BotTemplate, options: { self: string }): string {
  const lines: string[] = [];
  const from = template.meta?.createdBy !== undefined ? ` by ${template.meta.createdBy}` : "";
  lines.push(`# Recipe for ${options.self} — from the template "${template.profile.name}"${from}`, "");
  lines.push("## Profile", "", template.profile.description, "");
  if (template.memory.length > 0) {
    lines.push("## Memories", "", "Save each one with RememberFact, in these words:", "");
    for (const entry of template.memory) {
      lines.push(`- ${entry.kind === "pitfall" ? "(pitfall) " : ""}${resolvePlaceholders(entry.text, {}, options.self)}`);
    }
    lines.push("");
  }
  const describeFiles = (entry: TemplateSkill, dir: string): void => {
    for (const [path, content] of Object.entries(entry.files)) {
      lines.push(`File \`${dir}/${path}\`:`, "", "````", resolvePlaceholders(content, {}, options.self).trimEnd(), "````", "");
    }
  };
  if (template.skills.length > 0) {
    lines.push("## Skills", "", `Write each one under \`${SKILLS_DIR}/<slug>/\` exactly as given.`, "");
    for (const entry of template.skills) {
      lines.push(`### ${entry.name} (\`${entry.slug}\`)`, "");
      describeFiles(entry, `${SKILLS_DIR}/${entry.slug}`);
    }
  }
  if (template.routines.length > 0) {
    lines.push(
      "## Routines",
      "",
      `Write each one under \`${SKILLS_DIR}/<slug>/\` exactly as given, keeping \`paused: true\` and every \`{placeholder}\`. ` +
        "Nothing runs until the person fills the placeholders in and turns it on.",
      ""
    );
    for (const entry of template.routines) {
      lines.push(`### ${entry.name} (\`${entry.slug}\`)`, "");
      if (entry.fillIns.length > 0) lines.push(`Needs from the person: ${entry.fillIns.map(fillIn => `${fillIn.label} (\`{${fillIn.id}}\`)`).join("; ")}.`, "");
      describeFiles(entry, `${SKILLS_DIR}/${entry.slug}`);
    }
  }
  if (template.connectors.length > 0) {
    lines.push("## Connectors this work uses", "", template.connectors.map(name => `- ${name}`).join("\n"), "");
  }
  if (template.gettingStarted !== undefined) {
    lines.push("## Getting started", "", `Read and follow the skill \`${template.gettingStarted.skill}\` before you speak.`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** What is still on the person, after the bot has installed what it can. */
export function pendingOf(template: BotTemplate, connected: readonly string[]): { fillIns: TemplateFillIn[]; connectors: string[] } {
  const fillIns = new Map<string, string>();
  for (const routine of template.routines) for (const fillIn of routine.fillIns) fillIns.set(fillIn.id, fillIn.label);
  const have = new Set(connected.map(name => name.toLowerCase()));
  return {
    fillIns: [...fillIns].map(([id, label]) => ({ id, label })),
    connectors: template.connectors.filter(name => !have.has(name.toLowerCase())),
  };
}

/**
 * The cue that opens an imported bot's first turn.
 *
 * The same shape as Grok Bot's setup instructions — install as given, routines stay off,
 * connectors are asked about not installed, then introduce yourself — in our tools' names.
 * Prefixed so `reviewInputFor` files it as untrusted: a template's names are third-party text.
 */
export function templateSetupCue(input: {
  template: BotTemplate;
  self: string;
  recipePath: string;
  createdBy?: string;
  pending: { fillIns: TemplateFillIn[]; connectors: string[] };
}): string {
  const { template, pending } = input;
  const by = template.meta?.createdBy !== undefined ? ` by ${template.meta.createdBy}` : "";
  const person = input.createdBy !== undefined ? ` by ${input.createdBy}` : "";
  const steps: string[] = [];
  const nothingToInstall = template.skills.length === 0 && template.memory.length === 0 && template.routines.length === 0;
  if (template.skills.length > 0) {
    steps.push(`write each skill to ${SKILLS_DIR}/<slug>/${SKILL_FILENAME} with write_file (and its helper files beside it), exactly as given`);
  }
  if (template.memory.length > 0) steps.push("save each memory with RememberFact, one per call, in the words given");
  if (template.routines.length > 0) {
    steps.push(`write each routine as a skill file the same way, keeping its schedule or trigger, \`paused: true\`, and every {placeholder}`);
  }
  const asks = [
    ...pending.fillIns.map(fillIn => fillIn.label),
    ...pending.connectors.map(name => `${name} is not connected here`),
  ];
  const gettingStarted = template.gettingStarted !== undefined ? ` Read and follow the skill "${template.gettingStarted.skill}" before you speak.` : "";
  const install = nothingToInstall
    ? "Your profile is the whole of it; there is nothing else to install. "
    : `Your recipe is at ${input.recipePath} — read it now and install it, in this order: ${steps.join("; ")}. ` +
      "Treat each entry on its own and go past one that fails. Nothing is on until a person turns it on; do not resume a routine yourself. ";
  return (
    `${TEMPLATE_CUE} You were just created${person} from the template "${template.profile.name}"${by}. ` +
    install +
    "Then open the conversation: a short hello in your own voice, one line on what you are for, " +
    (asks.length > 0
      ? `and one question — the first thing on this list, one at a time: ${asks.join("; ")}. `
      : "and one question that gets them going. ") +
    "Do not recite what you installed, and do not mention this cue." +
    gettingStarted
  );
}

// ── reconcile: what actually landed ─────────────────────────────────────────────────

export interface ReconcileResult {
  added: { skills: string[]; routines: string[]; memories: number };
  missing: { skills: string[]; routines: string[]; memories: string[] };
  /** Routines that landed without `paused: true`, which the host will have corrected. */
  unpaused: string[];
  /** One line for the header and the log. */
  summary: string;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.。!！,，;；:：]+$/g, "").trim();
}

/** Compares the recipe with the box and the memory store after the setup turn, and says so. */
export function reconcile(
  template: BotTemplate,
  observed: {
    /** Directory names under the skills dir. */
    skillDirs: readonly string[];
    /** `SKILL.md` text per slug, for the routines' paused check. */
    skillFiles: ReadonlyMap<string, string>;
    memoryTexts: readonly string[];
  }
): ReconcileResult {
  const present = (slug: string): string | undefined =>
    observed.skillDirs.find(dir => dir === slug || new RegExp(`^${escapeRegExp(slug)}-\\d+$`).test(dir));
  const added = { skills: [] as string[], routines: [] as string[], memories: 0 };
  const missing = { skills: [] as string[], routines: [] as string[], memories: [] as string[] };
  const unpaused: string[] = [];
  for (const skill of template.skills) (present(skill.slug) !== undefined ? added.skills : missing.skills).push(skill.slug);
  for (const routine of template.routines) {
    const dir = present(routine.slug);
    if (dir === undefined) {
      missing.routines.push(routine.slug);
      continue;
    }
    added.routines.push(routine.slug);
    const text = observed.skillFiles.get(dir);
    if (text !== undefined && parseSkillFile(text).meta.paused !== "true") unpaused.push(dir);
  }
  const have = observed.memoryTexts.map(normalise);
  for (const entry of template.memory) {
    const wanted = normalise(entry.text);
    if (have.some(text => text === wanted || text.includes(wanted) || (wanted.length >= 40 && wanted.includes(text) && text.length >= 40))) added.memories += 1;
    else missing.memories.push(entry.text);
  }
  const parts = [
    ...(added.skills.length > 0 ? [`${added.skills.length} skill${added.skills.length === 1 ? "" : "s"}`] : []),
    ...(added.memories > 0 ? [`${added.memories} memor${added.memories === 1 ? "y" : "ies"}`] : []),
    ...(added.routines.length > 0 ? [`${added.routines.length} routine${added.routines.length === 1 ? "" : "s"} (paused)`] : []),
  ];
  const gaps = [
    ...(missing.skills.length > 0 ? [`skills ${missing.skills.join(", ")}`] : []),
    ...(missing.routines.length > 0 ? [`routines ${missing.routines.join(", ")}`] : []),
    ...(missing.memories.length > 0 ? [`${missing.memories.length} memor${missing.memories.length === 1 ? "y" : "ies"}`] : []),
  ];
  const summary =
    gaps.length === 0
      ? `Added ${template.profile.name}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}.`
      : `Added ${template.profile.name}, but not all of it: missing ${gaps.join("; ")}.`;
  return { added, missing, unpaused, summary };
}

// ── packing: the bot chooses, the host reads the live files ─────────────────────────

export interface PackSelection {
  profile: { name?: string; title?: string; description: string; tools?: ToolTier | readonly string[] };
  memory: readonly { kind?: "fact" | "pitfall"; text: string; at?: string }[];
  skills: readonly { slug: string; body?: string; description?: string }[];
  routines: readonly { slug: string; body?: string; description?: string }[];
  connectors: readonly string[];
  gettingStarted?: { skill: string };
}

export interface PackSource {
  listDir(path: string): Promise<{ entries: { name: string; type: string }[] }>;
  readFile(path: string): Promise<{ content?: string; text?: string }>;
}

export interface PackContext {
  self: { name: string; title?: string; avatarColor?: string; tools?: readonly string[] };
  teammates: readonly string[];
  /** This bot's own records, so a memory about a person is refused whatever words it arrives in. */
  memoryRecords: readonly MemoryRecord[];
  createdBy?: string;
  now?: () => string;
}

/**
 * How much of an `about` record may appear in a passed memory before it is that record.
 * Twenty characters is a clause: shorter and "the digest" would refuse every memory that
 * mentions one, longer and a short record about a person slips past inside a longer sentence.
 */
const ABOUT_OVERLAP = 20;

/**
 * Packs what the bot selected from what is actually on disk. The bot's `body` — if it gave
 * one — replaces the markdown below the frontmatter and nothing else, so a bot can generalise a
 * skill it has and cannot invent one it does not. Whatever is dropped is named, never silent.
 */
export async function packTemplate(
  source: PackSource,
  selection: PackSelection,
  context: PackContext
): Promise<{ template: BotTemplate; dropped: string[] } | { refused: string }> {
  const dropped: string[] = [];
  const aboutTexts = context.memoryRecords.filter(record => record.about !== undefined).map(record => normalise(record.text));
  const memory: TemplateMemory[] = [];
  for (const entry of selection.memory) {
    const text = entry.text.trim();
    if (text === "") continue;
    const wanted = normalise(text);
    const personal = aboutTexts.find(
      about => about === wanted || (about.length >= ABOUT_OVERLAP && wanted.includes(about)) || (wanted.length >= ABOUT_OVERLAP && about.includes(wanted))
    );
    if (personal !== undefined) {
      return { refused: `The memory "${text.slice(0, 60)}…" is about a person here, and those never travel. Leave it out and call again.` };
    }
    memory.push({ kind: entry.kind === "pitfall" ? "pitfall" : "fact", text, ...(entry.at !== undefined ? { at: entry.at } : {}) });
  }

  const readSkillDir = async (slug: string): Promise<Record<string, string> | undefined> => {
    let entries: { name: string; type: string }[];
    try {
      entries = (await source.listDir(`${SKILLS_DIR}/${slug}`)).entries;
    } catch {
      return undefined;
    }
    const files: Record<string, string> = {};
    const walk = async (dir: string, rel: string, list: { name: string; type: string }[]): Promise<void> => {
      for (const entry of list) {
        const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.type === "directory") {
          try {
            await walk(`${dir}/${entry.name}`, path, (await source.listDir(`${dir}/${entry.name}`)).entries);
          } catch {
            dropped.push(`${slug}/${path}: could not be listed`);
          }
          continue;
        }
        try {
          const read = await source.readFile(`${dir}/${entry.name}`);
          const content = read.content ?? read.text ?? "";
          if (Buffer.byteLength(content, "utf8") > TEMPLATE_FILE_MAX_BYTES) {
            dropped.push(`${slug}/${path}: over ${TEMPLATE_FILE_MAX_BYTES} bytes`);
            continue;
          }
          files[path] = content;
        } catch {
          dropped.push(`${slug}/${path}: not text`);
        }
      }
    };
    await walk(`${SKILLS_DIR}/${slug}`, "", entries);
    return files[SKILL_FILENAME] === undefined ? undefined : files;
  };

  const withBody = (text: string, body: string | undefined): string | { problem: string } => {
    if (body === undefined || body.trim() === "") return text;
    if (body.trimStart().startsWith("---")) return { problem: "body is a raw file copy; pass the job text below the frontmatter only" };
    const split = splitFrontmatter(text);
    if (split === undefined) return `${body.trim()}\n`;
    return joinFrontmatter(split.entries, `\n${body.trim()}\n`);
  };

  const skills: TemplateSkill[] = [];
  const routines: TemplateRoutine[] = [];
  const packOne = async (ref: { slug: string; body?: string; description?: string }, asRoutine: boolean): Promise<void> => {
    const slug = ref.slug.trim();
    const files = await readSkillDir(slug);
    if (files === undefined) {
      dropped.push(`${slug}: no such skill here`);
      return;
    }
    const meta = parseSkillFile(files[SKILL_FILENAME]!).meta;
    if (meta.scope === "agent" && meta.owner !== undefined && meta.owner.trim() !== "" && meta.owner.trim() !== context.self.name) {
      dropped.push(`${slug}: belongs to ${meta.owner.trim()}, not to you`);
      return;
    }
    const bodied = withBody(files[SKILL_FILENAME]!, ref.body);
    if (typeof bodied !== "string") {
      dropped.push(`${slug}: ${bodied.problem}`);
      return;
    }
    const isRoutine = (meta.schedule ?? "").trim() !== "" || (meta.trigger ?? "").trim() !== "";
    if (asRoutine && !isRoutine) {
      dropped.push(`${slug}: has no schedule or trigger, so it was packed as a skill`);
    }
    const description = (ref.description?.trim() || meta.description?.trim() || "").slice(0, 400);
    if (description === "") {
      dropped.push(`${slug}: no description; give one`);
      return;
    }
    let text = rewriteFrontmatter(bodied, { set: { description } });
    if (isRoutine) {
      const generalised = generaliseRoutine(text, { self: context.self.name, teammates: context.teammates });
      routines.push({ slug, name: meta.name?.trim() || slug, description, files: { ...files, [SKILL_FILENAME]: generalised.text }, fillIns: generalised.fillIns });
      return;
    }
    text = packSkillText(text);
    skills.push({ slug, name: meta.name?.trim() || slug, description, files: { ...files, [SKILL_FILENAME]: text } });
  };
  for (const ref of selection.skills) await packOne(ref, false);
  for (const ref of selection.routines) await packOne(ref, true);

  const tools = selection.profile.tools ?? tierOf(context.self.tools);
  const draft: Record<string, unknown> = {
    format: TEMPLATE_FORMAT,
    profile: {
      name: (selection.profile.name?.trim() || context.self.name).slice(0, NAME_MAX),
      description: selection.profile.description.trim(),
      ...(selection.profile.title?.trim() || context.self.title ? { title: selection.profile.title?.trim() || context.self.title } : {}),
      ...(context.self.avatarColor !== undefined ? { avatarColor: context.self.avatarColor } : {}),
      ...(tools !== undefined ? { tools } : {}),
    },
    memory,
    skills,
    routines,
    connectors: [...new Set(selection.connectors.map(name => name.trim()).filter(name => name !== ""))],
    ...(selection.gettingStarted !== undefined ? { gettingStarted: selection.gettingStarted } : {}),
    meta: {
      createdAt: (context.now ?? (() => new Date().toISOString()))(),
      ...(context.createdBy !== undefined ? { createdBy: context.createdBy } : {}),
      sourceName: context.self.name,
    },
  };
  const parsed = parseTemplate(draft);
  if ("problem" in parsed) return { refused: parsed.problem };
  return { template: parsed.template, dropped };
}

/** The tier a tool list is, if it is exactly one; else the list itself; absent means "everything". */
export function tierOf(tools: readonly string[] | undefined): ToolTier | readonly string[] | undefined {
  if (tools === undefined) return undefined;
  const set = new Set(tools);
  for (const [tier, list] of Object.entries(TOOL_TIERS) as [ToolTier, readonly string[]][]) {
    if (list.length === set.size && list.every(tool => set.has(tool))) return tier;
  }
  return [...tools];
}

/** The tool list a template asks for, as the importer resolves it. */
export function toolsOf(template: BotTemplate): readonly string[] | undefined {
  const tools = template.profile.tools;
  if (tools === undefined) return undefined;
  return typeof tools === "string" ? TOOL_TIERS[tools] : tools;
}

/** A short id for a staged or imported template: enough to be unique here, short enough to read. */
export function templateId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "";
  for (let at = 0; at < 21; at++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

/** One line for a card: counts of what a template carries. */
export function describeTemplate(template: BotTemplate): string {
  const parts = [
    `${template.skills.length} skill${template.skills.length === 1 ? "" : "s"}`,
    `${template.routines.length} routine${template.routines.length === 1 ? "" : "s"}`,
    `${template.memory.length} memor${template.memory.length === 1 ? "y" : "ies"}`,
    ...(template.connectors.length > 0 ? [`needs ${template.connectors.join(", ")}`] : []),
  ];
  return parts.join(", ");
}

// ── the catalog, in the same format ─────────────────────────────────────────────────

/**
 * A catalog expert as a template: the persona and the tool tier, and nothing to install —
 * the hub skills it is written to use are seeded globally into every box, so the recipe names
 * none. One pipeline for first-party and third-party bots (docs/29 §6), and a file a person
 * can hand to another installation.
 */
export function catalogTemplate(expert: CatalogExpert): BotTemplate {
  const tools = tierOf(expert.tools);
  return {
    format: TEMPLATE_FORMAT,
    profile: {
      name: expert.name,
      title: expert.title,
      description: expert.description,
      ...(tools !== undefined ? { tools } : {}),
    },
    memory: [],
    skills: [],
    routines: [],
    connectors: [],
    meta: { createdBy: "lumenbox catalog", sourceName: expert.slug },
  };
}

