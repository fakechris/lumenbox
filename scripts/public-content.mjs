/**
 * What may not appear in public text (INV-1381): this repo
 * is public, and a handoff written at the end of a long session is where a home directory, a
 * tailnet address or an operator's own host alias slips in. Ticket ids (INV-123) are allowed on
 * purpose: citing the ledger in public is how this project works.
 *
 * The internal names are listed as SHA-256 hashes of the token (`scripts/public-content.json`),
 * because a list of private names in a public file is the leak it exists to prevent. Add one with
 *   node -e 'console.log(require("crypto").createHash("sha256").update("the-name").digest("hex"))'
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Home directories that are part of the product, not a person's machine. */
const PRODUCT_HOMES = new Set(["box", "hostd"]);
/** Email domains that are placeholders by convention or by RFC 2606. */
const PLACEHOLDER_MAIL = /@([a-z0-9-]+\.)*(example\.(com|org|net)|example|local|localhost|test|invalid|corp\.com|users\.noreply\.github\.com)$/i;

const sha256 = text => createHash("sha256").update(text).digest("hex");

/**
 * Every problem in one text, as `line N: what`, never echoing a hashed internal name back (the
 * message says which rule, not the value). Empty when the text is clean.
 */
export function publicContentProblems(text, config = { internalNameHashes: [] }) {
  const hashes = new Set(config.internalNameHashes ?? []);
  const problems = [];
  text.split("\n").forEach((line, index) => {
    const at = `line ${index + 1}`;
    for (const match of line.matchAll(/\/Users\/([A-Za-z0-9._-]+)\//g)) problems.push(`${at}: a local home directory (/Users/${match[1]}/); write ~/ or <repo>/ instead`);
    for (const match of line.matchAll(/\/home\/([a-z0-9_-]+)\//g)) {
      if (!PRODUCT_HOMES.has(match[1])) problems.push(`${at}: a local home directory (/home/${match[1]}/); write ~/ instead`);
    }
    // Tailscale's CGNAT range, and private LAN addresses written as a single host (a CIDR is a rule, not a machine).
    for (const match of line.matchAll(/\b(100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|10\.\d{1,3}|192\.168)\.\d{1,3}\.\d{1,3}\b(?!\/\d)/g)) {
      problems.push(`${at}: a private network address (${match[0]}); write <tailnet ip> or a documentation address`);
    }
    for (const match of line.matchAll(/\b([a-z0-9-]+)\.ts\.net\b/gi)) {
      if (match[1].toLowerCase() !== "example") problems.push(`${at}: a tailnet name (*.ts.net); write example.ts.net`);
    }
    for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!PLACEHOLDER_MAIL.test(match[0])) problems.push(`${at}: an email address (${match[0].replace(/^[^@]+/, "…")}); use an example.com address`);
    }
    if (hashes.size > 0) {
      for (const token of line.match(/[A-Za-z0-9_@.-]+/g) ?? []) {
        const bare = token.replace(/^[.@-]+|[.@-]+$/g, "");
        if (bare !== "" && hashes.has(sha256(bare.toLowerCase()))) problems.push(`${at}: an internal host or account name listed in scripts/public-content.json`);
      }
    }
  });
  return problems;
}

/** The public text this repo publishes: every markdown file under docs/, plus the top-level readmes. */
export function publicFiles(root) {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };
  walk(join(root, "docs"));
  for (const name of ["README.md", "AGENTS.md"]) {
    try {
      statSync(join(root, name));
      files.push(join(root, name));
    } catch {
      // Not every checkout has both.
    }
  }
  return files;
}

/** Every problem across the public files, prefixed with the file. */
export function scanPublic(root) {
  const config = JSON.parse(readFileSync(join(root, "scripts", "public-content.json"), "utf8"));
  return publicFiles(root).flatMap(file => publicContentProblems(readFileSync(file, "utf8"), config).map(problem => `${relative(root, file)} ${problem}`));
}
