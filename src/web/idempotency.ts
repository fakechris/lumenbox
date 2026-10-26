/**
 * Idempotency keys for the API's mutating routes.
 *
 * A client that retries a `POST /api/prompt` after a dropped response sends the same message
 * twice, and the agent answers twice. With an `Idempotency-Key` header the second attempt
 * gets the first answer back; the same key with a *different* body is a conflict, not a
 * replay, and is refused — a retried request that changed is two requests wearing one name.
 * Keys live five minutes; the store is memory only, because a restart already re-admits
 * nothing (the durable ledgers own that) and a stale replay across restarts would be wrong
 * in the other direction. (TurnkeyAI's gateway keeps the same contract.)
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "../host/jsonl.ts";

export const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

interface Entry {
  fingerprint: string;
  at: number;
  /** Absent while the first request is still running. */
  reply?: { status: number; body: unknown };
  waiters: ((reply: { status: number; body: unknown }) => void)[];
}

export interface IdempotencyOptions {
  now?: () => number;
  /** How long a key is remembered. Five minutes for the API; a day for the side door (INV-1358). */
  ttlMs?: number;
  /** A JSONL file settled replies are appended to and reloaded from, so a day-long key survives a restart. */
  persistTo?: string;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly persistTo: string | undefined;

  constructor(options: IdempotencyOptions | (() => number) = {}) {
    const resolved = typeof options === "function" ? { now: options } : options;
    this.now = resolved.now ?? (() => Date.now());
    this.ttlMs = resolved.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.persistTo = resolved.persistTo;
    if (this.persistTo !== undefined && existsSync(this.persistTo)) {
      for (const line of readFileSync(this.persistTo, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const row = JSON.parse(line) as { key: string; fingerprint: string; at: number; reply: { status: number; body: unknown } };
          if (this.now() - row.at < this.ttlMs) this.entries.set(row.key, { fingerprint: row.fingerprint, at: row.at, reply: row.reply, waiters: [] });
        } catch {
          // One torn line.
        }
      }
    }
  }

  /**
   * Claims a key for a body. `fresh` means proceed and later `settle`; `replay` hands the
   * stored answer back (waiting for it when the first attempt is still in flight);
   * `conflict` is the same key on a different body; `invalid` is a key not worth storing.
   */
  claim(
    key: string | undefined,
    body: unknown
  ):
    | { kind: "none" }
    | { kind: "invalid" }
    | { kind: "fresh" }
    | { kind: "conflict" }
    | { kind: "replay"; reply: Promise<{ status: number; body: unknown }> } {
    if (key === undefined || key === "") return { kind: "none" };
    if (!KEY_PATTERN.test(key)) return { kind: "invalid" };
    this.sweep();
    const fingerprint = createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { fingerprint, at: this.now(), waiters: [] });
      return { kind: "fresh" };
    }
    if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
    if (existing.reply !== undefined) return { kind: "replay", reply: Promise.resolve(existing.reply) };
    return { kind: "replay", reply: new Promise(resolve => existing.waiters.push(resolve)) };
  }

  /** The first attempt's answer, for replays. */
  settle(key: string | undefined, reply: { status: number; body: unknown }): void {
    if (key === undefined) return;
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.reply = reply;
    for (const waiter of entry.waiters) waiter(reply);
    entry.waiters = [];
    if (this.persistTo !== undefined) {
      try {
        appendLine(this.persistTo, JSON.stringify({ key, fingerprint: entry.fingerprint, at: entry.at, reply }));
      } catch {
        // The memory copy still answers this process; a replay across a restart is what is lost.
      }
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
  }
}
