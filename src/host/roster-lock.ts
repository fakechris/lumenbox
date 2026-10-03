import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The OS releases SQLite's writer lock on process death; no stale lock-file recovery race. */
export function withRosterLock<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = new DatabaseSync(`${path}.lock.sqlite`);
  try {
    lock.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try { const result = action(); lock.exec("COMMIT"); return result; }
    catch (error) { lock.exec("ROLLBACK"); throw error; }
  } finally { lock.close(); }
}
