/**
 * Copying the one part of this system that cannot be rebuilt.
 *
 * The box is disposable: it is an image, and rebuilding it is the upgrade path. `/home/box/work`
 * lives in a Docker volume. What is neither is `~/.agentbox` — transcripts, memory, plans, todos,
 * skills' scheduling history, the policy log, usage. Lose that and the agents are strangers who
 * have never met you.
 *
 * The documented backup was `box down` followed by `cp -a`, by hand. Two things wrong with that,
 * and they compound: it requires stopping, so it does not happen; and it requires remembering, so
 * it does not happen either. The day it matters is the day it has not been done.
 *
 * **No stopping.** Every file here is either append-only JSONL or a document replaced atomically by
 * rename. A copy taken while something is appending can catch a torn last line — and every reader
 * in this codebase already skips one, because that is also what a crash leaves behind. So the
 * consistency this needs already exists; the old instruction to stop first was solving a problem
 * the formats had already solved.
 *
 * **Named by when.** A backup that overwrites the last one is a backup that faithfully copies
 * corruption over the only good copy. These are dated directories, and old ones are pruned by
 * count rather than by age, because "keep the last seven" survives a machine that was off for a
 * month and "delete older than a week" does not.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentboxHome, envNumber } from "../config.ts";

/** Where snapshots go, unless told otherwise. Beside the state, not inside it. */
export function backupRoot(): string {
  return process.env.AGENTBOX_BACKUP_DIR ?? `${agentboxHome()}-backups`;
}

/**
 * How many to keep. Count, not age: a machine that was off for a month still has its backups.
 *
 * Floored at 1 and forced to a whole number. `AGENTBOX_BACKUP_KEEP=-1` or `0` — or a fraction —
 * would otherwise select every snapshot for deletion, including the one just taken, and then report
 * a successful path that no longer exists.
 */
export const KEEP_BACKUPS = Math.max(1, Math.floor(envNumber("AGENTBOX_BACKUP_KEEP", 7)));

/**
 * The shape of a snapshot's name: an ISO timestamp with the punctuation replaced.
 *
 * Pruning only ever touches directories that match this. The destination may be a directory that
 * holds other things — `backup /mnt/nas` is documented — and a prune that deleted whatever sorted
 * first would destroy unrelated data. A snapshot is only a thing this tool made if it is named like
 * one.
 */
const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

export interface BackupResult {
  path: string;
  bytes: number;
  files: number;
  pruned: string[];
}

/** Every file under a directory, for reporting what was actually copied. */
function measure(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = measure(path);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += statSync(path).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * Takes one snapshot, and prunes the oldest beyond the keep count.
 *
 * `stamp` is passed in rather than read from the clock so this is testable and so a caller can name
 * a snapshot after the thing that prompted it.
 */
export function backupNow(options: { stamp: string; from?: string; to?: string } = { stamp: "" }): BackupResult {
  const from = options.from ?? agentboxHome();
  const root = options.to ?? backupRoot();
  const stamp = options.stamp.replace(/[^0-9A-Za-z_-]/g, "-");
  const path = join(root, stamp);

  if (!existsSync(from)) {
    throw new Error(`There is nothing at ${from} to back up.`);
  }
  // 0700, because a backup is a second copy of everything — including the box token, the UI token
  // and the control-plane database. The files keep their own modes, so the credentials stay 0600;
  // the transcripts do not, and a transcript is where a secret an agent read ends up. A directory
  // anyone can list is a slower version of the same leak.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // A snapshot that half-exists is worse than none, so it is built beside its name and moved into
  // place only once the copy finished.
  const partial = `${path}.partial`;
  rmSync(partial, { recursive: true, force: true });
  cpSync(from, partial, { recursive: true, dereference: false });
  chmodSync(partial, 0o700);
  rmSync(path, { recursive: true, force: true });
  // Rename, not a second copy: `partial` and the final name are both under `root`, so they are on
  // one filesystem and the rename is atomic. The final directory therefore never exists half-built
  // — the failure a prune would later count as a real snapshot and evict a good one for.
  renameSync(partial, path);
  chmodSync(path, 0o700);

  // The one file here that is not append-only JSONL: the control-plane SQLite database, in WAL
  // mode. A recursive copy of `control.db` + `-wal` + `-shm` is not a consistent snapshot — a
  // checkpoint between copying the two can splice generations. `VACUUM INTO` asks SQLite for a
  // clean single-file snapshot of the *live* database, which is the blessed way to copy an open
  // WAL db. Best-effort: if it fails, the file copy already in place stands, and a backup never
  // fails over this.
  snapshotControlDb(from, path);

  const { bytes, files } = measure(path);

  // Only directories this tool made, by name. Anything else under `root` is not ours to delete —
  // the destination is allowed to hold other things.
  const existing = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const pruned = existing.slice(0, Math.max(0, existing.length - KEEP_BACKUPS));
  for (const name of pruned) rmSync(join(root, name), { recursive: true, force: true });

  return { path, bytes, files, pruned };
}

/**
 * Replaces the copied control.db with a consistent SQLite snapshot, if there is one.
 *
 * Separate connection, read from the live database, written into the backup. The stale `-wal` and
 * `-shm` copies are removed because the snapshot already folds their committed frames in; leaving
 * them would have a restore replay frames that are no longer relevant.
 */
function snapshotControlDb(from: string, snapshot: string): void {
  const live = join(from, "control", "control.db");
  const copied = join(snapshot, "control", "control.db");
  if (!existsSync(live) || !existsSync(copied)) return;
  try {
    const db = new DatabaseSync(live, { readOnly: true });
    try {
      rmSync(copied, { force: true });
      // Quote for the SQL string; a path with a single quote would otherwise break it.
      db.exec(`vacuum into '${copied.replace(/'/g, "''")}'`);
      chmodSync(copied, 0o600);
    } finally {
      db.close();
    }
    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${copied}${suffix}`, { force: true });
    }
  } catch {
    // The recursive file copy remains in place; it is inconsistent under concurrent writes but
    // better than no control.db, and a backup must not fail over this.
  }
}

/**
 * Runs a backup on a timer, and never lets it take down what it is protecting.
 *
 * A failed backup is reported and the loop continues: a full disk should not stop the agents, and
 * an operator who is told the backup failed can act on it.
 */
export class BackupSchedule {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      intervalMs: number;
      now?: () => Date;
      log: (line: string) => void;
      run?: (stamp: string) => BackupResult;
    }
  ) {}

  /** One backup, named for the moment it was taken. Exposed so a test drives it directly. */
  once(): void {
    const now = (this.options.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      const result = (this.options.run ?? (name => backupNow({ stamp: name })))(stamp);
      const pruned = result.pruned.length > 0 ? `, pruned ${result.pruned.length}` : "";
      this.options.log(
        `backed up ${result.files} files (${Math.round(result.bytes / 1024)}KB) to ${result.path}${pruned}`
      );
    } catch (error) {
      this.options.log(
        `backup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  start(): void {
    if (this.timer !== undefined || this.options.intervalMs <= 0) return;
    this.timer = setInterval(() => this.once(), this.options.intervalMs);
    // Never the reason the process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
