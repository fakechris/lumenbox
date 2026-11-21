/**
 * One search over every conversation of every agent in the installation (INV-1751).
 *
 * `ReadHistory` reads one conversation. Nothing looked across an agent's conversations, let alone
 * across agents: what a teammate decided in a Feishu topic last week was on disk and unreachable
 * unless the reader already knew which file to open. This is the index that makes it reachable.
 *
 * **Derived, never a source.** It is built from `agents/<id>/conversation*.jsonl` (and each
 * conversation's context versions) and can be deleted at any time; a missing index, or one written
 * by another version of this file, is rebuilt from the transcripts, never migrated. SQLite's FTS5
 * with the trigram tokenizer, through `node:sqlite` — already in the Node and the Electron this
 * ships with, so no new dependency. Trigrams make a word match a substring match, which is what
 * `ReadHistory`'s search already means, and they work for Chinese, which has no spaces to split on.
 *
 * **Incremental by byte offset.** Each transcript file is remembered by its inode, the offset read
 * up to and the bytes just before it. A file that only grew is read from there; one rewritten in
 * place is read again whole (the rule `TranscriptCache` keeps). Only whole lines are read, so a
 * line being written while the index catches up is left for the next pass. An entry's number is
 * its place among the parsed lines of its context version — the same count `ReadHistory` keeps, so
 * a hit's anchor (`#42`, `e1#42`) is one `ReadHistory` reads back.
 *
 * **Bounded.** Catching up and searching share a time budget. A first build over a long history is
 * spread over several searches, newest files first, and every answer that was cut says so.
 *
 * **Whose words.** Each entry is split into pieces with a role — the person, the member whose record
 * it is, a teammate, the host, a tool — decided by `personAuthoredText` and the channel table
 * (compaction.ts, model-text.ts), the one answer to that question. What LumenBox wrote into the
 * conversation (notices, cues, summaries, `<system_reminder>` blocks) is indexed but left out of a
 * search unless its kind is asked for by name.
 *
 * **No secret comes back out.** Text is scrubbed with the export's redactor before it is stored,
 * and every snippet is scrubbed again on the way out, against the values held then.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AgentRegistry } from "../agents/registry.ts";
import { CONVERSATIONS_DIRNAME, MAIN_CONVERSATION } from "../agents/registry.ts";
import { redactLine } from "./audit-export.ts";
import { type HistoryEntry, personAuthoredText } from "./compaction.ts";
import { anchorOf } from "./history.ts";
import { entryChannel } from "./model-text.ts";

/** Beside the agents' directories; left out of backups (backup.ts), being derived. */
export const TRANSCRIPT_INDEX_FILENAME = "transcript-index.sqlite";
/** A different number here means a different index: the old file is deleted and rebuilt. */
export const TRANSCRIPT_INDEX_VERSION = 1;
/** How much of one piece is indexed: what was said, nearly whole; what a tool took or returned, its head. */
export const PIECE_CHARS = 4_000;
/** A call's arguments and a tool's output are evidence, not documents to store twice; their head is what a search needs. */
export const MATERIAL_CHARS = 1_000;
/** How much of a hit is shown around the match. */
export const SNIPPET_CHARS = 240;
export const DEFAULT_HITS = 20;
export const MAX_HITS = 50;
/** Catching up and searching together, per call. */
export const DEFAULT_BUDGET_MS = 1_500;
/** Bytes read per step of catching up; the budget is looked at between steps. */
const CHUNK_BYTES = 1 << 20;
const EDGE = 64;

/** Who wrote a piece. `member` is the agent whose record it is; `tool` is what a tool returned. */
export type HitRole = "person" | "member" | "teammate" | "host" | "tool";
/** What a piece is. The last three are LumenBox's writing, hidden unless named. */
export type HitKind = "message" | "call" | "result" | "notice" | "summary" | "reminder";
export const HIT_KINDS: readonly HitKind[] = ["message", "call", "result", "notice", "summary", "reminder"];
export const INJECTED_KINDS: ReadonlySet<HitKind> = new Set(["notice", "summary", "reminder"]);

export interface Piece {
  role: HitRole;
  kind: HitKind;
  text: string;
}

const REMINDER_BLOCK = /<system_reminder>[\s\S]*?<\/system_reminder>/g;

/**
 * An entry as the pieces a search can find, each with whose words it is. Every entry counts toward
 * the numbering whether or not it yields a piece; this only decides what is searchable.
 */
export function piecesOf(entry: unknown): Piece[] {
  if (entry === null || typeof entry !== "object") return [];
  const typed = entry as { role?: unknown; kind?: unknown; text?: unknown; blocks?: unknown; host?: unknown };
  const text = typeof typed.text === "string" ? typed.text : "";
  if (typed.kind === "summary") return text.trim() === "" ? [] : [{ role: "host", kind: "summary", text }];
  if (typed.kind === "blocks" && Array.isArray(typed.blocks)) {
    return typed.blocks.flatMap((block: { type?: string; text?: unknown; name?: unknown; input?: unknown }): Piece[] => {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return [{ role: "member", kind: "message", text: block.text }];
      if (block?.type === "tool_use") return [{ role: "member", kind: "call", text: `${String(block.name ?? "")} ${JSON.stringify(block.input ?? {})}` }];
      return [];
    });
  }
  if (typed.kind === "results" && Array.isArray(typed.blocks)) {
    return typed.blocks.flatMap((block: { content?: unknown }): Piece[] => {
      const content = block?.content;
      const said = typeof content === "string" ? content
        : Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => String(part.text ?? "")).join(" ") : "";
      return said.trim() === "" ? [] : [{ role: "tool", kind: "result", text: said }];
    });
  }
  if (typed.kind !== undefined || text.trim() === "") return [];
  if (typed.role === "assistant") return [{ role: typed.host === true ? "host" : "member", kind: typed.host === true ? "notice" : "message", text }];
  if (typed.role !== "user") return [];

  // A reminder block in an old record is LumenBox's, whoever's message it rode on.
  const pieces: Piece[] = (text.match(REMINDER_BLOCK) ?? []).map(block => ({ role: "host", kind: "reminder", text: block }));
  const rest = text.replace(REMINDER_BLOCK, "").trim();
  if (rest === "") return pieces;
  const own = { ...(entry as HistoryEntry), text: rest } as HistoryEntry;
  const person = personAuthoredText(own);
  if (person !== undefined) {
    // The person's part comes first; what follows the wake boundary is teammates' (compaction.ts beforeWake).
    if (person.trim() !== "") pieces.push({ role: "person", kind: "message", text: person });
    const after = rest.slice(person.length).trim().replace(/^-{3}\s*/, "");
    if (after !== "") pieces.push({ role: "teammate", kind: "message", text: after });
    return pieces;
  }
  // Not the person's: a teammate's wake, or the host's — a notice, a cue, a turn never recorded as a person's (request-provenance.ts).
  pieces.push(entryChannel(own) === "teammate" ? { role: "teammate", kind: "message", text: rest } : { role: "host", kind: "notice", text: rest });
  return pieces;
}

export interface Hit {
  agentId: string;
  agent: string;
  conversation: string;
  epoch: number;
  /** As `ReadHistory` takes it in `around`. */
  anchor: string;
  index: number;
  at: string;
  role: HitRole;
  kind: HitKind;
  snippet: string;
  turnId?: string;
}

export interface SearchQuery {
  /** Words that must all appear, case-insensitive. */
  words?: string;
  /** A JavaScript regular expression, case-insensitive. Either this or `words`. */
  regex?: string;
  /** Only entries at or after this time. */
  since?: Date;
  /** Only these agents (ids); always within what the reader may read. */
  agents?: readonly string[];
  conversation?: string;
  /** Only these kinds. Absent: everything but what LumenBox injected. */
  kinds?: readonly HitKind[];
  /** Conversations left out, as `agentId/conversation`: the caller's own current one. */
  exclude?: readonly string[];
  limit?: number;
  budgetMs?: number;
}

export interface SearchResult {
  hits: Hit[];
  /** More matched than were returned. */
  more: boolean;
  /**
   * Why the answer may not be everything; absent when it is. `behind`: transcript files the index
   * had not caught up with in the time; `reached`: a reading search stopped at entries this old.
   */
  incomplete?: { behind?: number; reached?: string };
  /** Nothing was searched: no words or pattern, or a pattern that does not compile (`why`). */
  problem?: { code: "empty" } | { code: "regex"; why: string };
}

/** A refusal in words, for the tool; the web says the same through its error bundle. */
export function problemText(problem: NonNullable<SearchResult["problem"]>): string {
  return problem.code === "empty" ? "Say what to look for: words, or a regular expression." : `That is not a regular expression: ${problem.why}`;
}

interface FileRow {
  id: number;
  path: string;
  ino: number;
  offset: number;
  entries: number;
  edge: Uint8Array;
}

/** One transcript file of one context version, as the registry names it. */
interface Source {
  agentId: string;
  conversation: string;
  epoch: number;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface TranscriptIndexOptions {
  /** Values that must not be stored or shown (audit-export.ts heldValues). */
  held?: () => ReadonlyMap<string, string>;
  now?: () => number;
  chunkBytes?: number;
}

export class TranscriptIndex {
  private db: DatabaseSync;
  private readonly held: () => ReadonlyMap<string, string>;
  private readonly now: () => number;
  private readonly chunkBytes: number;
  private statements = new Map<string, StatementSync>();

  constructor(readonly path: string, options: TranscriptIndexOptions = {}) {
    this.held = options.held ?? (() => new Map());
    this.now = options.now ?? Date.now;
    this.chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
    this.db = this.open();
  }

  /** Opens the file if it is this version's index, else deletes it and starts again. */
  private open(): DatabaseSync {
    if (existsSync(this.path)) {
      try {
        const db = new DatabaseSync(this.path);
        const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
        if (row?.value === String(TRANSCRIPT_INDEX_VERSION)) return db;
        db.close();
      } catch {
        // Unreadable or not ours: rebuilt below, like a missing one.
      }
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.path}${suffix}`, { force: true });
    }
    const db = new DatabaseSync(this.path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, conversation TEXT NOT NULL, epoch INTEGER NOT NULL, path TEXT NOT NULL,
        ino INTEGER NOT NULL, offset INTEGER NOT NULL, entries INTEGER NOT NULL, edge BLOB NOT NULL, size INTEGER NOT NULL DEFAULT -1, UNIQUE (agent, conversation, epoch));
      CREATE TABLE docs (id INTEGER PRIMARY KEY, file INTEGER NOT NULL, agent TEXT NOT NULL, conversation TEXT NOT NULL, epoch INTEGER NOT NULL,
        idx INTEGER NOT NULL, at TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, turn TEXT, text TEXT NOT NULL);
      CREATE INDEX docs_file ON docs (file);
      CREATE INDEX docs_at ON docs (at);
      CREATE VIRTUAL TABLE docs_fts USING fts5 (text, content = 'docs', content_rowid = 'id', tokenize = 'trigram');
      CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN INSERT INTO docs_fts (rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN INSERT INTO docs_fts (docs_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
    `);
    db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(TRANSCRIPT_INDEX_VERSION));
    return db;
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (statement === undefined) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  /** True once closed; the next `transcriptIndexFor` opens the file again. */
  closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  /**
   * Reads what was written since the last pass, newest files first, until `deadline`. Returns how
   * many files are still behind; 0 means the index holds every whole line on disk.
   */
  refresh(registry: AgentRegistry, deadline: number): number {
    const sources = sourcesOf(registry).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const seen = new Map((this.sql("SELECT agent, conversation, epoch, path, size FROM files").all() as { agent: string; conversation: string; epoch: number; path: string; size: number }[])
      .map(row => [`${row.agent}\n${row.conversation}\n${row.epoch}`, row]));
    let behind = 0;
    for (const source of sources) {
      const row = seen.get(`${source.agentId}\n${source.conversation}\n${source.epoch}`);
      if (row !== undefined && row.path === source.path && row.size === source.size) continue; // nothing written since
      if (this.now() >= deadline || !this.catchUp(source, deadline)) behind += 1;
    }
    if (behind === 0) this.forgetMissing(sources);
    return behind;
  }

  /** One file, from where it was left; false when the deadline stopped it first. */
  private catchUp(source: Source, deadline: number): boolean {
    let fd: number;
    try { fd = openSync(source.path, "r"); } catch { return true; }
    try {
      const stat = fstatSync(fd);
      let row = this.sql("SELECT id, path, ino, offset, entries, edge FROM files WHERE agent = ? AND conversation = ? AND epoch = ?")
        .get(source.agentId, source.conversation, source.epoch) as FileRow | undefined;
      const appended = row !== undefined && row.path === source.path && row.ino === stat.ino && stat.size >= row.offset && sameEdge(fd, row);
      if (row !== undefined && !appended) {
        // Rewritten, moved into a context version, or replaced: read again whole.
        this.sql("DELETE FROM docs WHERE file = ?").run(row.id);
        this.sql("DELETE FROM files WHERE id = ?").run(row.id);
        row = undefined;
      }
      if (row === undefined) {
        const made = this.sql("INSERT INTO files (agent, conversation, epoch, path, ino, offset, entries, edge) VALUES (?, ?, ?, ?, ?, 0, 0, ?)")
          .run(source.agentId, source.conversation, source.epoch, source.path, stat.ino, new Uint8Array());
        row = { id: Number(made.lastInsertRowid), path: source.path, ino: stat.ino, offset: 0, entries: 0, edge: new Uint8Array() };
      }
      while (row.offset < stat.size) {
        if (this.now() >= deadline) return false;
        const bytes = readRange(fd, row.offset, Math.min(stat.size, row.offset + this.chunkBytes));
        let end = bytes.lastIndexOf(0x0a) + 1;
        if (end === 0) {
          // One line longer than a chunk: read to its end, or stop at a line still being written.
          const rest = readRange(fd, row.offset, stat.size);
          end = rest.lastIndexOf(0x0a) + 1;
          if (end === 0) break;
          this.ingest(source, row, rest.subarray(0, rest.indexOf(0x0a) + 1), fd);
          continue;
        }
        this.ingest(source, row, bytes.subarray(0, end), fd);
      }
      // Caught up with every whole line; a torn last line is left for when it is finished.
      this.sql("UPDATE files SET size = ? WHERE id = ?").run(stat.size, row.id);
      return true;
    } finally {
      closeSync(fd);
    }
  }

  /** Whole lines, in one transaction with the offset they bring the file to. */
  private ingest(source: Source, row: FileRow, lines: Buffer, fd: number): void {
    const held = this.held();
    const insert = this.sql("INSERT INTO docs (file, agent, conversation, epoch, idx, at, role, kind, turn, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const counted = row.entries;
    this.db.exec("BEGIN");
    try {
      for (let start = 0; start < lines.length; ) {
        const newline = lines.indexOf(0x0a, start);
        const stop = newline === -1 ? lines.length : newline;
        const line = lines.toString("utf8", start, stop);
        start = stop + 1;
        if (line.trim() === "") continue;
        let entry: unknown;
        // A torn or foreign line is not an entry, and is not counted, as the transcript reader skips it.
        try { entry = JSON.parse(line); } catch { continue; }
        const index = row.entries++;
        const at = typeof (entry as { at?: unknown })?.at === "string" ? (entry as { at: string }).at : "";
        const turn = typeof (entry as { turnId?: unknown })?.turnId === "string" ? (entry as { turnId: string }).turnId : null;
        for (const piece of piecesOf(entry)) {
          const text = redactLine(piece.text.slice(0, piece.kind === "call" || piece.kind === "result" ? MATERIAL_CHARS : PIECE_CHARS), held).text;
          insert.run(row.id, source.agentId, source.conversation, source.epoch, index, at, piece.role, piece.kind, turn, text);
        }
      }
      row.offset += lines.length;
      row.edge = readRange(fd, Math.max(0, row.offset - EDGE), row.offset);
      this.sql("UPDATE files SET offset = ?, entries = ?, edge = ? WHERE id = ?").run(row.offset, row.entries, row.edge, row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      row.entries = counted;
      throw error;
    }
  }

  /** After a full pass: what is no longer on disk (an agent removed, a conversation gone) leaves the index. */
  private forgetMissing(sources: readonly Source[]): void {
    const live = new Set(sources.map(source => `${source.agentId}\n${source.conversation}\n${source.epoch}`));
    const rows = this.sql("SELECT id, agent, conversation, epoch FROM files").all() as { id: number; agent: string; conversation: string; epoch: number }[];
    for (const row of rows) {
      if (live.has(`${row.agent}\n${row.conversation}\n${row.epoch}`)) continue;
      this.sql("DELETE FROM docs WHERE file = ?").run(row.id);
      this.sql("DELETE FROM files WHERE id = ?").run(row.id);
    }
  }

  /**
   * Catches up within part of the budget, then searches in what is left of it. `readable` is the
   * reader's box membership: nothing of an agent it may not read is looked at.
   */
  search(registry: AgentRegistry, readable: (agentId: string) => boolean, query: SearchQuery): SearchResult {
    const started = this.now();
    const budget = Math.max(1, query.budgetMs ?? DEFAULT_BUDGET_MS);
    const limit = Math.max(1, Math.min(MAX_HITS, Math.floor(query.limit ?? DEFAULT_HITS)));
    const words = (query.words ?? "").toLowerCase().split(/\s+/).filter(word => word !== "");
    let pattern: RegExp | undefined;
    if (query.regex !== undefined && query.regex !== "") {
      try { pattern = new RegExp(query.regex, "i"); } catch (error) { return { hits: [], more: false, problem: { code: "regex", why: (error as Error).message } }; }
    }
    if (words.length === 0 && pattern === undefined) return { hits: [], more: false, problem: { code: "empty" } };

    const names = new Map(registry.list().filter(agent => readable(agent.id)).map(agent => [agent.id, agent.profile.name]));
    const agents = [...names.keys()].filter(id => query.agents === undefined || query.agents.includes(id));
    const incomplete: { behind?: number; reached?: string } = {};
    const behind = this.refresh(registry, started + budget * 0.6);
    if (behind > 0) incomplete.behind = behind;
    if (agents.length === 0) return { hits: [], more: false, ...(behind > 0 ? { incomplete } : {}) };

    const kinds = query.kinds !== undefined && query.kinds.length > 0 ? query.kinds : HIT_KINDS.filter(kind => !INJECTED_KINDS.has(kind));
    const where = ["d.agent IN (SELECT value FROM json_each(?))", "d.kind IN (SELECT value FROM json_each(?))"];
    const args: (string | number)[] = [JSON.stringify(agents), JSON.stringify(kinds)];
    if (query.since !== undefined) { where.push("d.at >= ?"); args.push(query.since.toISOString()); }
    if (query.conversation !== undefined) { where.push("d.conversation = ?"); args.push(query.conversation); }
    if ((query.exclude ?? []).length > 0) { where.push("(d.agent || '/' || d.conversation) NOT IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(query.exclude)); }
    const long = words.filter(word => [...word].length >= 3);
    const short = words.filter(word => [...word].length < 3);
    const columns = "d.agent, d.conversation, d.epoch, d.idx, d.at, d.role, d.kind, d.turn, d.text";
    const deadline = started + budget;
    const rows: DocRow[] = [];
    let more = false;

    if (pattern === undefined && long.length > 0) {
      // The trigram index finds every word of three or more characters; shorter ones are checked on what it found.
      const match = long.map(word => `"${word.replaceAll('"', '""')}"`).join(" AND ");
      for (const word of short) { where.push("d.text LIKE ? ESCAPE '\\'"); args.push(`%${word.replace(/[\\%_]/g, char => `\\${char}`)}%`); }
      const found = this.db.prepare(`SELECT ${columns} FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE docs_fts MATCH ? AND ${where.join(" AND ")} ORDER BY d.at DESC, d.idx DESC LIMIT ?`)
        .all(match, ...args, limit + 1) as unknown as DocRow[];
      more = found.length > limit;
      rows.push(...found.slice(0, limit));
    } else {
      // A regular expression, or only words too short for the index: read newest first, within the budget.
      const test = pattern !== undefined ? (text: string) => pattern.test(text) : (text: string) => { const lower = text.toLowerCase(); return words.every(word => lower.includes(word)); };
      let seen = 0;
      let reached = "";
      for (const row of this.db.prepare(`SELECT ${columns} FROM docs d WHERE ${where.join(" AND ")} ORDER BY d.at DESC, d.idx DESC`).iterate(...args) as Iterable<DocRow>) {
        if ((++seen & 63) === 0 && this.now() >= deadline) {
          incomplete.reached = reached;
          break;
        }
        reached = row.at;
        if (!test(row.text)) continue;
        if (rows.length === limit) { more = true; break; }
        rows.push(row);
      }
    }

    const versions = this.versionsOf();
    const held = this.held();
    const hits = rows.map(row => {
      const multi = (versions.get(`${row.agent}\n${row.conversation}`) ?? 0) > 0;
      return {
        agentId: row.agent, agent: names.get(row.agent) ?? row.agent, conversation: row.conversation, epoch: row.epoch,
        anchor: anchorOf(row.idx, multi ? row.epoch : undefined), index: row.idx, at: row.at, role: row.role, kind: row.kind,
        snippet: redactLine(snippetOf(row.text, words, pattern), held).text, ...(row.turn !== null ? { turnId: row.turn } : {}),
      };
    });
    return { hits, more, ...(Object.keys(incomplete).length > 0 ? { incomplete } : {}) };
  }

  /** The newest context version of each indexed conversation: above 0, its anchors name their version. */
  private versionsOf(): Map<string, number> {
    const rows = this.sql("SELECT agent, conversation, MAX(epoch) AS epoch FROM files GROUP BY agent, conversation").all() as { agent: string; conversation: string; epoch: number }[];
    return new Map(rows.map(row => [`${row.agent}\n${row.conversation}`, row.epoch]));
  }

  /** Bytes on disk, for the estimate a person is shown and the tests. */
  size(): number {
    return ["", "-wal"].reduce((sum, suffix) => sum + (existsSync(`${this.path}${suffix}`) ? statSync(`${this.path}${suffix}`).size : 0), 0);
  }
}

interface DocRow {
  agent: string;
  conversation: string;
  epoch: number;
  idx: number;
  at: string;
  role: HitRole;
  kind: HitKind;
  turn: string | null;
  text: string;
}

/**
 * Every transcript file of every agent, each context version apart: every conversation, including
 * the audit and peer ones the conversation picker leaves out, but not a work thread
 * (`work-<hash>`): that is a projection of entries whose canonical copy is in the conversation the
 * work came from (work-attention.ts), and indexing both would answer every search twice.
 */
const WORK_PROJECTION = /^work-[a-f0-9]{32}$/;

function sourcesOf(registry: AgentRegistry): Source[] {
  const sources: Source[] = [];
  for (const agent of registry.list()) {
    const ids = new Set([MAIN_CONVERSATION]);
    try {
      for (const entry of readdirSync(join(registry.dirFor(agent.id), CONVERSATIONS_DIRNAME), { withFileTypes: true })) {
        if (entry.name.endsWith(".heard.jsonl")) continue;
        if (entry.isFile() && entry.name.endsWith(".jsonl")) ids.add(entry.name.slice(0, -".jsonl".length));
        else if (entry.isDirectory() && entry.name.endsWith(".jsonl.epochs")) ids.add(entry.name.slice(0, -".jsonl.epochs".length));
      }
    } catch {
      // No other conversations yet.
    }
    for (const id of ids) if (WORK_PROJECTION.test(id)) ids.delete(id);
    for (const conversation of ids) {
      try {
        const store = registry.contextStore(agent.id, conversation);
        for (const epoch of store.versions()) {
          const path = store.path("transcript", epoch);
          if (!existsSync(path)) continue;
          const stat = statSync(path);
          sources.push({ agentId: agent.id, conversation, epoch, path, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // A context state the registry refuses is not read here either.
      }
    }
  }
  return sources;
}

function sameEdge(fd: number, row: FileRow): boolean {
  const edge = Buffer.from(row.edge);
  if (edge.length === 0) return row.offset === 0;
  return readRange(fd, row.offset - edge.length, row.offset).equals(edge);
}

function readRange(fd: number, from: number, to: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, to - from));
  let read = 0;
  while (read < buffer.length) {
    const bytes = readSync(fd, buffer, read, buffer.length - read, from + read);
    if (bytes === 0) break;
    read += bytes;
  }
  return buffer.subarray(0, read);
}

/** The text around the first match, on one line. */
export function snippetOf(text: string, words: readonly string[], pattern?: RegExp): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const found = pattern !== undefined ? flat.search(pattern) : Math.min(...words.map(word => { const at = lower.indexOf(word); return at === -1 ? Number.POSITIVE_INFINITY : at; }));
  const at = Number.isFinite(found) && found >= 0 ? found : 0;
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

const open = new Map<string, TranscriptIndex>();

/** The installation's one index, opened once per process. */
export function transcriptIndexFor(registry: AgentRegistry, options: TranscriptIndexOptions = {}): TranscriptIndex {
  const path = join(registry.root, TRANSCRIPT_INDEX_FILENAME);
  let index = open.get(path);
  if (index === undefined || index.closed || !existsSync(path)) {
    index?.close();
    index = new TranscriptIndex(path, options);
    open.set(path, index);
  }
  return index;
}

/** `3d`, `12h`, `2w`, or an ISO date or time; undefined for anything else. */
export function parseSince(text: string, now: Date = new Date()): Date | undefined {
  const relative = /^\s*(\d+(?:\.\d+)?)\s*(h|d|w)\s*$/i.exec(text);
  if (relative !== null) return new Date(now.getTime() - Number(relative[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2]!.toLowerCase() as "h" | "d" | "w"]);
  if (/^\d{4}-\d{2}-\d{2}/.test(text.trim()) && !Number.isNaN(Date.parse(text))) return new Date(Date.parse(text));
  return undefined;
}
