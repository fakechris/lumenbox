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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FAMILIES = new Set(["spec", "decision", "guide", "handoff"]);
export const STATUSES = new Set(["current", "superseded", "archived"]);

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
    docs.set(slug, header);
  }
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
  for (const [slug, header] of docs) {
    if (header.status !== "current") continue;
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
  return { docs, problems };
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
    "",
  ];
  for (const family of ["spec", "guide", "decision", "handoff"]) {
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
