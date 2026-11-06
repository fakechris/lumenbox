/**
 * The rule that keeps two documents from saying different things (docs/INDEX.md).
 *
 * Fifty-eight design documents accumulated in two months, and the failure they produce is
 * not untidiness: docs/22 §3 says per-agent visibility is retired while `auth.ts` still
 * gates on it, docs/35 §8's stage plan was replaced by docs/36 §4 in prose nobody greps,
 * and two files each claimed the numbers 35 and 37. A reader — a person or an agent —
 * then picks whichever they found first.
 *
 * So: every document declares what it is and whether it still stands, supersession is a
 * field rather than a sentence, and exactly one *current* spec owns each domain. The
 * index is generated from those headers, and this check fails the suite when the two
 * disagree. Nothing here reads prose; it reads the header block, which is the point.
 */

import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FAMILIES = new Set(["spec", "decision", "guide", "handoff", "manual"]);
export const STATUSES = new Set(["current", "superseded", "archived"]);
const TRANSLATION = /^(.+)\.[a-z]{2}$/;

/**
 * The header block: an HTML comment, so it does not render, and a flat key/value list,
 * so a shell one-liner can read it too.
 */
export function parseHeader(text) {
  if (!text.startsWith("<!-- doc:")) return undefined;
  const end = text.indexOf("-->");
  if (end < 0) return undefined;
  const fields = {};
  for (const line of text.slice(0, end).split("\n")) {
    const match = /^(?:<!--\s*)?\s*([a-z-]+):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    fields[match[1]] = match[2].trim();
  }
  return fields;
}

export function titleOf(text) {
  const line = text.split("\n").find(l => l.startsWith("# "));
  return line === undefined ? undefined : line.replace(/^#\s+/, "").replace(/^\d+\s*[.·—–-]*\s*/, "").trim();
}

export function lintDocs(dir) {
  const problems = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "INDEX.md");
  const docs = new Map();
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const text = readFileSync(join(dir, file), "utf8");
    const header = parseHeader(text);
    if (header === undefined) {
      problems.push(`${file}: no header block. Every document says what it is; see docs/INDEX.md.`);
      continue;
    }
    if (header.doc !== slug) problems.push(`${file}: header says doc: ${header.doc ?? "(none)"}, filename says ${slug}.`);
    if (!FAMILIES.has(header.family)) problems.push(`${file}: family: ${header.family ?? "(none)"} is not one of ${[...FAMILIES].join(", ")}.`);
    if (!STATUSES.has(header.status)) problems.push(`${file}: status: ${header.status ?? "(none)"} is not one of ${[...STATUSES].join(", ")}.`);
    const title = titleOf(text);
    if (title !== undefined && header.title !== undefined && header.title !== title) {
      problems.push(`${file}: header title "${header.title}" is not the heading "${title}".`);
    }
    if (header.family === "spec" && header.status === "current" && (header.domain ?? "") === "") {
      problems.push(`${file}: a current spec owns a domain; say which with domain:.`);
    }
    if (header.status === "superseded" && (header["superseded-by"] ?? "") === "") {
      problems.push(`${file}: superseded by what? Name the document, and say why in one line.`);
    }
    if (header.family === "manual") problems.push(`${file}: a manual page lives in docs/manual/, named by its concept.`);
    docs.set(slug, header);
  }
  const manual = lintManual(join(dir, "manual"));
  problems.push(...manual.problems);
  for (const [slug, header] of manual.pages) docs.set(`manual/${slug}`, header);
  // Supersession points at something that exists, and never at a document that is itself
  // superseded (a chain a reader has to walk is a chain a reader gets wrong).
  for (const [slug, header] of docs) {
    const by = header["superseded-by"];
    if (by === undefined || by === "") continue;
    const target = docs.get(by);
    if (target === undefined) problems.push(`${slug}: superseded-by ${by}, which is not a document here.`);
    else if (target.status === "superseded") problems.push(`${slug}: superseded by ${by}, which is itself superseded — point at the one that stands.`);
  }
  // Two documents claiming one number is how a reference stops meaning one thing: `docs/37`
  // meant connector doors in two code comments and onboarding in two documents, and both
  // were right. Numbers are how everything cites everything here, so a number is a name.
  const byNumber = new Map();
  // A translation (`89-thesis.zh.md`) shares its original's number and must have one.
  for (const slug of docs.keys()) {
    const original = TRANSLATION.exec(slug)?.[1];
    if (original !== undefined && !docs.has(original)) problems.push(`${slug}: a translation of ${original}, which is not a document here.`);
  }
  for (const [slug, header] of docs) {
    if (header.status !== "current" || TRANSLATION.test(slug)) continue;
    const number = /^(\d+)-/.exec(slug)?.[1];
    if (number === undefined) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), slug]);
  }
  for (const [number, claimants] of byNumber) {
    if (claimants.length > 1) {
      problems.push(`two current documents are numbered ${number}: ${claimants.join(", ")}. A number is how the code cites a document; give one of them the next free number.`);
    }
  }
  // The rule this file exists for: one current spec per domain.
  const byDomain = new Map();
  for (const [slug, header] of docs) {
    if (header.family !== "spec" || header.status !== "current") continue;
    const domain = header.domain ?? "";
    if (domain === "") continue;
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), slug]);
  }
  for (const [domain, owners] of byDomain) {
    if (owners.length > 1) {
      problems.push(`two current specs claim ${domain}: ${owners.join(", ")}. One of them is superseded; say which.`);
    }
  }
  problems.push(...lintSolutions(join(dir, "solutions")));
  return { docs, problems };
}

/**
 * The manual (INV-1661): `docs/manual/<concept>.md`, written for a person rather than for the
 * next engineer. A decision says why; a manual page says how, so they are never the same file.
 * A manual page is named by its concept, never by a number — the numbers are how the code cites
 * the design record, and a person looking for "approvals" should find `approvals.md`. Each page
 * says which concept it `covers:`, and two current pages may not cover one concept: that is the
 * one-spec-per-domain rule again, for the pages a person reads. A written page (not a generated
 * reference page, not the home page) keeps one skeleton, so a reader who learned one page can
 * read them all: what it is, how to do it in the app, in a chat and from the command line,
 * where to see the result, its limits, and what to read next.
 */
export const MANUAL_HOME = "README";
export const MANUAL_SECTIONS = ["What it is", "How to do it", "Where to see the result", "Limits", "Next"];
export const MANUAL_ENTRIES = ["In the app", "In a chat", "From the command line"];

/** The relative links in a page that point at a file which is not there. */
function brokenLinks(dir, text) {
  const broken = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (target === "" || /^[a-z]+:/i.test(target)) continue;
    if (!existsSync(join(dir, target))) broken.push(match[1]);
  }
  return broken;
}

/**
 * A team page (INV-1662): `docs/manual/teams/<slug>.md`, one per crew or team a person can set
 * up, written as a design a person can copy rather than a concept to learn. It has its own
 * skeleton — what each role does, how it is built, the minimal and the daily configuration,
 * what one real run cost, how to build the minimal version from the app, a chat and the command
 * line, what to watch, what stays the person's job, where to take it next — and ends with the
 * run its numbers come from. It `covers: crew:<slug>` or `team:<slug>`, the directory on the
 * manual's home page links to it, and its cost section states its basis: a figure without the
 * tokens, the time, the price and the date behind it is a claim, not a cost.
 */
export const TEAM_DIR = "teams";
export const TEAM_SECTIONS = [
  "## Architecture",
  "## Core design",
  "### Prompt",
  "### Tools and permissions",
  "### Skills",
  "### Memory",
  "### Credentials",
  "## Configuration: minimal and daily",
  "## Running cost",
  "## Build the minimal version",
  ...MANUAL_ENTRIES.map(s => `### ${s}`),
  "## Run monitoring",
  "## Outside the box",
  "## Extensions",
  "## The run this page is based on",
];
export const TEAM_COST_BASIS = "**Basis:**";

/** The checks every manual page shares, a concept page and a team page alike. */
function lintManualPage(dir, file, at, problems) {
  const slug = file.replace(/\.md$/, "");
  const text = readFileSync(join(dir, file), "utf8");
  const header = parseHeader(text);
  if (header === undefined) { problems.push(`${at}: no header block.`); return undefined; }
  if (header.doc !== slug) problems.push(`${at}: header says doc: ${header.doc ?? "(none)"}, filename says ${slug}.`);
  if (header.family !== "manual") problems.push(`${at}: family: ${header.family ?? "(none)"}; a page in docs/manual/ is family: manual.`);
  if (!STATUSES.has(header.status)) problems.push(`${at}: status: ${header.status ?? "(none)"} is not one of ${[...STATUSES].join(", ")}.`);
  if (/^\d/.test(slug)) problems.push(`${at}: a manual page is named by its concept, not by a number.`);
  if ((header.covers ?? "") === "") problems.push(`${at}: which concept does it cover? Say so with covers:.`);
  const generated = header.generated === "true";
  if (!generated && header.audience !== "user") problems.push(`${at}: a written manual page says audience: user, so the glossary's words are checked on it.`);
  const title = titleOf(text);
  if (title !== undefined && header.title !== undefined && header.title !== title) problems.push(`${at}: header title "${header.title}" is not the heading "${title}".`);
  for (const link of brokenLinks(dir, text)) problems.push(`${at}: links to ${link}, which is not there.`);
  return { slug, text, header, generated };
}

function skeletonProblem(at, text, expected) {
  const headings = [...text.matchAll(/^(#{2,3}) (.+)$/gm)].map(m => `${m[1]} ${m[2].trim()}`);
  const found = headings.filter(h => expected.includes(h));
  if (found.join("\n") !== expected.join("\n")) return `${at}: the skeleton is ${expected.join(" → ")}; this page has ${found.join(" → ") || "none of it"}.`;
  return undefined;
}

function introProblem(at, text) {
  const intro = text.slice(text.indexOf("\n# ") + 1).split("\n").slice(1).find(line => line.trim() !== "");
  return intro === undefined || intro.startsWith("#") ? `${at}: open with one line that says what the page is for, before the first section.` : undefined;
}

/** The text of one `## ` section, up to the next `## `. */
function sectionOf(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

export function lintManual(dir) {
  const problems = [];
  const pages = new Map();
  if (!existsSync(dir)) return { pages, problems };
  for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
    const at = `manual/${file}`;
    const page = lintManualPage(dir, file, at, problems);
    if (page === undefined) continue;
    const { slug, text, header, generated } = page;
    if (!generated && slug !== MANUAL_HOME) {
      const expected = [...MANUAL_SECTIONS.slice(0, 2).map(s => `## ${s}`), ...MANUAL_ENTRIES.map(s => `### ${s}`), ...MANUAL_SECTIONS.slice(2).map(s => `## ${s}`)];
      const skeleton = skeletonProblem(at, text, expected);
      if (skeleton !== undefined) problems.push(skeleton);
      const intro = introProblem(at, text);
      if (intro !== undefined) problems.push(intro);
    }
    pages.set(slug, header);
  }
  const teamDir = join(dir, TEAM_DIR);
  const home = existsSync(join(dir, `${MANUAL_HOME}.md`)) ? readFileSync(join(dir, `${MANUAL_HOME}.md`), "utf8") : "";
  if (existsSync(teamDir)) {
    for (const file of readdirSync(teamDir).filter(f => f.endsWith(".md")).sort()) {
      const at = `manual/${TEAM_DIR}/${file}`;
      const page = lintManualPage(teamDir, file, at, problems);
      if (page === undefined) continue;
      const { slug, text, header } = page;
      if (!/^(crew|team):[a-z0-9-]+$/.test(header.covers ?? "")) problems.push(`${at}: a team page covers crew:<slug> or team:<slug>, not ${header.covers ?? "(none)"}.`);
      const skeleton = skeletonProblem(at, text, TEAM_SECTIONS);
      if (skeleton !== undefined) problems.push(skeleton);
      const intro = introProblem(at, text);
      if (intro !== undefined) problems.push(intro);
      if (!sectionOf(text, "## Running cost").includes(TEAM_COST_BASIS)) problems.push(`${at}: the running cost says its basis in a ${TEAM_COST_BASIS} line — tokens, time, price and date, or "not measured yet" and what would measure it.`);
      if (!home.includes(`](${TEAM_DIR}/${file})`)) problems.push(`${at}: the manual's home page does not link to it; add it to the directory in ${MANUAL_HOME}.md.`);
      pages.set(`${TEAM_DIR}/${slug}`, header);
    }
  }
  const byConcept = new Map();
  for (const [slug, header] of pages) {
    if (header.status !== "current" || (header.covers ?? "") === "") continue;
    byConcept.set(header.covers, [...(byConcept.get(header.covers) ?? []), slug]);
  }
  for (const [concept, owners] of byConcept) {
    if (owners.length > 1) problems.push(`two current manual pages cover ${concept}: ${owners.join(", ")}. One concept, one page; merge them or supersede one.`);
  }
  return { pages, problems };
}

/**
 * The pitfall pages (INV-1483): `docs/solutions/<slug>.md`, outside the numbered documents and
 * their link rules, but each with a complete frontmatter — module, tags, problem_type, found —
 * and the four sections a pitfall is worth keeping for. A page that cannot say how to verify
 * the fix is a story, not a solution.
 */
export const SOLUTION_PROBLEM_TYPES = new Set(["runtime-error", "best-practice", "measurement"]);
export const SOLUTION_SECTIONS = ["Symptom", "Cause", "Fix", "Verify"];

export function parseSolutionFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return undefined;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

export function lintSolutions(dir) {
  const problems = [];
  if (!existsSync(dir)) return problems;
  for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const front = parseSolutionFrontmatter(text);
    if (front === undefined) { problems.push(`solutions/${file}: no frontmatter (module, tags, problem_type, found).`); continue; }
    for (const key of ["module", "tags", "problem_type", "found"]) if ((front[key] ?? "") === "") problems.push(`solutions/${file}: frontmatter lacks ${key}.`);
    if (front.problem_type !== undefined && !SOLUTION_PROBLEM_TYPES.has(front.problem_type)) problems.push(`solutions/${file}: problem_type ${front.problem_type} is not one of ${[...SOLUTION_PROBLEM_TYPES].join(", ")}.`);
    if (!/^# .+/m.test(text)) problems.push(`solutions/${file}: no title heading.`);
    for (const section of SOLUTION_SECTIONS) if (!new RegExp(`^\\*\\*${section}\\.\\*\\*`, "m").test(text)) problems.push(`solutions/${file}: no **${section}.** paragraph.`);
  }
  return problems;
}

/**
 * The controlled vocabulary (docs/glossary.md, INV-1657): one concept, one word. A page written
 * for a person may not use a word the glossary lists as a deprecated synonym — "door" where the
 * person reads "channel", "bot" where they read "agent". Specs keep their internal words; this
 * reads only the pages in `USER_FACING_DOCS` and any document whose header says `audience: user`.
 *
 * What is checked is prose: inline code, fenced blocks, URLs, link targets, HTML attributes and
 * the header comment are blanked first, so a command or a file name keeps its spelling, and the
 * glossary's allowed names (a product called Grok Bot) are blanked too.
 */
export const GLOSSARY = "docs/glossary.md";
export const USER_FACING_DOCS = ["README.md", "docs/37-onboarding.md", "docs/38-operators-guide.md"];

/** The glossary's tables, by the heading above each: rows of trimmed cells, header and rule rows dropped. */
function tablesOf(text) {
  const tables = new Map();
  let heading = "";
  for (const line of text.split("\n")) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { heading = h[1].trim(); continue; }
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
    if (cells.every(c => /^-+$/.test(c))) continue;
    tables.set(heading, [...(tables.get(heading) ?? []), cells]);
  }
  for (const rows of tables.values()) rows.shift(); // the header row
  return tables;
}

const ticked = cell => [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]);

export function parseGlossary(text) {
  const tables = tablesOf(text);
  const deprecated = [];
  for (const [terms, instead] of tables.get("Deprecated synonyms") ?? []) {
    for (const term of ticked(terms)) deprecated.push({ term, instead: (instead ?? "").replace(/`/g, "") });
  }
  const allowed = (tables.get("Allowed names") ?? []).flatMap(([name]) => ticked(name));
  return { concepts: tables.get("Concepts") ?? [], deprecated, allowed };
}

/** A line with everything that is not prose blanked out. */
function proseOf(line, allowed) {
  let prose = line
    .replace(/`[^`]*`/g, " ")
    .replace(/<!--.*?-->/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/[\w:-]+\s*=\s*"[^"]*"/g, " ")
    .replace(/[a-z]+:\/\/\S+/gi, " ");
  for (const name of allowed) prose = prose.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  return prose;
}

function matcherFor(term) {
  // A Chinese term has no word boundary to look for; a substring is the word.
  if ([...term].some(ch => ch.charCodeAt(0) > 127)) return text => text.includes(term);
  const body = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${body}(?![\\p{L}\\p{N}_-])`, "iu");
  return text => re.test(text);
}

/** `file:line` for every deprecated synonym in one text. */
export function vocabularyProblems(file, text, glossary) {
  const problems = [];
  const rules = glossary.deprecated.map(rule => ({ ...rule, hit: matcherFor(rule.term) }));
  const lines = text.split("\n");
  let fenced = false;
  let header = text.startsWith("<!--");
  lines.forEach((line, index) => {
    if (header) { if (line.includes("-->")) header = false; return; }
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    const prose = proseOf(line, glossary.allowed);
    for (const rule of rules) {
      if (rule.hit(prose)) problems.push(`${file}:${index + 1}: "${rule.term}" is a deprecated synonym; write "${rule.instead}" (${GLOSSARY}).`);
    }
  });
  return problems;
}

/**
 * The check: `patterns` are files or globs relative to `root` (default: the user-facing pages),
 * plus every `docs/` document whose header says `audience: user`.
 */
export function lintVocabulary(root, patterns = USER_FACING_DOCS, glossaryPath = join(root, GLOSSARY)) {
  const glossary = parseGlossary(readFileSync(glossaryPath, "utf8"));
  const problems = [];
  if (glossary.deprecated.length === 0) problems.push(`${GLOSSARY}: no "Deprecated synonyms" table, so nothing is checked.`);
  glossary.concepts.forEach((cells, index) => {
    if (cells.length !== 5 || cells.some(c => c === "")) problems.push(`${GLOSSARY}: concept row ${index + 1} needs all five columns filled.`);
  });
  const files = new Set(patterns.flatMap(pattern => globSync(pattern, { cwd: root })));
  for (const file of globSync("docs/**/*.md", { cwd: root })) {
    if (parseHeader(readFileSync(join(root, file), "utf8"))?.audience === "user") files.add(file);
  }
  for (const file of [...files].sort()) problems.push(...vocabularyProblems(file, readFileSync(join(root, file), "utf8"), glossary));
  return problems;
}

/** The index, generated: what exists, what it is, and what replaced it. */
export function renderIndex(docs) {
  const lines = [
    "<!-- doc: INDEX",
    "     title: What each document is, and whether it still stands",
    "     family: guide",
    "     status: current",
    "     updated: generated",
    "-->",
    "# What each document is, and whether it still stands",
    "",
    "Generated by `scripts/docs-lint.mjs` from each file's header block; `npm test` fails when",
    "this file and the headers disagree. Edit the header, not this table.",
    "",
    "- **spec** — normative and current. Exactly one owns each domain.",
    "- **decision** — a dated record of why something was decided. Never rewritten; superseded, with a pointer.",
    "- **guide** — how to do something. Kept current.",
    "- **handoff** — what was true at the end of a session. Historical by nature.",
    "- **manual** — how a person uses the product, one page per concept, in `manual/`, and one page per team in `manual/teams/`. Start at [the manual](manual/README.md).",
    "",
  ];
  for (const family of ["spec", "manual", "guide", "decision", "handoff"]) {
    const rows = [...docs.entries()].filter(([, h]) => h.family === family).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) continue;
    lines.push(`## ${family}`, "", "| doc | title | status | updated |", "|---|---|---|---|");
    for (const [slug, header] of rows) {
      const status =
        header.status === "superseded"
          ? `superseded by [${header["superseded-by"]}](${header["superseded-by"]}.md)${header.why ? ` — ${header.why}` : ""}`
          : header.status;
      lines.push(`| [${slug}](${slug}.md) | ${header.title ?? ""} | ${status} | ${header.updated ?? ""} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
