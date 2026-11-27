/**
 * The home's format number, and the migrations that move a home from one number to the next
 * (docs/05 §2.0, docs/106 §6, INV-2201).
 *
 * Until now a change to stored data had to be backward-compatible by inspection: nothing in the
 * home said which version wrote it, each one-off repair found its own trigger, and an older
 * binary started on newer data would read what it could and append to the rest. Three things
 * replace that:
 *
 *   - `<home>/FORMAT` holds one integer. A home without the file is format 0 — every
 *     installation written before this — and a home created now is stamped with the current number.
 *   - `HOME_MIGRATIONS` is the ordered list. Migration `n` brings a home from `n - 1` to `n`. At
 *     start each one the home has not had is run in order, recorded in
 *     `<home>/format-migrations.jsonl` (which, when, by which app version, where the backup
 *     went), and only then is `FORMAT` moved to `n`.
 *   - A binary that finds a number higher than it knows stops, saying which format it found and
 *     which version wrote it. It changes nothing: a downgrade is refused, never attempted.
 *
 * What a migration author is held to:
 *
 *   - **Idempotent, and safe to meet its own half-finished work.** A crash between `run` and the
 *     stamp means the next start runs it again. A migration that throws leaves `FORMAT` where it
 *     was, and the next start retries.
 *   - **`rewrites: true` when it changes or moves stored data.** The whole home is then copied
 *     first (`backup`, the host's own snapshot), once per start, and the copy's path is in the
 *     ledger and in the message if the migration fails. A migration that only stamps needs none.
 *   - **Never renumbered, never edited after a release shipped it.** A home that had migration 3
 *     has had it; changing what 3 does changes nothing there. The fix is migration 4.
 *
 * This file takes the home and the clock as parameters and reads no environment: `src/cli.ts`
 * calls `openHome` once, before any command that uses the home.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { appendLineDurably } from "./host/jsonl.ts";

export const HOME_FORMAT_FILE = "FORMAT";
export const HOME_FORMAT_LEDGER = "format-migrations.jsonl";
const LOCK_FILE = "FORMAT.lock";

export interface HomeMigration {
  /** The format this brings a home to. The list is 1, 2, 3 … with no gaps. */
  to: number;
  /** What it does, in a few words: this is what the ledger and a failure message say. */
  name: string;
  /** Whether it changes or moves stored data. True means a backup is taken first. */
  rewrites: boolean;
  /** Does it. Must be safe to run again on a home it has already been run on, wholly or in part. */
  run(home: string): void;
}

/**
 * Format 1 is the layout 0.4.9 writes (docs/05 §2), as it stands — including the repairs that
 * still find their own trigger: the MiniMax key rename in `config.json` (config-migrations.ts),
 * `boxes.json` made from the single box record on first read (box/boxes.ts), channel grants
 * re-keyed to principals (web/server.ts), `memory.md` imported once into `memory.jsonl`, and a
 * transcript moved under `.epochs/` on its first `/new` (agents/context-epoch.ts). Each is lazy
 * or depends on something only a running host knows, so a 0.4.9 home may hold either form, and
 * format 1 means "either form, as 0.4.9 reads it". Nothing is rewritten: this only stamps.
 */
export const HOME_MIGRATIONS: readonly HomeMigration[] = [{ to: 1, name: "the 0.4.9 layout, stamped as it stands", rewrites: false, run: () => {} }];

/** The exit status of a command that refused the home (EX_CONFIG). Not a crash: starting again changes nothing, and the desktop app shows the message instead of retrying (electron/home-refused.cjs mirrors the number). */
export const HOME_REFUSED_EXIT = 78;

/**
 * Which commands open the installation's home, and so pass through `openHome` first. Every command
 * `src/cli.ts` dispatches is in one of the two lists (home-format.test.ts holds the dispatch to them),
 * so a new command is a decision, and a word that is no command at all makes no home.
 */
export const HOME_COMMANDS: ReadonlySet<string> = new Set([
  "box", "backup", "agents", "agent", "template", "eval", "skills", "improve", "bundle", "routines", "host", "chat", "control", "egress", "web",
  "golden", "extensions", "recover-work", "usage", "day", "digest", "audit", "scan-records",
]);
/**
 * Commands with no installation behind them. Help and the like; the two a client machine runs
 * against somebody else's installation (`mcp`, `skill`); and the three that run on a machine
 * that need not be one: `node` (an organisation's node keeps a state directory of its own and
 * refuses to run beside an installation, INV-1697), `watchdog` and `supervise` (clients of the
 * side door by URL and token; `supervise` writes only its own `supervisor/<run>` directory).
 * `supervision` is the app's child beside the server: it is started once the server answers, so
 * the home has been opened by then, and run alone on a machine with no home it never made one.
 */
export const HOMELESS_COMMANDS: ReadonlySet<string> = new Set(["help", "--help", "-h", "where", "providers", "probe", "mcp", "skill", "node", "watchdog", "supervise", "supervision"]);
/** `box` subcommands that touch no installation: building and pushing the image, and giving this machine's box to another installation (which refuses when there is one here). */
const HOMELESS_BOX = new Set(["build", "push", "connect"]);

export function opensHome(command: string | undefined, sub?: string): boolean {
  if (command === undefined || !HOME_COMMANDS.has(command)) return false;
  return !(command === "box" && sub !== undefined && HOMELESS_BOX.has(sub));
}

/** A home this binary must not open: newer than it knows, unreadable, or being upgraded by another process. */
export class HomeFormatError extends Error {
  /** True when starting again a moment later may succeed: another process is bringing the home forward right now. */
  readonly transient: boolean;
  constructor(message: string, options?: { cause?: unknown; transient?: boolean }) {
    super(message, options);
    this.name = "HomeFormatError";
    this.transient = options?.transient === true;
  }
}

export interface LedgerEntry {
  /** The format the home is at after this entry. */
  format: number;
  /** The format it was at before; null for a home created at `format`. */
  from: number | null;
  name: string;
  at: string;
  /** The app version that ran it. */
  appVersion: string;
  /** Where the home was copied before a rewriting migration. */
  backup?: string;
}

export interface OpenHomeOptions {
  home: string;
  appVersion: string;
  /** Copies the home somewhere safe and returns where; called at most once, before the first rewriting migration. */
  backup?: (stamp: string) => string;
  log?: (line: string) => void;
  now?: () => Date;
  /** The registry; a parameter so a test can add a migration that does not exist yet. */
  migrations?: readonly HomeMigration[];
}

export interface OpenedHome {
  format: number;
  /** The formats this call brought the home through, in order; empty when it was already current. */
  applied: number[];
  /** True when there was no home and one was made. */
  created: boolean;
  /** True when the number could not be written because the home is read-only, and nothing but the stamp was owed. */
  unstamped?: true;
}

/** The ledger, oldest first. A torn last line — what a crash leaves — is skipped, as every reader here does. */
export function readFormatLedger(home: string): LedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(join(home, HOME_FORMAT_LEDGER), "utf8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // torn or hand-edited: not ours to guess at
    }
  }
  return entries;
}

/**
 * What the home says it is: `"new"` when there is no home yet (absent or an empty directory), 0
 * when it has content and no `FORMAT`, otherwise the number in the file. A `FORMAT` that is not
 * a whole number is refused rather than read as 0: running every migration again over a home of
 * unknown format is the guess this file exists to stop.
 */
export function readHomeFormat(home: string): number | "new" {
  let text: string;
  try {
    text = readFileSync(join(home, HOME_FORMAT_FILE), "utf8");
  } catch {
    let entries: string[] = [];
    try {
      entries = readdirSync(home);
    } catch {
      return "new";
    }
    return entries.length === 0 ? "new" : 0;
  }
  const trimmed = text.trim();
  if (!/^\d{1,9}$/.test(trimmed)) {
    throw new HomeFormatError(
      `${join(home, HOME_FORMAT_FILE)} should hold one whole number and holds ${JSON.stringify(trimmed.slice(0, 40))}. ` +
        `Not guessing which format this home is: nothing was changed. ${join(home, HOME_FORMAT_LEDGER)} lists the formats it has been brought to; put the last one back in the file.`
    );
  }
  return Number(trimmed);
}

/** Written beside its name and renamed into place, so the file is never half a number. */
function writeHomeFormat(home: string, format: number): void {
  const path = join(home, HOME_FORMAT_FILE);
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${format}\n`, "utf8");
  renameSync(partial, path);
}

function record(home: string, entry: LedgerEntry): void {
  // Durably: the record exists before the number it explains moves.
  appendLineDurably(join(home, HOME_FORMAT_LEDGER), JSON.stringify(entry));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is somebody else's. Anything else: it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One process brings a home forward at a time. The lock names its holder, so a lock a crash left
 * behind is taken over rather than obeyed for ever; a live holder is waited for by the person,
 * not by this process — a second start during an upgrade says so and stops.
 */
function lock(home: string): () => void {
  const path = join(home, LOCK_FILE);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // gone between the two calls: try again
      }
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) {
        throw new HomeFormatError(`Another LumenBox process (pid ${holder}) is upgrading the data in ${home}. Start again when it has finished; nothing was changed by this one.`, { transient: true });
      }
      if (attempt >= 2) throw new HomeFormatError(`${path} could not be taken. Remove it if no LumenBox process is running, then start again.`);
      rmSync(path, { force: true });
    }
  }
}

function checked(migrations: readonly HomeMigration[]): number {
  migrations.forEach((migration, index) => {
    if (migration.to !== index + 1) throw new Error(`home migrations are numbered 1, 2, 3 … in order; entry ${index + 1} says ${migration.to} (${migration.name})`);
  });
  return migrations.length;
}

/**
 * Brings the home to the format this binary writes, or refuses to open it.
 *
 * Called once at start by everything that uses the home. On a home that is already current this
 * is one small read. Throws `HomeFormatError` with a message a person can act on; the caller's
 * job is to print it and not go on.
 */
export function openHome(options: OpenHomeOptions): OpenedHome {
  try {
    return bringForward(options);
  } catch (error) {
    if (error instanceof HomeFormatError || !READ_ONLY.has((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
    // The home cannot be written. Whether that matters depends on what was owed.
    const { home } = options;
    const migrations = options.migrations ?? HOME_MIGRATIONS;
    const found = readHomeFormat(home);
    const from = found === "new" ? 0 : found;
    const owed = migrations.slice(from).find(migration => migration.rewrites);
    const why = (error as NodeJS.ErrnoException).code;
    if (owed !== undefined) {
      throw new HomeFormatError(`The data in ${home} is format ${from} and has to be upgraded to format ${owed.to} (${owed.name}) before this version can use it, but it cannot be written (${why}). Nothing was changed.`, { cause: error });
    }
    // Only the stamp was owed, and the layout is one this version reads: a command that only reads goes on, as it did before there was a number.
    (options.log ?? (() => {}))(`home: ${home} cannot be written (${why}), so its format number was not recorded; reading it as it is`);
    return { format: from, applied: [], created: false, unstamped: true };
  }
}

/** A home that cannot be written: another user's, or a read-only mount. */
const READ_ONLY: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EROFS"]);

function bringForward(options: OpenHomeOptions): OpenedHome {
  const { home, appVersion } = options;
  const migrations = options.migrations ?? HOME_MIGRATIONS;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const current = checked(migrations);

  const found = readHomeFormat(home);
  if (found !== "new" && found > current) {
    const writer = readFormatLedger(home).findLast(entry => entry.format === found)?.appVersion;
    throw new HomeFormatError(
      `The data in ${home} is format ${found}${writer !== undefined ? `, written by LumenBox ${writer}` : ""}. A newer LumenBox wrote this home: this is LumenBox ${appVersion}, which reads up to format ${current}. ` +
        `Install ${writer !== undefined ? `LumenBox ${writer} or later` : "that newer version"} to use it. Nothing was changed — an older version is never run on newer data.`
    );
  }
  if (found === current) return { format: current, applied: [], created: false };

  if (found === "new") {
    mkdirSync(home, { recursive: true });
    record(home, { format: current, from: null, name: "new home", at: now().toISOString(), appVersion });
    writeHomeFormat(home, current);
    return { format: current, applied: [], created: true };
  }

  const unlock = lock(home);
  try {
    // Read again under the lock: the process that held it a moment ago may have done all of this.
    const start = readHomeFormat(home);
    const from = start === "new" ? 0 : start;
    if (from > current) return bringForward(options);
    const applied: number[] = [];
    let backup: string | undefined;
    for (const migration of migrations.slice(from)) {
      if (migration.rewrites && backup === undefined) {
        if (options.backup === undefined) throw new HomeFormatError(`Format ${migration.to} (${migration.name}) rewrites stored data and there is no way to back ${home} up first. Nothing was changed.`);
        const stamp = `${now().toISOString().slice(0, 19).replace(/:/g, "-")}-before-format-${migration.to}`;
        try {
          backup = options.backup(stamp);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          throw new HomeFormatError(`${home} could not be backed up before format ${migration.to} (${migration.name}): ${why}. Nothing was changed; the next start tries again.`, { cause: error });
        }
        log(`home: copied to ${backup} before upgrading the stored data`);
      }
      try {
        migration.run(home);
      } catch (error) {
        throw new HomeFormatError(
          `Upgrading the data in ${home} to format ${migration.to} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}. ` +
            `The home is still format ${migration.to - 1}${backup !== undefined ? `, and a copy from before the upgrade is at ${backup}` : ""}. The next start tries again.`,
          { cause: error }
        );
      }
      // The record first, the number second: a crash between the two runs the migration again and records it twice, which is what happened.
      record(home, { format: migration.to, from: migration.to - 1, name: migration.name, at: now().toISOString(), appVersion, ...(migration.rewrites && backup !== undefined ? { backup } : {}) });
      writeHomeFormat(home, migration.to);
      applied.push(migration.to);
      log(`home: now format ${migration.to} (${migration.name})`);
    }
    return { format: current, applied, created: false };
  } finally {
    unlock();
  }
}
