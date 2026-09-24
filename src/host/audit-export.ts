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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative as relativeTo } from "node:path";
import { FETCHED_DIRNAME, readFrontmatter, verifyKept } from "./fetched.ts";
import { RESULTS_DIRNAME } from "./results.ts";
import { archivedLines } from "./jsonl.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { conversationIdFor } from "../agents/registry.ts";
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
  /**
   * Pages the box's agents fetched inside the window (fetched.ts), by export-relative
   * path, with the byte count written. Markdown, not records — listed apart from `files`
   * so a reader of the ledgers does not try to parse prose as JSON.
   */
  fetched?: Record<string, number>;
  /**
   * Tool results too long for the transcript, kept whole at the cut (results.ts), in the
   * same form and for the same reason as `fetched`. This is where the answer to "what did
   * that call actually return" lives once the transcript has only its first two thousand
   * characters.
   */
  results?: Record<string, number>;
  /**
   * Whether the evidence in this export is still what it said it was (INV-659).
   *
   * Every kept file carries a digest of its own body, and until now nothing read it back.
   * An export that carries a quietly corrupted page out as evidence is worse than one that
   * carries nothing, so the check runs and its result travels with the files.
   */
  evidence?: { verified: number; mismatched: number; failures: string[] };
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

/**
 * A `record` ledger's lines, archives first, then the live file (jsonl.ts).
 *
 * A record's compaction moves settled lines aside rather than dropping them, so the live
 * file alone is only the recent tail — and an export asked for last month would have found
 * exactly the lines a compaction had already moved.
 */
function readRecord(path: string): string[] {
  return [...archivedLines(path), ...readLines(path)];
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
  write("answer-review.jsonl", select(readLines(join(options.home, "answer-review.jsonl")), record => typeof record.agent === "string" && (agentIds.has(record.agent) || agentNames.has(record.agent))));
  write("vault-audit.jsonl", select(readLines(join(options.home, "vault-audit.jsonl")), byAgentId));
  write("network-events.jsonl", select(readLines(join(options.home, "network-events.jsonl")), record => record.box === box.id || record.box === box.name));
  write("turns.jsonl", select(readRecord(join(options.home, "turns.jsonl")), byAgentId));
  // Every arrival at a door and what became of it (ingress.ts). Taken by time alone: an
  // arrival names no agent, because which agent it reaches is decided after it is written.
  // Both of these are `record` ledgers, so their archives are read as well as their live
  // files — before INV-634 a compaction had already emptied the month being exported.
  write("ingress.jsonl", select(readRecord(join(options.home, "ingress.jsonl")), () => true));
  // What people said through the doors, as they said it (messages.ts, INV-613). A message
  // names no agent — the door decides that later — so it is the box's when the
  // conversation it went into belongs to one of the box's agents.
  const conversationIds = new Set<string>();

  for (const agent of agents) {
    const conversations = registry.listConversations(agent.id).flatMap(({ id }) => {
      const store = registry.contextStore(agent.id, id);
      return store.versions().map(epoch => ({ name: id, epoch, path: store.path("transcript", epoch) }));
    });
    for (const conversation of conversations) {
      conversationIds.add(conversation.name);
      const lines = select(readLines(conversation.path), () => true);
      if (lines.length === 0 && !existsSync(conversation.path)) continue;
      write(join("transcripts", agent.id, conversation.epoch === 0 ? `${conversation.name}.jsonl` : `${conversation.name}.epoch-${conversation.epoch}.jsonl`), lines);
    }
  }
  // Dated by `receivedAt`, which is the ledger's own word for it; `select` reads `at`.
  const messageLines: string[] = [];
  for (const line of readLines(join(options.home, "messages.jsonl"))) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record.conversationKey !== "string" || !conversationIds.has(conversationIdFor(record.conversationKey))) continue;
    const inside = within(record.receivedAt, from, to);
    if (inside === undefined) {
      undated += 1;
      continue;
    }
    if (inside) messageLines.push(line);
  }
  write("messages.jsonl", messageLines);

  // What the agents read, and what the tools said. A fetched page is evidence for what was
  // said about it; a kept result is evidence for what a call returned once the transcript
  // has only its head. Both are taken with the same window and the same redaction as
  // everything else here, and both are listed apart from the ledgers because they are
  // prose rather than records.
  const walkKept = (
    root: string,
    options_: { prefix: string; extension: string; timeKey: string },
    into: Record<string, number>
  ): void => {
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        let isDir = false;
        try {
          isDir = statSync(path).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          walk(path);
          continue;
        }
        if (!name.endsWith(options_.extension)) continue;
        let text: string;
        try {
          text = readFileSync(path, "utf8");
        } catch {
          continue;
        }
        const head = readFrontmatter(text);
        // Ours: written for one of this box's agents. A kept X post names no agent (it is
        // shared by whoever fetched it) and is taken by time alone.
        const owner = head.agent_id;
        if (owner !== undefined && !agentIds.has(owner)) continue;
        const at = head[options_.timeKey];
        if (at === undefined) {
          undated += 1;
          continue;
        }
        const inWindow = within(at, from, to);
        if (inWindow !== true) continue;
        const relative = join(options_.prefix, relativeTo(root, path));
        const outPath = join(options.out, relative);
        mkdirSync(join(outPath, ".."), { recursive: true });
        const out: string[] = [];
        for (const line of text.split("\n")) {
          const redacted = redactLine(line, held);
          redactions.exact += redacted.exact;
          redactions.pattern += redacted.pattern;
          out.push(redacted.text);
        }
        const body = out.join("\n");
        writeFileSync(outPath, body, { mode: 0o600 });
        into[relative] = Buffer.byteLength(body, "utf8");
      }
    };
    walk(root);
  };

  const fetched: Record<string, number> = {};
  walkKept(
    join(options.home, FETCHED_DIRNAME),
    { prefix: "fetched", extension: ".md", timeKey: "fetched_at" },
    fetched
  );
  const results: Record<string, number> = {};
  walkKept(
    join(options.home, RESULTS_DIRNAME),
    { prefix: "results", extension: ".txt", timeKey: "at" },
    results
  );

  // Checked on the way out, over the same two stores the export just walked. A mismatch is
  // reported rather than thrown: an operator asking for an audit needs the export *and* the
  // bad news, not an error instead of both.
  const evidence = verifyKept(options.home);

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
    ...(Object.keys(fetched).length > 0 ? { fetched } : {}),
    ...(Object.keys(results).length > 0 ? { results } : {}),
    ...(evidence.verified + evidence.mismatched > 0
      ? {
          evidence: {
            verified: evidence.verified,
            mismatched: evidence.mismatched,
            failures: evidence.failures.map(failure => relativeTo(options.home, failure.path)),
          },
        }
      : {}),
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
  const fetchedFiles = Object.keys(manifest.fetched ?? {});
  if (fetchedFiles.length > 0) lines.push(`  fetched pages: ${fetchedFiles.length} file(s)`);
  const resultFiles = Object.keys(manifest.results ?? {});
  if (resultFiles.length > 0) lines.push(`  kept tool results: ${resultFiles.length} file(s)`);
  if (manifest.evidence !== undefined) {
    lines.push(
      manifest.evidence.mismatched === 0
        ? `  evidence: ${manifest.evidence.verified} file(s) still match their digest`
        : `  evidence: ${manifest.evidence.mismatched} of ${manifest.evidence.verified + manifest.evidence.mismatched} file(s) DO NOT match their digest: ${manifest.evidence.failures.join(", ")}`
    );
  }
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
