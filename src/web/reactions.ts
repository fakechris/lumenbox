/**
 * One emoji per message, per thread (INV-111).
 *
 * The smallest reaction model that is still a reaction: a message is identified by its
 * index in the transcript — the same number the permalink uses — and carries at most one
 * emoji, from a short fixed set, with who set it and when. Not a tally of everybody's
 * thumbs: this is a workstation with a handful of people in it, and the question a reaction
 * answers here is "did anyone look at this", not "how popular was it".
 *
 * Kept beside the transcript as a small JSON file rather than in the transcript itself:
 * the transcript is what the model reads and what makes an agent's claims checkable, and a
 * person's 👍 on line 41 is neither.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The set a person may pick from. Small on purpose: a picker with three hundred entries is a search box. */
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];

export interface Reaction {
  emoji: ReactionEmoji;
  /** The principal id of whoever set it, so "who reacted" has an answer. */
  by: string;
  at: string;
}

/** Message index → its reaction. */
export type ReactionMap = Record<string, Reaction>;

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTIONS as readonly string[]).includes(value);
}

export function readReactions(path: string): ReactionMap {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ReactionMap = {};
    for (const [index, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = value as Partial<Reaction> | undefined;
      if (!/^\d+$/.test(index) || !isReactionEmoji(row?.emoji) || typeof row?.by !== "string") continue;
      out[index] = { emoji: row.emoji, by: row.by, at: typeof row.at === "string" ? row.at : "" };
    }
    return out;
  } catch {
    // A broken file is no reactions, not a broken thread.
    return {};
  }
}

/**
 * Sets, replaces or clears the reaction on one message and returns the new map.
 * `emoji: null` clears. The write is atomic (temp + rename), like the other side files.
 */
export function setReaction(
  path: string,
  input: { index: number; emoji: ReactionEmoji | null; by: string; at?: string }
): ReactionMap {
  const map = readReactions(path);
  const key = String(input.index);
  if (input.emoji === null) delete map[key];
  else map[key] = { emoji: input.emoji, by: input.by, at: input.at ?? new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(map, null, 1)}\n`, "utf8");
  renameSync(temp, path);
  return map;
}
