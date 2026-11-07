/**
 * "These are all me": folding an older roster's people into one Owner (INV-1698, docs/22 §1a).
 *
 * A desktop installation that let people in before INV-1685 has a roster with no `installation`
 * field, so it reads as an organisation — and often every person on it is the one person at the
 * keyboard. A Feishu app hands each person an open_id of its own, so the same human speaking to a
 * second bot app arrived as a new person; DingTalk and a browser did the same. This makes such a
 * roster the personal installation it always was: one Owner holding every identity.
 *
 * Nothing here decides that the people are one person. "They look alike" is not a reason to merge
 * (docs/48 §1: nothing uncertain merges), so:
 *
 * 1. **Preview** — read-only. Offered only on the desktop app, on a roster with no `installation`
 *    field, with 1 to `MAX_SELF` people. It lists each person's identities with their door and
 *    when each was last heard from, the facts that bear on "could these be me" (`hints`), and what
 *    the merge would change in every store that names a person — counted by running the same
 *    rewrite the merge runs, without writing, so the preview cannot disagree with the merge.
 * 2. **Confirm** — the person's explicit yes, carrying the preview's digest of the roster: a roster
 *    that changed since the preview is refused, never merged. The confirmation writes the journal
 *    (`principal-merge.json`, state `pending`) and nothing else.
 * 3. **Apply** — at the next start, before any store is loaded, so no cache in a running server
 *    can write an old id back. Every store is rewritten through one mapping (old id → `local:owner`),
 *    each file atomically; the roster last; then the journal says `done` with what changed. A crash
 *    part-way is resumed on the following start: the rewrite is idempotent, and the roster's
 *    `installation.merged.at` says whether the roster step already happened. The journal is the
 *    migration table and the audit record: who confirmed, when, the people as they were.
 *
 * The old ids are kept as the Owner's `aliases`, so a record that still names one — the logs kept
 * by decision below — finds the Owner through `Principals.byId`. Kept, by decision: logs whose
 * point is to say what happened as it happened (messages, ingress, receipts, audit trails, policy,
 * config history, transcripts), and records keyed by a sign-in identity rather than a person,
 * which still resolves to the Owner through the identity link.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { agentboxHome, configPath } from "../config.ts";
import { defaultAgentsRoot } from "../agents/registry.ts";
import { inboxPath } from "../agents/inbox.ts";
import { installationOf, OWNER_ID } from "./installation.ts";
import { principalsPath } from "./principals.ts";
import { turnLedgerPath } from "./resume.ts";
import { withRosterLock } from "./roster-lock.ts";
import { rulesDir } from "./rules.ts";
import { tasksPath } from "./tasks.ts";
import { usageLogPath } from "./usage.ts";
import { vaultPath } from "./vault.ts";

export const MERGE_JOURNAL = "principal-merge.json";
/** More people than this is a team, not one person with many apps: no offer. */
export const MAX_SELF = 12;

/** Where each store that names a person lives. One function, so the preview and the merge read the same files. */
export interface MergePaths {
  home: string;
  roster: string;
  agents: string;
  tasks: string;
  usage: string;
  vault: string;
  turns: string;
  inbox: string;
  config: string;
  rules: string;
}

export function mergePaths(): MergePaths {
  return {
    home: agentboxHome(), roster: principalsPath(), agents: defaultAgentsRoot(), tasks: tasksPath(), usage: usageLogPath(),
    vault: vaultPath(), turns: turnLedgerPath(), inbox: inboxPath(), config: configPath(), rules: rulesDir(),
  };
}

/** The stores the merge rewrites, by the name the preview shows (`ui.merge.store.<name>`). */
export const MERGED_STORES = [
  "mcp-tokens", "watchdog", "tasks", "spend", "memory", "person-notes", "box-members", "personal-boxes",
  "vault-grants", "rules", "box-quotas", "sessions", "turns", "inbox",
] as const;
export type MergedStore = (typeof MERGED_STORES)[number];

/** Kept as written, by decision (see the header): their old ids find the Owner through `aliases`. */
export const KEPT_STORES = [
  "messages.jsonl", "ingress.jsonl", "receipts.jsonl", "vault-audit.jsonl", "memory-audit.jsonl", "policy.jsonl",
  "config-versions.jsonl", "connect.json", "preferences.json", "transcripts",
] as const;

interface RawPrincipal { id: string; name: string; role: string; identities?: unknown[]; anchors?: unknown[]; aliases?: unknown[] }
interface RosterFile { principals?: RawPrincipal[]; bootstrap?: Record<string, unknown>; installation?: unknown }

export interface MergeIdentity {
  identity: string;
  /** The door that minted it: the identity's prefix (`feishu-work`), `web` for a browser. */
  door: string;
  /** The door's kind when it is a configured channel (`feishu`, `dingtalk`); absent for a browser or a door since removed. */
  doorType?: string;
  /** The last message admitted from it, ISO; absent when it never wrote through a door. */
  lastSeen?: string;
}

export interface MergePerson { id: string; name: string; role: string; identities: MergeIdentity[]; lastActive?: string }

/** A fact that bears on "could these all be me". Shown, never acted on. */
export type MergeHint =
  /** Several people share a display name. */
  | { kind: "same-name"; name: string; count: number }
  /** Several people came through one door. A door gives one person one id, unless its app was replaced — so say it plainly. */
  | { kind: "same-door"; door: string; count: number };

export type NotOffered = "server" | "decided" | "empty" | "too-many" | "pending";

export interface MergePreview {
  offered: boolean;
  /** Why not, when not offered. */
  reason?: NotOffered;
  /** The roster as previewed; a confirmation must carry it back. */
  digest: string;
  /** The Owner's name unless the person types another: the first admin's. */
  ownerName: string;
  people: MergePerson[];
  hints: MergeHint[];
  /** What the merge changes, store by store, counted by a dry run of the merge itself. */
  changes: { store: MergedStore; records: number }[];
  kept: readonly string[];
}

export interface MergeJournal {
  state: "pending" | "done" | "abandoned";
  requestedAt: number;
  /** Who confirmed: a name, or "the operator". */
  by: string;
  digest: string;
  name: string;
  /** The people as they were: the migration table's left-hand side, and what an undo would need. */
  from: RawPrincipal[];
  appliedAt?: number;
  changes?: Partial<Record<MergedStore, number>>;
  reason?: string;
}

function readRoster(path: string): RosterFile | undefined {
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, "utf8")) as RosterFile;
  if (!value || typeof value !== "object" || !Array.isArray(value.principals)) throw new Error("Repair the roster before merging");
  return value;
}

function digestOf(roster: RosterFile): string {
  return createHash("sha256").update(JSON.stringify({ principals: roster.principals ?? [], installation: roster.installation ?? null })).digest("hex").slice(0, 24);
}

function writeAtomically(path: string, content: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.merge-${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

const identityOf = (entry: unknown): string | undefined =>
  typeof entry === "string" ? entry.trim() || undefined
    : typeof entry === "object" && entry !== null && typeof (entry as { identity?: unknown }).identity === "string" ? (entry as { identity: string }).identity.trim() || undefined
      : undefined;

const doorOfIdentity = (identity: string) => identity.split(":")[0] ?? identity;

/** Old id → new id, and the `principal:<id>` grant holder form the vault uses. */
function mapId(map: ReadonlyMap<string, string>, value: string): string {
  const direct = map.get(value);
  if (direct !== undefined) return direct;
  if (value.startsWith("principal:")) {
    const mapped = map.get(value.slice("principal:".length));
    if (mapped !== undefined) return `principal:${mapped}`;
  }
  return value;
}

/** Rewrites, in place, every value under one of `keys` that names an old id: a string, or a list of them (deduplicated). Returns how many values changed. */
function remap(node: unknown, keys: ReadonlySet<string>, map: ReadonlyMap<string, string>): number {
  if (Array.isArray(node)) return node.reduce((sum: number, item) => sum + remap(item, keys, map), 0);
  if (node === null || typeof node !== "object") return 0;
  let changed = 0;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key) && typeof value === "string") {
      const next = mapId(map, value);
      if (next !== value) { record[key] = next; changed += 1; }
    } else if (keys.has(key) && Array.isArray(value) && value.every(item => typeof item === "string")) {
      const next = [...new Set((value as string[]).map(item => mapId(map, item)))];
      if (next.length !== value.length || next.some((item, i) => item !== value[i])) { record[key] = next; changed += 1; }
    } else changed += remap(value, keys, map);
  }
  return changed;
}

/** One JSON document. Counts the values changed. */
function rewriteJson(path: string, keys: readonly string[], map: ReadonlyMap<string, string>, write: boolean): number {
  if (!existsSync(path)) return 0;
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { return 0; }
  const changed = remap(doc, new Set(keys), map);
  if (changed > 0 && write) writeAtomically(path, `${JSON.stringify(doc, null, 2)}\n`);
  return changed;
}

/** An append log, line by line; a line that is not JSON is kept as it is. Counts the records changed — distinct by `recordKey` when given (a task is many snapshot lines). */
function rewriteJsonl(path: string, keys: readonly string[], map: ReadonlyMap<string, string>, write: boolean, recordKey?: (line: Record<string, unknown>) => string | undefined): number {
  if (!existsSync(path)) return 0;
  const wanted = new Set(keys);
  const touched = new Set<string>();
  let changedLines = 0;
  const lines = readFileSync(path, "utf8").split("\n").map((raw, index) => {
    if (raw.trim() === "") return raw;
    let line: Record<string, unknown>;
    try { line = JSON.parse(raw) as Record<string, unknown>; } catch { return raw; }
    if (remap(line, wanted, map) === 0) return raw;
    changedLines += 1;
    touched.add(recordKey?.(line) ?? `line:${index}`);
    return JSON.stringify(line);
  });
  if (changedLines > 0 && write) writeAtomically(path, lines.join("\n"));
  return touched.size;
}

const filesIn = (dir: string, suffix: string) => (existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(suffix)).map(name => join(dir, name)) : []);
const agentDirs = (root: string) => (existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)) : []);

/** A map keyed by person id: the old keys fold into the new one through `fold`. */
function rewriteKeyed(path: string, pick: (doc: Record<string, unknown>) => Record<string, unknown> | undefined, fold: (values: number[]) => number | undefined, map: ReadonlyMap<string, string>, write: boolean): number {
  if (!existsSync(path)) return 0;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return 0; }
  const table = pick(doc);
  if (table === undefined) return 0;
  const old = Object.keys(table).filter(key => map.has(key));
  if (old.length === 0) return 0;
  const byTarget = new Map<string, number[]>();
  for (const key of old) {
    const target = map.get(key)!;
    const values = byTarget.get(target) ?? (typeof table[target] === "number" ? [table[target] as number] : []);
    if (typeof table[key] === "number") values.push(table[key] as number);
    byTarget.set(target, values);
    delete table[key];
  }
  for (const [target, values] of byTarget) {
    const value = fold(values);
    if (value === undefined) delete table[target];
    else table[target] = value;
  }
  if (write) writeAtomically(path, `${JSON.stringify(doc, null, 2)}\n`);
  return old.length;
}

/** A rule's `principal:` line names people by id or name; both fold into the Owner. */
function rewriteRules(dir: string, map: ReadonlyMap<string, string>, names: ReadonlyMap<string, string>, write: boolean): number {
  let files = 0;
  for (const path of filesIn(dir, ".md")) {
    const content = readFileSync(path, "utf8");
    const front = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);
    if (front === null) continue;
    let changed = false;
    const body = front[2]!.split("\n").map(line => {
      const match = /^(\s*principals?\s*:\s*)([^#]*?)(\s*#.*)?$/i.exec(line);
      if (match === null) return line;
      const before = match[2]!.split(",").map(value => value.trim()).filter(Boolean);
      const after = [...new Set(before.map(value => map.get(value) ?? names.get(value.toLowerCase()) ?? value))];
      if (after.join(",") === before.join(",")) return line;
      changed = true;
      return `${match[1]}${after.join(", ")}${match[3] ?? ""}`;
    }).join("\n");
    if (!changed) continue;
    files += 1;
    if (write) writeAtomically(path, `${content.slice(0, front.index)}${front[1]}${body}${content.slice(front.index + front[0].length - front[3]!.length)}`);
  }
  return files;
}

/** The personal-box ledger (sqlite): a row keeps its id and moves owner; a row the new owner already holds for the same request is left and counted out. */
function rewritePersonalBoxes(home: string, map: ReadonlyMap<string, string>, write: boolean): number {
  const path = join(home, "personal-boxes", "personal-boxes.sqlite");
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT id, owner, data FROM boxes").all() as { id: string; owner: string; data: string }[];
    const moving = rows.filter(row => map.has(row.owner));
    if (write && moving.length > 0) {
      const update = db.prepare("UPDATE OR IGNORE boxes SET owner = ?, data = ? WHERE id = ?");
      db.exec("BEGIN");
      for (const row of moving) {
        const target = map.get(row.owner)!;
        let data = row.data;
        try { data = JSON.stringify({ ...(JSON.parse(row.data) as object), owner: target }); } catch { /* the column is the truth */ }
        update.run(target, data, row.id);
      }
      db.exec("COMMIT");
    }
    return moving.length;
  } finally { db.close(); }
}

/** Every store, through one mapping. `write: false` is the preview's count of the same work. */
function rewriteStores(paths: MergePaths, map: ReadonlyMap<string, string>, names: ReadonlyMap<string, string>, write: boolean): Record<MergedStore, number> {
  const memoryFiles = [...agentDirs(paths.agents).map(dir => join(dir, "memory.jsonl")), ...filesIn(join(paths.agents, "shared-memory"), ".jsonl")];
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    "mcp-tokens": rewriteJson(join(paths.home, "mcp-tokens.json"), ["principalId"], map, write),
    watchdog: rewriteJson(join(paths.home, "watchdog", "install.json"), ["principalId"], map, write),
    tasks: rewriteJsonl(paths.tasks, ["requester", "reviewerId", "by", "pausedBy"], map, write, line => (line.task as { id?: string } | undefined)?.id),
    spend: rewriteJsonl(paths.usage, ["principal"], map, write),
    memory: sum(memoryFiles.map(path => rewriteJsonl(path, ["about"], map, write))),
    "person-notes": rewriteJsonl(join(paths.home, "people.jsonl"), ["principal", "by"], map, write),
    "box-members": sum([join(paths.agents, "boxes.json"), join(paths.agents, "box.json")].map(path => rewriteJson(path, ["members"], map, write))),
    "personal-boxes": rewritePersonalBoxes(paths.home, map, write),
    "vault-grants": rewriteJson(paths.vault, ["holder"], map, write),
    rules: rewriteRules(paths.rules, map, names, write),
    // The larger quota wins: a person never loses room by being recognised as one.
    "box-quotas": rewriteKeyed(paths.config, doc => doc.personBoxQuotas as Record<string, unknown> | undefined, values => (values.length > 0 ? Math.max(...values) : undefined), map, write),
    // A signed-out browser stays signed out: when any old id had been signed out everywhere, the Owner starts past all of them, which signs every old browser out once.
    sessions: rewriteKeyed(join(paths.home, "session-epochs.json"), doc => doc, values => { const top = Math.max(0, ...values); return top > 0 ? top + 1 : undefined; }, map, write),
    turns: rewriteJsonl(paths.turns, ["principalId"], map, write),
    inbox: rewriteJsonl(paths.inbox, ["principalId"], map, write),
  };
}

function readJournal(home: string): MergeJournal | undefined {
  const path = join(home, MERGE_JOURNAL);
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, "utf8")) as MergeJournal; } catch { return undefined; }
}

function writeJournal(home: string, journal: MergeJournal): void {
  writeAtomically(join(home, MERGE_JOURNAL), `${JSON.stringify(journal, null, 2)}\n`);
}

/** When each identity last wrote through a door: the newest admitted message. */
function lastSeenByIdentity(home: string): Map<string, string> {
  const seen = new Map<string, string>();
  const path = join(home, "messages.jsonl");
  if (!existsSync(path)) return seen;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as { identity?: unknown; receivedAt?: unknown };
      if (typeof line.identity !== "string" || typeof line.receivedAt !== "string") continue;
      if ((seen.get(line.identity) ?? "") < line.receivedAt) seen.set(line.identity, line.receivedAt);
    } catch { /* a torn line says nothing about anyone */ }
  }
  return seen;
}

/** The newest spend row on each person's behalf. */
function lastSpendByPrincipal(path: string): Map<string, string> {
  const seen = new Map<string, string>();
  if (!existsSync(path)) return seen;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as { principal?: unknown; at?: unknown };
      if (typeof line.principal !== "string" || typeof line.at !== "string") continue;
      if ((seen.get(line.principal) ?? "") < line.at) seen.set(line.principal, line.at);
    } catch { /* as above */ }
  }
  return seen;
}

const mappingOf = (people: readonly RawPrincipal[]) => new Map(people.filter(person => person.id !== OWNER_ID).map(person => [person.id, OWNER_ID] as const));
const namesOf = (people: readonly RawPrincipal[]) => new Map(people.map(person => [person.name.trim().toLowerCase(), OWNER_ID] as const));

function notOffered(roster: RosterFile | undefined, home: string, desktop: boolean): NotOffered | undefined {
  if (!desktop) return "server";
  if (readJournal(home)?.state === "pending") return "pending";
  if (roster === undefined || (roster.principals ?? []).length === 0) return "empty";
  // Any installation field is a decision already made: a personal installation, an organisation said out loud, or a conversion.
  if (roster.installation !== undefined) return "decided";
  if ((roster.principals ?? []).length > MAX_SELF) return "too-many";
  return undefined;
}

/** Read-only. What a merge would be on this roster, and whether one is offered at all. */
export function mergePreview(paths: MergePaths, options: { desktop: boolean; doorType?: (door: string) => string | undefined }): MergePreview {
  const roster = readRoster(paths.roster);
  const people = (roster?.principals ?? []).filter(person => typeof person?.id === "string" && typeof person?.name === "string");
  const reason = notOffered(roster, paths.home, options.desktop);
  const digest = roster === undefined ? "" : digestOf(roster);
  const admin = people.find(person => person.role === "admin") ?? people[0];
  const base = { digest, ownerName: admin?.name.trim() || "Owner", kept: KEPT_STORES };
  if (reason !== undefined) return { offered: false, reason, ...base, people: [], hints: [], changes: [] };
  const seen = lastSeenByIdentity(paths.home);
  const spent = lastSpendByPrincipal(paths.usage);
  const listed: MergePerson[] = people.map(person => {
    const identities = (person.identities ?? []).map(identityOf).filter((id): id is string => id !== undefined).map(identity => {
      const door = doorOfIdentity(identity);
      const doorType = options.doorType?.(door);
      const lastSeen = seen.get(identity);
      return { identity, door, ...(doorType !== undefined ? { doorType } : {}), ...(lastSeen !== undefined ? { lastSeen } : {}) };
    });
    const lastActive = [spent.get(person.id), ...identities.map(item => item.lastSeen)].filter((at): at is string => at !== undefined).sort().at(-1);
    return { id: person.id, name: person.name, role: person.role, identities, ...(lastActive !== undefined ? { lastActive } : {}) };
  });
  const hints: MergeHint[] = [];
  const count = (values: string[]) => values.reduce((tally, value) => tally.set(value, (tally.get(value) ?? 0) + 1), new Map<string, number>());
  for (const [name, n] of count(listed.map(person => person.name.trim()))) if (n > 1) hints.push({ kind: "same-name", name, count: n });
  for (const [door, n] of count(listed.flatMap(person => [...new Set(person.identities.map(item => item.door))]))) if (n > 1) hints.push({ kind: "same-door", door, count: n });
  const counted = rewriteStores(paths, mappingOf(people), namesOf(people), false);
  const changes = MERGED_STORES.map(store => ({ store, records: counted[store] })).filter(change => change.records > 0);
  return { offered: true, ...base, people: listed, hints, changes };
}

export class MergeRefused extends Error {
  constructor(readonly why: "stale" | NotOffered, message: string) { super(message); }
}

/** The person's yes. Writes the journal and nothing else; the merge runs at the next start. Refuses a roster that changed since the preview. */
export function confirmMerge(paths: MergePaths, input: { digest: string; name?: string; by: string; desktop: boolean; now?: number }): MergeJournal {
  return withRosterLock(paths.roster, () => {
    const roster = readRoster(paths.roster);
    const reason = notOffered(roster, paths.home, input.desktop);
    if (reason !== undefined) throw new MergeRefused(reason, `Nothing to merge here (${reason}).`);
    if (digestOf(roster!) !== input.digest) throw new MergeRefused("stale", "The people on this installation changed after the preview. Look again before confirming.");
    const people = roster!.principals ?? [];
    const admin = people.find(person => person.role === "admin") ?? people[0]!;
    const name = (input.name ?? "").trim().slice(0, 60) || admin.name.trim() || "Owner";
    const journal: MergeJournal = { state: "pending", requestedAt: input.now ?? Date.now(), by: input.by, digest: input.digest, name, from: people };
    writeJournal(paths.home, journal);
    return journal;
  });
}

/** The Owner the merge leaves: every identity (with the incarnation it was bound under), every anchor, the old ids as aliases. Admins' identities first. */
function ownerOf(journal: MergeJournal): RawPrincipal {
  const ordered = [...journal.from.filter(person => person.role === "admin"), ...journal.from.filter(person => person.role !== "admin")];
  const seen = new Set<string>();
  const identities: unknown[] = [];
  for (const person of ordered) {
    for (const entry of person.identities ?? []) {
      const identity = identityOf(entry);
      if (identity === undefined || seen.has(identity)) continue;
      seen.add(identity);
      identities.push(entry);
    }
  }
  const anchors = [...new Set(ordered.flatMap(person => (person.anchors ?? []).filter((a): a is string => typeof a === "string")))];
  const aliases = [...new Set(ordered.flatMap(person => [person.id, ...(person.aliases ?? []).filter((a): a is string => typeof a === "string")]))].filter(id => id !== OWNER_ID);
  return { id: OWNER_ID, name: journal.name, role: "admin", identities, anchors, aliases };
}

/**
 * Runs a confirmed merge. Called at start, before any store is opened. Returns the journal it
 * finished (or abandoned), undefined when nothing was pending.
 */
export function applyPendingMerge(paths: MergePaths, log: (line: string) => void, now: () => number = Date.now): MergeJournal | undefined {
  const journal = readJournal(paths.home);
  if (journal?.state !== "pending") return undefined;
  return withRosterLock(paths.roster, () => {
    const roster = readRoster(paths.roster) ?? { principals: [] };
    const rosterDone = installationOf(roster).merged?.at === journal.requestedAt;
    if (!rosterDone && digestOf(roster) !== journal.digest) {
      const abandoned: MergeJournal = { ...journal, state: "abandoned", reason: "the roster changed between the confirmation and the start" };
      writeJournal(paths.home, abandoned);
      log("upgrade: a confirmed merge of this installation's people into its Owner was not applied — the roster changed after it was confirmed. Nothing was changed; preview it again in Settings → Team → People (INV-1698).");
      return abandoned;
    }
    // Stores first, the roster last: until the roster says merged, a crash leaves a resumable merge, never an Owner whose records still name strangers.
    const changes = rewriteStores(paths, mappingOf(journal.from), namesOf(journal.from), true);
    if (!rosterDone) {
      const file: RosterFile = {
        ...roster,
        installation: { mode: "single-machine", ownerId: OWNER_ID, createdAt: journal.requestedAt, merged: { at: journal.requestedAt, from: journal.from.map(person => person.id) } },
        bootstrap: { ...(roster.bootstrap ?? {}), disabled: true },
        principals: [ownerOf(journal)],
      };
      writeAtomically(paths.roster, `${JSON.stringify(file, null, 2)}\n`);
    }
    const done: MergeJournal = { ...journal, state: "done", appliedAt: now(), changes: Object.fromEntries(Object.entries(changes).filter(([, n]) => n > 0)) };
    writeJournal(paths.home, done);
    const summary = Object.entries(done.changes ?? {}).map(([store, n]) => `${store} ${n}`).join(", ") || "no records named them";
    log(`upgrade: ${journal.from.length} people on this desktop installation were confirmed to be one person and merged into its Owner "${journal.name}" (INV-1698); records moved: ${summary}. The old ids stay as aliases; the record is ${basename(MERGE_JOURNAL)}.`);
    return done;
  });
}
