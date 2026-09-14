/**
 * The audit export (INV-433, docs/50 J4): one box, one time range, every ledger that
 * touches it, packed as files a compliance reader can keep and a parser can read back.
 *
 * The ledgers live apart because they are written apart — transcripts per agent,
 * usage and turns by the host, verdicts by the reviewer, resolutions by the vault,
 * network decisions by the relay. Retention needs them together, by place and by
 * time, which is what this does: it joins on the box's agents and on each record's
 * `at`, and writes JSON Lines of the same shape it read, so nothing has to be
 * re-learned by whoever imports it.
 *
 * Secrets are filtered before anything is written. Every value the vault or the
 * config holds becomes `<redacted:name>`, and anything that looks like a credential
 * (the same patterns `scan-records` uses) becomes `<redacted:pattern>`. The manifest
 * counts what it redacted, so a clean export says so with a number, not a promise.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistry } from "../agents/registry.ts";
import { CONVERSATIONS_DIRNAME, TRANSCRIPT_FILENAME } from "../agents/registry.ts";
import { CREDENTIAL_PATTERNS, MIN_EXACT_LENGTH } from "./secret-scan.ts";

export interface ExportOptions {
  /** ~/.agentbox, where the host's ledgers are. */
  home: string;
  registry: AgentRegistry;
  /** The box, by id or by name. */
  box: string;
  /** ISO instants, inclusive. */
  from: string;
  to: string;
  /** The directory to write; created if missing. */
  out: string;
  /** Values that must not appear in the export, by name. Never written anywhere. */
  held?: ReadonlyMap<string, string>;
  now?: () => Date;
}

export interface ExportManifest {
  format: "agentbox-audit-export/1";
  generatedAt: string;
  box: { id: string; name: string };
  from: string;
  to: string;
  agents: { id: string; name: string }[];
  /** Records written per file, by path relative to the export directory. */
  files: Record<string, number>;
  /** Lines that carried no readable `at` and so could not be placed in the window. */
  undated: number;
  redactions: { exact: number; pattern: number };
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "");
  } catch {
    return [];
  }
}

/** Replaces every held value and every credential-shaped string; counts what it replaced. */
export function redactLine(line: string, held: ReadonlyMap<string, string>): { text: string; exact: number; pattern: number } {
  let text = line;
  let exact = 0;
  let pattern = 0;
  for (const [name, value] of held) {
    if (value.length < MIN_EXACT_LENGTH || !text.includes(value)) continue;
    const parts = text.split(value);
    exact += parts.length - 1;
    text = parts.join(`<redacted:${name}>`);
  }
  for (const { name, pattern: rx } of CREDENTIAL_PATTERNS) {
    text = text.replace(new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`), () => {
      pattern += 1;
      return `<redacted:${name}>`;
    });
  }
  return { text, exact, pattern };
}

function within(at: unknown, from: number, to: number): boolean | undefined {
  if (typeof at !== "string") return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  return t >= from && t <= to;
}

export function exportAudit(options: ExportOptions): ExportManifest {
  const registry = options.registry;
  const box = registry.listBoxes().find(entry => entry.id === options.box || entry.name === options.box);
  if (box === undefined) {
    throw new Error(`no box ${options.box}; known: ${registry.listBoxes().map(entry => `${entry.name} (${entry.id})`).join(", ") || "none"}`);
  }
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error(`the range ${options.from} .. ${options.to} is not two instants in order`);
  const held = options.held ?? new Map();
  const agents = registry.agentsIn(box.id).map(record => ({ id: record.id, name: record.profile.name }));
  const agentIds = new Set(agents.map(agent => agent.id));
  const agentNames = new Set(agents.map(agent => agent.name));

  mkdirSync(options.out, { recursive: true });
  const files: Record<string, number> = {};
  let undated = 0;
  const redactions = { exact: 0, pattern: 0 };

  const write = (relative: string, lines: string[]): void => {
    const path = join(options.out, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    const out: string[] = [];
    for (const line of lines) {
      const redacted = redactLine(line, held);
      redactions.exact += redacted.exact;
      redactions.pattern += redacted.pattern;
      out.push(redacted.text);
    }
    writeFileSync(path, out.length > 0 ? `${out.join("\n")}\n` : "", { mode: 0o600 });
    files[relative] = out.length;
  };

  /** Keeps the lines about this box inside the window; the predicate says whose a line is. */
  const select = (lines: string[], ours: (record: Record<string, unknown>) => boolean): string[] => {
    const kept: string[] = [];
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!ours(record)) continue;
      const inside = within(record.at, from, to);
      if (inside === undefined) {
        undated += 1;
        continue;
      }
      if (inside) kept.push(line);
    }
    return kept;
  };

  const byAgentId = (record: Record<string, unknown>) => typeof record.agentId === "string" && agentIds.has(record.agentId);
  write("usage.jsonl", select(readLines(join(options.home, "usage.jsonl")), record => byAgentId(record) || record.box === box.id));
  // The reviewer records the agent by name (auto-review.ts): matched either way.
  write("auto-review.jsonl", select(readLines(join(options.home, "auto-review.jsonl")), record => byAgentId(record) || (typeof record.agent === "string" && (agentIds.has(record.agent) || agentNames.has(record.agent)))));
  write("vault-audit.jsonl", select(readLines(join(options.home, "vault-audit.jsonl")), byAgentId));
  write("network-events.jsonl", select(readLines(join(options.home, "network-events.jsonl")), record => record.box === box.id || record.box === box.name));
  write("turns.jsonl", select(readLines(join(options.home, "turns.jsonl")), byAgentId));

  for (const agent of agents) {
    const dir = registry.dirFor(agent.id);
    const conversations: { name: string; path: string }[] = [{ name: "main", path: join(dir, TRANSCRIPT_FILENAME) }];
    const side = join(dir, CONVERSATIONS_DIRNAME);
    if (existsSync(side)) {
      for (const file of readdirSync(side)) {
        if (file.endsWith(".jsonl") && !file.endsWith(".heard.jsonl")) conversations.push({ name: file.slice(0, -".jsonl".length), path: join(side, file) });
      }
    }
    for (const conversation of conversations) {
      const lines = select(readLines(conversation.path), () => true);
      if (lines.length === 0 && !existsSync(conversation.path)) continue;
      write(join("transcripts", agent.id, `${conversation.name}.jsonl`), lines);
    }
  }

  const manifest: ExportManifest = {
    format: "agentbox-audit-export/1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    box: { id: box.id, name: box.name },
    from: options.from,
    to: options.to,
    agents,
    files,
    undated,
    redactions,
  };
  writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Reads an export back: the manifest and every ledger's records, keyed as the manifest keys them. */
export function readAuditExport(dir: string): { manifest: ExportManifest; records: Record<string, Record<string, unknown>[]> } {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ExportManifest;
  if (manifest.format !== "agentbox-audit-export/1") throw new Error(`${dir} is not an audit export this reads (${String(manifest.format)})`);
  const records: Record<string, Record<string, unknown>[]> = {};
  for (const relative of Object.keys(manifest.files)) {
    records[relative] = readLines(join(dir, relative)).map(line => JSON.parse(line) as Record<string, unknown>);
  }
  return { manifest, records };
}

/** The report, for the terminal. */
export function describeExport(manifest: ExportManifest, out: string): string[] {
  const total = Object.values(manifest.files).reduce((sum, n) => sum + n, 0);
  const lines = [
    `Audit export for box ${manifest.box.name} (${manifest.box.id}), ${manifest.from} .. ${manifest.to}`,
    `  ${out}`,
    `  ${total} record(s) across ${Object.keys(manifest.files).length} file(s); ${manifest.agents.length} agent(s): ${manifest.agents.map(a => a.name).join(", ") || "none"}`,
  ];
  for (const [file, count] of Object.entries(manifest.files)) if (!file.startsWith("transcripts/")) lines.push(`  ${file}: ${count}`);
  const transcripts = Object.entries(manifest.files).filter(([file]) => file.startsWith("transcripts/"));
  if (transcripts.length > 0) lines.push(`  transcripts: ${transcripts.reduce((sum, [, n]) => sum + n, 0)} entries in ${transcripts.length} file(s)`);
  lines.push(`  redacted: ${manifest.redactions.exact} held value(s), ${manifest.redactions.pattern} credential-shaped string(s)`);
  if (manifest.undated > 0) lines.push(`  ${manifest.undated} line(s) had no readable time and were left out`);
  return lines;
}

/**
 * The values an export must not carry: everything the config and the vault hold. Read
 * here rather than through Vault on purpose — `list()` omits values, and that is the
 * surface this must not widen. This runs on the operator's machine against their own
 * files, at the trust level of reading the config.
 */
export function heldValues(home: string): Map<string, string> {
  const held = new Map<string, string>();
  const collect = (source: string, object: unknown, prefix = ""): void => {
    if (object === null || typeof object !== "object") return;
    for (const [key, value] of Object.entries(object as Record<string, unknown>)) {
      if (typeof value === "string") held.set(`${source}${prefix}.${key}`, value);
      else collect(source, value, `${prefix}.${key}`);
    }
  };
  try {
    collect("config", JSON.parse(readFileSync(join(home, "config.json"), "utf8")));
  } catch {
    // No config is an ordinary state.
  }
  try {
    const vault = JSON.parse(readFileSync(join(home, "vault.json"), "utf8")) as { secrets?: { id?: unknown; value?: unknown }[] };
    for (const secret of vault.secrets ?? []) {
      if (typeof secret?.id === "string" && typeof secret?.value === "string") held.set(`vault:${secret.id}`, secret.value);
    }
  } catch {
    // Likewise.
  }
  return held;
}
