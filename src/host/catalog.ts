/**
 * Built-in specialists, crews and connectors.
 *
 * Architecture, matching WorkBuddy / Doubao expert packs:
 *
 *   - A **crew** is several experts, not one persona wearing many hats.
 *   - An **expert** is a standing persona (how they work) plus a bound set of
 *     **standard skills** from the skill hub — the same packages other workbenches
 *     ship. The skill bodies live in `catalog-data/skills/` and are seeded into
 *     the box; the persona's skill-routing table says when to read which.
 *   - The starter team stays four. Catalog rows are installable, not seeded as
 *     agents.
 *
 * Personas are rewritten (no identity theatre, no fake KPIs, no frozen tool
 * names). Skill packages are copied, not paraphrased.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** On disk next to this module: hub skills and expert personas. */
export function catalogDataDir(): string {
  return fileURLToPath(new URL("./catalog-data", import.meta.url));
}

function persona(slug: string): string {
  return readFileSync(join(catalogDataDir(), "experts", `${slug}.md`), "utf8").trim();
}

/** Skill-hub packages we actually vendored. Missing SKILL.md is not a skill. */
export function hubSkillSlugs(): string[] {
  const dir = join(catalogDataDir(), "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => existsSync(join(dir, name, "SKILL.md")))
    .sort();
}

/** Files, tasks, memory, teammates. No browser, no desktop, no team-building. */
export const DESK_TOOLS: readonly string[] = [
  "bash",
  "Jobs",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "SetPlan",
  "SetTodos",
  "ReadHistory",
  "RememberFact",
  "Recall",
  "SendToAgent",
  "AskUser",
  "OtherThreads",
  "Tasks",
  "ClaimWork",
];

/** Desk plus the open web. For work that has to cite a page. */
export const WEB_TOOLS: readonly string[] = [
  ...DESK_TOOLS,
  "browser_open",
  "browser_snapshot",
  "browser_read",
  "browser_act",
  "browser_scroll",
  "browser_wait_for",
  "WebFetch",
  "WebSearch",
  "ReadFeishuDoc",
];

/** Desk plus delegated coding engines. No browser: the engine reads the repo. */
export const CODE_TOOLS: readonly string[] = [...DESK_TOOLS, "Delegate"];

export type CatalogDomain = "engineering" | "media" | "data" | "product";

export interface CatalogExpert {
  slug: string;
  domain: CatalogDomain;
  name: string;
  title: string;
  /** One line for menus and the CreateAgent tool description. */
  summary: string;
  /** Standing identity. Re-read every turn; never a briefing. */
  description: string;
  tools: readonly string[];
  /** Starter skills this role is written to use. Not bound; they are global. */
  skills: readonly string[];
}

export interface CatalogCrew {
  slug: string;
  domain: CatalogDomain;
  name: string;
  summary: string;
  /** Expert slugs, in the order they should be added. */
  members: readonly string[];
}

export interface CatalogConnector {
  slug: string;
  name: string;
  summary: string;
  /** How it actually exists here. Honest about missing halves. */
  how: string;
}

export const CATALOG_EXPERTS: readonly CatalogExpert[] = [
  {
    slug: "lin",
    domain: "engineering",
    name: "Lin",
    title: "工程师",
    summary: "Writes and verifies code; small changes by hand, large ones through a coding engine.",
    description: persona("lin"),
    tools: CODE_TOOLS,
    skills: ["diagnose", "fullstack-dev", "grill-me", "code-review"],
  },
  {
    slug: "heng",
    domain: "engineering",
    name: "Heng",
    title: "审查",
    summary: "Reviews a change for correctness and security; writes the review, does not rewrite the repo.",
    description: persona("heng"),
    tools: DESK_TOOLS,
    skills: ["code-review", "diagnose", "fullstack-dev"],
  },
  {
    slug: "mo",
    domain: "product",
    name: "Mo",
    title: "产品",
    summary: "Turns a vague wish into a spec someone can build; does not implement it.",
    description: persona("mo"),
    tools: [...DESK_TOOLS, "ReadFeishuDoc"],
    skills: ["grill-me", "market-researcher", "deep-research"],
  },
  {
    slug: "jian",
    domain: "media",
    name: "Jian",
    title: "主笔",
    summary: "Long-form writing a person will finish: articles, briefs, explainers.",
    description: persona("jian"),
    tools: WEB_TOOLS,
    skills: ["khazix-writer", "humanizer", "wechat-longform"],
  },
  {
    slug: "he",
    domain: "media",
    name: "He",
    title: "种草",
    summary: "Xiaohongshu-shaped notes: title, cover line, body, a few variants.",
    description: persona("he"),
    tools: WEB_TOOLS,
    skills: ["xiaohongshu-note", "marketing-skills", "humanizer", "content-repurposer"],
  },
  {
    slug: "jing",
    domain: "media",
    name: "Jing",
    title: "编剧",
    summary: "Spoken short-video scripts: hook, body, ask. Not footage.",
    description: persona("jing"),
    tools: DESK_TOOLS,
    skills: ["short-video-script", "content-repurposer", "humanizer"],
  },
  {
    slug: "xi",
    domain: "data",
    name: "Xi",
    title: "分析师",
    summary: "Turns a table into sentences a person can act on, with sources on every number.",
    description: persona("xi"),
    tools: WEB_TOOLS,
    skills: ["data-brief", "minimax-xlsx", "deep-research", "market-researcher"],
  },
];

export const CATALOG_CREWS: readonly CatalogCrew[] = [
  {
    slug: "ship",
    domain: "engineering",
    name: "研发小队",
    summary: "Product specifies, engineering builds, review is a different person.",
    members: ["mo", "lin", "heng"],
  },
  {
    slug: "media-desk",
    domain: "media",
    name: "内容小队",
    summary: "One source, three forms: long article, Xiaohongshu note, short-video script.",
    members: ["jian", "he", "jing"],
  },
];

export const CATALOG_CONNECTORS: readonly CatalogConnector[] = [
  {
    slug: "feishu",
    name: "飞书",
    summary: "The Feishu channel, plus reading cloud docs.",
    how:
      "A configured Feishu bot receives and sends in groups. ReadFeishuDoc reads docx and wiki; " +
      "sheets and bitables are not writable from here yet. Not a full office suite.",
  },
  {
    slug: "dingtalk",
    name: "钉钉",
    summary: "The DingTalk channel.",
    how: "A configured DingTalk bot receives and sends. Same shape as Feishu: a channel, not a CLI for every DingTalk product.",
  },
  {
    slug: "browser",
    name: "浏览器",
    summary: "The box browser: open, click, read.",
    how: "browser_* tools on the agent's desktop. No separate vendor login store; sites that need an account have to be signed in on that display.",
  },
  {
    slug: "mcp",
    name: "MCP",
    summary: "External services attached as tools.",
    how:
      "Named in config mcpServers. Unconfigured means none — the catalog does not invent " +
      "GitHub, Notion or 1688. Adding a server is an operator act, not a specialist's.",
  },
];

export function expertNamed(slug: string): CatalogExpert | undefined {
  return CATALOG_EXPERTS.find(entry => entry.slug === slug);
}

export function crewNamed(slug: string): CatalogCrew | undefined {
  return CATALOG_CREWS.find(entry => entry.slug === slug);
}

/** The expert rows a slug will install: one expert, or every member of a crew. */
export function profilesFor(slug: string): CatalogExpert[] | undefined {
  const expert = expertNamed(slug);
  if (expert !== undefined) return [expert];
  const crew = crewNamed(slug);
  if (crew === undefined) return undefined;
  const members: CatalogExpert[] = [];
  for (const member of crew.members) {
    const row = expertNamed(member);
    if (row === undefined) return undefined;
    members.push(row);
  }
  return members;
}

/**
 * Tools the new agent may hold: the catalog's list, cut down to what the creator
 * actually has. An unrestricted creator (undefined) keeps the catalog list.
 */
export function intersectTools(
  wanted: readonly string[],
  held: readonly string[] | undefined
): readonly string[] {
  if (held === undefined) return wanted;
  return wanted.filter(name => held.includes(name));
}

/** Compact menu for the CreateAgent tool description. */
export function catalogMenu(): string {
  const experts = CATALOG_EXPERTS.map(
    entry => `${entry.slug} (${entry.title}: ${entry.summary})`
  ).join(" ");
  const crews = CATALOG_CREWS.map(
    entry => `${entry.slug} (${entry.name}: ${entry.summary})`
  ).join(" ");
  return (
    `Built-in catalog — pass from as the slug after the user agrees. Experts: ${experts}. ` +
    `Crews (several agents): ${crews}. Prefer a catalog row over inventing a similar persona.`
  );
}
