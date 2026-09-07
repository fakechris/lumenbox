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

export const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

interface Entry {
  fingerprint: string;
  at: number;
  /** Absent while the first request is still running. */
  reply?: { status: number; body: unknown };
  waiters: ((reply: { status: number; body: unknown }) => void)[];
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

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
  }

  private sweep(): void {
    const cutoff = this.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key);
    }
  }
}
