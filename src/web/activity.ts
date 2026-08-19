/**
 * The activity feed's history, on disk.
 *
 * It began in the page, which lost it on reload. Moving it into the server fixed that
 * and left a subtler version of the same bug: it lived in one process's memory, so
 * restarting the server — after a config change, after a crash, after any code change —
 * silently emptied it. "The last 400 events" has to mean the last 400 events, not the
 * last 400 since whenever this process happened to start.
 *
 * Append-only JSONL, and the whole file is one append per event: nothing to lose if the
 * process dies mid-write, and a corrupt tail costs one line rather than the history.
 * The file is compacted to the limit once it has grown well past it, so it does not
 * become a log of the whole installation.
 *
 * Not the record of what the agents did — the transcripts are that, and they are
 * complete. This is the view someone glances at to see what has been happening.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** An event with the time it happened, so a replayed line is not read as a live one. */
export type StoredEvent = Record<string, unknown> & { type: string; at: string };

export interface ActivityLogOptions {
  path: string;
  limit: number;
  now?: () => string;
  onWarn?: (message: string) => void;
}

/** Rewrite once the file holds this much more than the limit. */
const COMPACT_FACTOR = 3;

export class ActivityLog {
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => string;
  private readonly onWarn: (message: string) => void;
  private events: StoredEvent[] = [];
  /** Lines in the file, so compaction does not need to read it back. */
  private lines = 0;

  constructor(options: ActivityLogOptions) {
    this.path = options.path;
    this.limit = Math.max(1, options.limit);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onWarn = options.onWarn ?? (() => {});
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;

    let contents: string;
    try {
      contents = readFileSync(this.path, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot read ${this.path} (${detail}), starting empty`);
      return;
    }

    const lines = contents.split("\n").filter(line => line.trim() !== "");
    this.lines = lines.length;

    // A line that does not parse is skipped rather than fatal: a process killed
    // mid-append leaves a partial last line, and losing one event is not worth losing
    // the rest of the history over.
    const parsed: StoredEvent[] = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as StoredEvent;
        if (event && typeof event.type === "string") parsed.push(event);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) this.onWarn(`activity: skipped ${skipped} unreadable line(s)`);

    this.events = parsed.slice(-this.limit);
  }

  /** Most recent last, at most `limit` of them. */
  list(): StoredEvent[] {
    return this.events;
  }

  add(event: Record<string, unknown> & { type: string }): StoredEvent {
    const stored: StoredEvent = { ...event, at: this.now() };

    this.events.push(stored);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }

    try {
      appendFileSync(this.path, `${JSON.stringify(stored)}\n`, "utf8");
      this.lines++;
      if (this.lines > this.limit * COMPACT_FACTOR) this.compact();
    } catch (error) {
      // A feed that cannot be persisted is still a working feed; say so once and
      // carry on rather than failing the request that produced the event.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot write ${this.path} (${detail})`);
    }

    return stored;
  }

  /** Rewrites the file with what is kept. Temp plus rename, so a reader never sees half. */
  private compact(): void {
    const temp = `${this.path}.${process.pid}.tmp`;
    const body = this.events.map(event => `${JSON.stringify(event)}\n`).join("");
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temp, body, "utf8");
      renameSync(temp, this.path);
      this.lines = this.events.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`activity: cannot compact ${this.path} (${detail})`);
    }
  }
}
