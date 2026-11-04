/**
 * How much one turn takes from the queue (INV-1572).
 *
 * The bus already decides *which* messages belong together — one conversation, one lane, one
 * principal, a kickoff alone. It did not decide how many: a lane of background notices was taken
 * whole, so on 2026-11-04 the 1,366 job-end notices queued across a restart would all have gone
 * into one turn — a context no model reads well, if it fits at all. Now a turn takes at most
 * AGENTBOX_TURN_BATCH_ITEMS messages (8) and AGENTBOX_TURN_BATCH_KB of their text (24); the rest
 * stays queued in order and the follow-up turn the bus already wakes for what is left takes the
 * next ones. A single message larger than the byte limit still forms a batch of its own rather
 * than being split: grouping is a matter of how much is read at once, never of who said it.
 */

import { envNumber } from "../config.ts";

export interface BatchLimits {
  items: number;
  bytes: number;
}

export function batchLimitsFrom(read: (name: string, fallback: number) => number = envNumber): BatchLimits {
  return { items: Math.max(1, Math.floor(read("AGENTBOX_TURN_BATCH_ITEMS", 8))), bytes: Math.max(1, Math.floor(read("AGENTBOX_TURN_BATCH_KB", 24) * 1024)) };
}

/** The longest prefix of `messages` within the limits; never empty when `messages` is not. */
export function boundBatch<T extends { text: string }>(messages: readonly T[], limits: BatchLimits): T[] {
  const taken: T[] = [];
  let bytes = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(message.text, "utf8");
    if (taken.length > 0 && (taken.length >= limits.items || bytes + size > limits.bytes)) break;
    taken.push(message);
    bytes += size;
  }
  return taken;
}
