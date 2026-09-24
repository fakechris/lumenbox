/**
 * One day, gathered into something you can hand to somebody.
 *
 * The ask this serves is from 2026-09-19 and is two sentences long: take everything a
 * person said and everything the agent researched in a day, keep all of it, and write one
 * synthesis across it rather than a list of what happened. This module is the first half.
 * It produces no prose at all — it assembles the material the second half reads.
 *
 * It was going to be three days of work. It is not, any more, because the material is
 * already on disk: messages whole at the door (INV-613), turns that archive instead of
 * emptying (INV-634), every page read with its completeness and provenance (INV-629,
 * INV-632), every over-long tool result (INV-633), the edge from a turn to what it read
 * (INV-665), and a digest in every pointer so an expired artefact still describes itself
 * (INV-659). Assembly, not collection.
 *
 * **The thing that makes this honest is `gaps`.** A day assembled from a host that was
 * running an older build is missing whole categories of material, and it looks exactly
 * like a quiet day. Measured on this installation on 2026-09-23: the host was 43 commits
 * behind, so `results/` was empty and no turn carried its evidence — a package built then
 * would have been thin and said nothing about why. So every degradation is named, with
 * the reason, and a reader who sees an empty section can tell "nothing happened" from "we
 * could not know".
 *
 * Read-only, over every ledger. Re-runnable: the same day twice is the same bytes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../../config.ts";
import { redactLine } from "../audit-export.ts";
import { fetchedDir, readFrontmatter } from "../fetched.ts";
import { resultsDir } from "../results.ts";
import { archivedLines } from "../jsonl.ts";

export const DIGEST_DIRNAME = "digest";
/** Written last. Its absence is the only reliable sign a package is unfinished. */
export const READY_FILENAME = "READY";

export interface DayWindow {
  /** `YYYY-MM-DD`, in the operator's local time. */
  date: string;
  from: string;
  to: string;
  /** Minutes east of UTC at the time, so a reader can reproduce the boundary. */
  offsetMinutes: number;
}

/** Where a fact came from, because the two are not equally complete. */
export type FactSource = "ledger" | "transcript";

export interface PackagedMessage {
  id: string;
  channel?: string;
  chatKey?: string;
  senderLabel?: string;
  identity?: string;
  conversationKey?: string;
  at: string;
  /** Whole, as sent. The inbox clamps its copy; this is not that copy. */
  text: string;
  chars: number;
  files?: { name: string; bytes: number }[];
  source: FactSource;
}

export interface PackagedTurn {
  id: string;
  at: string;
  agentId?: string;
  about?: string;
  model?: string;
  build?: { version: string; commit: string };
  conversation?: string;
  endedAt?: string;
  how?: string;
  category?: string;
  /** Paths this turn said it read, as its own record has them. */
  read?: string[];
}

export interface PackagedSource {
  /** `sha8` of the body, which is also its file name in the package. */
  key: string;
  url?: string;
  finalUrl?: string;
  title?: string;
  fetchedAt?: string;
  contentType?: string;
  completeness?: string;
  chars?: number;
  bytes?: number;
  sha256?: string;
  fetcher?: string;
  turnId?: string;
  agent?: string;
  /** `kept` means the body travelled with the package; `expired` means only this row did. */
  state: "kept" | "expired";
}

export interface Gap {
  /** What is thin. */
  what: "messages" | "turns" | "sources" | "results" | "replies" | "evidence";
  /** Why, in a sentence a person can act on. */
  why: string;
}

export interface DayManifest {
  schema: "lumenbox.day-package/v1";
  runKey: string;
  window: DayWindow;
  chatKey?: string;
  messages: PackagedMessage[];
  turns: PackagedTurn[];
  sources: PackagedSource[];
  replies: { turnId: string; at: string; chars: number; path: string }[];
  /** Everything this package could not know, and why. Empty means nothing was degraded. */
  gaps: Gap[];
  redactions: { exact: number; pattern: number };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The local day, as a half-open interval.
 *
 * Local and not UTC because the person asking for "today" means the day they lived
 * through. The offset is recorded so the boundary can be reproduced later from a machine
 * in another zone, which is the part a bare pair of timestamps loses.
 */
export function dayWindow(date: string, now = new Date()): DayWindow {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not a date: ${date}. Use YYYY-MM-DD.`);
  }
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  void now;
  return {
    date,
    from: start.toISOString(),
    to: end.toISOString(),
    offsetMinutes: -start.getTimezoneOffset(),
  };
}

function within(at: string | undefined, window: DayWindow): boolean {
  if (at === undefined) return false;
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= Date.parse(window.from) && time < Date.parse(window.to);
}

function linesOf(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== "");
  } catch {
    return [];
  }
}

/** A ledger's live file plus its archives, since a `record` moves rather than drops (INV-634). */
function recordLines(path: string): string[] {
  return [...archivedLines(path), ...linesOf(path)];
}

function parsed<T>(lines: readonly string[]): T[] {
  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line from a crash mid-write hides only itself, as everywhere else here.
    }
  }
  return out;
}

interface MessageRow {
  id?: string;
  channel?: string;
  chatKey?: string;
  identity?: string;
  senderLabel?: string;
  conversationKey?: string;
  receivedAt?: string;
  text?: string;
  files?: { name: string; bytes: number }[];
}

interface TurnRow {
  id?: string;
  event?: string;
  at?: string;
  agentId?: string;
  about?: string;
  model?: string;
  build?: { version: string; commit: string };
  conversation?: string;
  how?: string;
  category?: string;
  evidence?: { path: string; sha256: string; chars: number; at: string }[];
}

/**
 * Messages, preferring the ledger that keeps them whole.
 *
 * `messages.jsonl` holds the text as sent; a transcript holds whatever the turn's prompt
 * held, which may be several messages joined and cut at eight thousand characters. Both
 * are read because the ledger only goes back as far as its own deployment, and a day
 * before that has a transcript and nothing else.
 */
function gatherMessages(
  home: string,
  window: DayWindow,
  chatKey: string | undefined,
  agentDirs: readonly string[]
): { messages: PackagedMessage[]; fromTranscript: number } {
  const messages: PackagedMessage[] = [];
  const seen = new Set<string>();

  for (const row of parsed<MessageRow>(linesOf(join(home, "messages.jsonl")))) {
    if (row.id === undefined || !within(row.receivedAt, window)) continue;
    if (chatKey !== undefined && row.chatKey !== chatKey && row.conversationKey !== chatKey) continue;
    seen.add(row.id);
    messages.push({
      id: row.id,
      ...(row.channel !== undefined ? { channel: row.channel } : {}),
      ...(row.chatKey !== undefined ? { chatKey: row.chatKey } : {}),
      ...(row.senderLabel !== undefined ? { senderLabel: row.senderLabel } : {}),
      ...(row.identity !== undefined ? { identity: row.identity } : {}),
      ...(row.conversationKey !== undefined ? { conversationKey: row.conversationKey } : {}),
      at: row.receivedAt!,
      text: row.text ?? "",
      chars: (row.text ?? "").length,
      ...(row.files !== undefined && row.files.length > 0 ? { files: row.files } : {}),
      source: "ledger",
    });
  }

  // What a person said on a day the ledger does not cover. The transcript's plain user
  // entries are the same words, joined and possibly cut, which is worse and is not nothing.
  let fromTranscript = 0;
  for (const dir of agentDirs) {
    for (const entry of transcriptEntries(dir)) {
      if (entry.role !== "user" || entry.kind !== undefined || typeof entry.text !== "string") continue;
      if (!within(entry.at, window)) continue;
      const causedBy = Array.isArray(entry.causedBy) ? (entry.causedBy as string[]) : [];
      if (causedBy.some(id => seen.has(id))) continue;
      const id = causedBy[0] ?? `transcript:${sha256(`${entry.at}${entry.text}`).slice(0, 12)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      fromTranscript += 1;
      messages.push({
        id,
        at: entry.at as string,
        text: entry.text,
        chars: entry.text.length,
        source: "transcript",
      });
    }
  }

  messages.sort((a, b) => a.at.localeCompare(b.at));
  return { messages, fromTranscript };
}

interface TranscriptRow {
  role?: string;
  kind?: string;
  text?: string;
  at?: string;
  turnId?: string;
  causedBy?: unknown;
}

function transcriptEntries(agentDir: string): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  for (const path of transcriptPaths(agentDir)) out.push(...parsed<TranscriptRow>(linesOf(path)));
  return out;
}

function transcriptPaths(agentDir: string): string[] {
  const paths: string[] = [];
  const main = join(agentDir, "conversation.jsonl");
  if (existsSync(main)) paths.push(main);
  const rooms = join(agentDir, "conversations");
  try {
    for (const name of readdirSync(rooms)) {
      // `.heard.jsonl` is what a room overheard, not what this agent did.
      if (name.endsWith(".jsonl") && !name.endsWith(".heard.jsonl")) paths.push(join(rooms, name));
    }
  } catch {
    // An agent with no side conversations.
  }
  return paths;
}

function agentDirectories(home: string): string[] {
  const root = join(home, "agents");
  try {
    return readdirSync(root)
      .map(name => join(root, name))
      .filter(dir => existsSync(join(dir, "conversation.jsonl")) || existsSync(join(dir, "conversations")));
  } catch {
    return [];
  }
}

/** Turns, joined from their begin and end rows. */
function gatherTurns(home: string, window: DayWindow, chatKey: string | undefined): PackagedTurn[] {
  const rows = parsed<TurnRow>(recordLines(join(home, "turns.jsonl")));
  const byId = new Map<string, PackagedTurn>();
  for (const row of rows) {
    if (row.id === undefined) continue;
    if (row.event === "begin") {
      if (!within(row.at, window)) continue;
      if (chatKey !== undefined && row.conversation !== undefined && !row.conversation.includes(chatKey)) continue;
      byId.set(row.id, {
        id: row.id,
        at: row.at!,
        ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
        ...(row.about !== undefined ? { about: row.about } : {}),
        ...(row.model !== undefined ? { model: row.model } : {}),
        ...(row.build !== undefined ? { build: row.build } : {}),
        ...(row.conversation !== undefined ? { conversation: row.conversation } : {}),
      });
    } else if (row.event === "end") {
      const turn = byId.get(row.id);
      if (turn === undefined) continue;
      turn.endedAt = row.at;
      if (row.how !== undefined) turn.how = row.how;
      if (row.category !== undefined) turn.category = row.category;
      if (row.evidence !== undefined && row.evidence.length > 0) {
        turn.read = row.evidence.map(one => one.path);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Every kept artefact whose own frontmatter puts it inside the window, with its body. */
function gatherSources(
  home: string,
  window: DayWindow,
  turnIds: ReadonlySet<string>
): { sources: PackagedSource[]; bodies: Map<string, string> } {
  const found: PackagedSource[] = [];
  const bodies = new Map<string, string>();
  const walk = (dir: string, extension: string, timeKey: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).map(one => one.name);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let text: string;
      try {
        if (!name.endsWith(extension)) {
          walk(path, extension, timeKey);
          continue;
        }
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const head = readFrontmatter(text);
      const at = head[timeKey];
      // A turn of this day counts even when the artefact's own clock says otherwise: a
      // fetch at 23:59 read for a turn that began at 23:58 belongs to that turn's day.
      const ours = within(at, window) || (head.turn_id !== undefined && turnIds.has(head.turn_id));
      if (!ours) continue;
      const end = text.indexOf("\n---\n", 4);
      const body = end === -1 ? "" : text.slice(end + 5).replace(/\n$/, "");
      const digest = head.sha256 ?? sha256(body);
      found.push({
        key: digest.slice(0, 8),
        ...(head.url !== undefined ? { url: head.url } : {}),
        ...(head.final_url !== undefined ? { finalUrl: head.final_url } : {}),
        ...(head.title !== undefined ? { title: head.title } : {}),
        ...(at !== undefined ? { fetchedAt: at } : {}),
        ...(head.content_type !== undefined ? { contentType: head.content_type } : {}),
        ...(head.completeness !== undefined ? { completeness: head.completeness } : {}),
        ...(head.text_chars !== undefined ? { chars: Number(head.text_chars) } : {}),
        ...(head.bytes !== undefined ? { bytes: Number(head.bytes) } : {}),
        sha256: digest,
        ...(head.fetcher !== undefined ? { fetcher: head.fetcher } : {}),
        ...(head.turn_id !== undefined ? { turnId: head.turn_id } : {}),
        ...(head.agent !== undefined ? { agent: head.agent } : {}),
        state: "kept",
      });
      bodies.set(digest.slice(0, 8), body);
    }
  };
  walk(fetchedDir(home), ".md", "fetched_at");
  walk(resultsDir(home), ".txt", "at");
  // One row per distinct body: the same page fetched twice in a day is one source.
  const byKey = new Map<string, PackagedSource>();
  for (const one of found) if (!byKey.has(one.key)) byKey.set(one.key, one);
  return {
    sources: [...byKey.values()].sort((a, b) => (a.fetchedAt ?? "").localeCompare(b.fetchedAt ?? "")),
    bodies,
  };
}

/**
 * A turn's final reply, from the transcript.
 *
 * The transcript is the only place it is: the reply goes to a person over a channel and is
 * filed as a plain assistant entry. Matched by `turnId`, which every entry has carried
 * since INV-613 — before that, nothing can join them and the gap says so.
 */
function gatherReplies(
  agentDirs: readonly string[],
  window: DayWindow,
  turnIds: ReadonlySet<string>
): { turnId: string; at: string; text: string }[] {
  const out: { turnId: string; at: string; text: string }[] = [];
  for (const dir of agentDirs) {
    for (const entry of transcriptEntries(dir)) {
      if (entry.role !== "assistant" || entry.kind !== undefined) continue;
      if (typeof entry.text !== "string" || entry.text.trim() === "") continue;
      if (entry.turnId === undefined || !turnIds.has(entry.turnId)) continue;
      if (!within(entry.at, window)) continue;
      out.push({ turnId: entry.turnId, at: entry.at!, text: entry.text });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface AssembleOptions {
  home?: string;
  chatKey?: string;
  /** Held vault values to redact, as the audit export takes them. */
  held?: ReadonlyMap<string, string>;
  now?: Date;
}

export interface AssembledDay {
  manifest: DayManifest;
  /** Where it was written. */
  dir: string;
}

/**
 * Assembles one day and writes the package.
 *
 * Deterministic for a given day and a given set of ledgers: run it twice and every file is
 * the same except `generatedAt`. That matters because a package is evidence, and evidence
 * that changes when you look at it again is not evidence.
 */
export function assembleDay(date: string, options: AssembleOptions = {}): AssembledDay {
  const home = options.home ?? agentboxHome();
  const window = dayWindow(date);
  const held = options.held ?? new Map<string, string>();
  const agentDirs = agentDirectories(home);

  const { messages, fromTranscript } = gatherMessages(home, window, options.chatKey, agentDirs);
  const turns = gatherTurns(home, window, options.chatKey);
  const turnIds = new Set(turns.map(one => one.id));
  const { sources, bodies } = gatherSources(home, window, turnIds);
  const replies = gatherReplies(agentDirs, window, turnIds);

  const redactions = { exact: 0, pattern: 0 };
  const redact = (text: string): string =>
    text
      .split("\n")
      .map(line => {
        const done = redactLine(line, held);
        redactions.exact += done.exact;
        redactions.pattern += done.pattern;
        return done.text;
      })
      .join("\n");

  for (const message of messages) message.text = redact(message.text);

  // Every degradation, named. A thin section that says nothing about why is the failure
  // this field exists to prevent.
  const gaps: Gap[] = [];
  if (fromTranscript > 0) {
    gaps.push({
      what: "messages",
      why:
        `${fromTranscript} message(s) came from the transcript rather than messages.jsonl, so the ` +
        "text is the turn's prompt: several messages may be joined and the whole is cut at 8,000 " +
        "characters. The ledger only covers days after INV-613 was deployed.",
    });
  }
  const buildsSeen = new Set(turns.map(one => one.build?.commit).filter((one): one is string => one !== undefined));
  if (turns.length > 0 && turns.every(one => one.read === undefined)) {
    gaps.push({
      what: "evidence",
      why:
        "No turn recorded what it read, so sources are matched by their own timestamps and by " +
        "turn_id alone. The host on this day ran a build before INV-665" +
        (buildsSeen.size > 0 ? ` (saw ${[...buildsSeen].join(", ")})` : "") +
        ".",
    });
  }
  if (!existsSync(resultsDir(home))) {
    gaps.push({
      what: "results",
      why:
        "No kept tool results exist at all, so anything a tool returned over 2,000 characters is " +
        "only in the transcript as its first 2,000. The host ran a build before INV-633.",
    });
  }
  if (turns.length > 0 && replies.length === 0) {
    gaps.push({
      what: "replies",
      why:
        "No reply could be joined to a turn. Replies are matched by turnId, which transcript " +
        "entries have carried only since INV-613.",
    });
  }
  for (const source of sources) {
    if (bodies.get(source.key) === undefined) source.state = "expired";
  }

  const runKey = `${date}-${sha256(`${date}|${options.chatKey ?? ""}`).slice(0, 6)}`;
  const dir = join(home, DIGEST_DIRNAME, runKey, "package");
  mkdirSync(dir, { recursive: true });

  const manifest: DayManifest = {
    schema: "lumenbox.day-package/v1",
    runKey,
    window,
    ...(options.chatKey !== undefined ? { chatKey: options.chatKey } : {}),
    messages,
    turns,
    sources,
    replies: replies.map(one => ({
      turnId: one.turnId,
      at: one.at,
      chars: one.text.length,
      path: `turns/${one.turnId}/reply.md`,
    })),
    gaps,
    redactions,
  };

  const written: string[] = [];
  const write = (relative: string, body: string): void => {
    const path = join(dir, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    written.push(`${sha256(body)}  ${relative}`);
  };

  for (const source of sources) {
    const body = bodies.get(source.key);
    if (body === undefined) continue;
    write(`sources/${source.key}.md`, `${redact(body)}\n`);
  }
  for (const reply of replies) write(`turns/${reply.turnId}/reply.md`, `${redact(reply.text)}\n`);

  // Written after the bodies, because its redaction counts include theirs.
  write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  // Last, always. Its absence is how an unfinished package is told from a thin day.
  //
  // The generation instant lives here and not in the manifest, so that every file the
  // manifest describes — and the manifest itself — is a pure function of the day's
  // material. Two runs over an unchanged day then produce identical hashes, which is what
  // makes "did anything about this day change" a question you can answer by comparing two
  // numbers. WACZ splits its datapackage from its digest for the same reason.
  writeFileSync(
    join(dir, READY_FILENAME),
    `# generated ${(options.now ?? new Date()).toISOString()}\n${written.sort().join("\n")}\n`,
    { mode: 0o600 }
  );

  return { manifest, dir };
}

/** Reads a package back and checks every file still hashes to what READY says. */
export function verifyPackage(dir: string): { verified: number; mismatched: string[]; missing: string[] } {
  const out = { verified: 0, mismatched: [] as string[], missing: [] as string[] };
  for (const line of linesOf(join(dir, READY_FILENAME))) {
    if (line.startsWith("#")) continue;
    const at = line.indexOf("  ");
    if (at === -1) continue;
    const expected = line.slice(0, at);
    const relative = line.slice(at + 2);
    let body: string;
    try {
      body = readFileSync(join(dir, relative), "utf8");
    } catch {
      out.missing.push(relative);
      continue;
    }
    if (sha256(body) === expected) out.verified += 1;
    else out.mismatched.push(relative);
  }
  return out;
}

/**
 * A package, in lines a person reads.
 *
 * Gaps go last and are never folded into a count, because a gap is the one thing here a
 * reader must not skim past: a thin day and a day we could not see look identical until
 * somebody says which it was.
 */
export function describeDay(manifest: DayManifest, dir: string): string[] {
  const lines = [
    `Day package ${manifest.window.date} (${manifest.runKey})`,
    `  ${dir}`,
    `  ${manifest.messages.length} message(s), ${manifest.turns.length} turn(s), ` +
      `${manifest.sources.length} source(s), ${manifest.replies.length} reply(ies)`,
  ];
  const fromTranscript = manifest.messages.filter(one => one.source === "transcript").length;
  if (fromTranscript > 0) lines.push(`  ${fromTranscript} message(s) reconstructed from the transcript`);
  const expired = manifest.sources.filter(one => one.state === "expired").length;
  if (expired > 0) lines.push(`  ${expired} source(s) already aged out; their digests travel, their bodies do not`);
  if (manifest.redactions.exact + manifest.redactions.pattern > 0) {
    lines.push(
      `  redacted: ${manifest.redactions.exact} held value(s), ${manifest.redactions.pattern} credential-shaped string(s)`
    );
  }
  if (manifest.gaps.length === 0) lines.push("  no gaps: everything this day produced is in the package");
  else {
    lines.push(`  ${manifest.gaps.length} gap(s) — this package is incomplete and here is why:`);
    for (const gap of manifest.gaps) lines.push(`    ${gap.what}: ${gap.why}`);
  }
  return lines;
}

/**
 * Finds the package for a day, by asking the packages rather than guessing at their names.
 *
 * A run key carries a hash of the day and the chat, so yesterday's key cannot be derived
 * from today's — and it should not be, because two chats can have two packages for the
 * same day. Reading the manifests is a directory listing and a handful of small files.
 */
export function findPackage(
  home: string,
  date: string,
  chatKey?: string
): { dir: string; manifest: DayManifest } | undefined {
  let runKeys: string[];
  try {
    runKeys = readdirSync(join(home, DIGEST_DIRNAME));
  } catch {
    return undefined;
  }
  for (const runKey of runKeys.sort()) {
    const dir = join(home, DIGEST_DIRNAME, runKey, "package");
    let manifest: DayManifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DayManifest;
    } catch {
      continue;
    }
    if (manifest.window?.date !== date) continue;
    if (chatKey !== undefined && manifest.chatKey !== chatKey) continue;
    return { dir, manifest };
  }
  return undefined;
}

/** The day before, as a date string. */
export function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const before = new Date(year!, month! - 1, day! - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${before.getFullYear()}-${pad(before.getMonth() + 1)}-${pad(before.getDate())}`;
}

/** Where a package lives inside the box, as docs/61 §6.2 named it. */
export const BOX_DIGEST_DIR = "/home/box/work/digest";

/**
 * Puts a package where the agent that reads it can actually reach it.
 *
 * The package is assembled on the host, under `~/.agentbox/digest/`. The skill that turns
 * it into a digest runs **inside the box**, which cannot see that path — the same boundary
 * `results.ts` is careful about, and the one this got wrong on the first pass: the skill
 * was shipped pointing at a host directory and was therefore unrunnable. docs/61 §6.2 had
 * said `/home/box/work/digest/` all along.
 *
 * Copied rather than mounted. A mount would give the box the whole evidence store,
 * including days and chats this run is not about, and the package exists precisely so that
 * a bounded, redacted, verifiable subset is what travels.
 */
export async function deliverPackageToBox(
  dir: string,
  runKey: string,
  box: {
    uploadFile: (path: string, base64: string) => Promise<unknown>;
    /** Optional so a test can supply only the upload; a real box needs the directories. */
    exec?: (command: string, options?: { timeoutMs?: number; actor?: string }) => Promise<unknown>;
  },
  log: (line: string) => void = () => {}
): Promise<{ delivered: number; failed: string[] }> {
  const out = { delivered: 0, failed: [] as string[] };
  const files: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files.push(`${prefix}${name}`);
    }
  };
  try {
    walk(dir, "");
  } catch {
    return out;
  }

  // READY last, for the same reason it is written last: its presence is the only reliable
  // sign a package is whole, and a half-delivered package that already claims to be ready
  // is worse than one that has not arrived.
  const ordered = [...files.filter(name => name !== READY_FILENAME), ...files.filter(name => name === READY_FILENAME)];

  // Upload writes a file and will not invent the directory above it. Making every
  // directory first is one call; discovering this per file, as the first real delivery
  // did, is a package that half arrives.
  const directories = [...new Set(ordered.map(relative => relative.split("/").slice(0, -1).join("/")))];
  if (box.exec !== undefined) {
    const targets = directories
      .map(one => `'${BOX_DIGEST_DIR}/${runKey}/package${one === "" ? "" : `/${one}`}'`)
      .join(" ");
    await box
      .exec(`mkdir -p ${targets}`, { timeoutMs: 15_000, actor: "host:day-package" })
      .catch((error: unknown) => {
        log(`  could not make the package directory: ${error instanceof Error ? error.message : error}`);
      });
  }

  for (const relative of ordered) {
    try {
      const body = readFileSync(join(dir, relative));
      await box.uploadFile(`${BOX_DIGEST_DIR}/${runKey}/package/${relative}`, body.toString("base64"));
      out.delivered += 1;
    } catch (error) {
      out.failed.push(relative);
      log(`  could not deliver ${relative}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return out;
}
