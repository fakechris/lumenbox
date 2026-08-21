/**
 * One agent taking a piece of work, so another does not take the same one.
 *
 * Two agents told to do the same thing both do it. That is not a communication failure and is not
 * fixed by asking them to coordinate: it is the absence of a claim. Everything else here already
 * has one — a box has a tenant, a desktop has an owner, a file has a version — and work itself did
 * not.
 *
 * **A lease, not a lock.** A claim expires. The alternative is an agent that dies holding a piece of
 * work nobody else may ever touch, which turns one failure into a permanent one; and there is no
 * way to distinguish "still working" from "gone" except by asking, which is what a lease does
 * implicitly. An agent that is still working renews by claiming again, which costs it nothing.
 *
 * **Durable, because the point is surviving the process.** In memory it would answer the easy half
 * of the question and fail at a restart, which is exactly when two agents are most likely to pick
 * up the same thing.
 *
 * **Advisory.** Nothing enforces that an agent claims before working — the model decides, as it
 * decides everything else — so this makes duplicate work *visible* and refusable rather than
 * impossible. That is worth saying plainly rather than implying a guarantee the design does not
 * make.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome, envNumber } from "../config.ts";

/** Kept alongside the transcripts: same lifetime, same volume, same backup. */
export function claimsPath(): string {
  return process.env.AGENTBOX_CLAIMS_LOG ?? join(agentboxHome(), "claims.jsonl");
}

/**
 * How long a claim holds without being renewed.
 *
 * Long enough that ordinary work does not have to think about it, short enough that an agent that
 * died does not park a task for the rest of the day. Thirty minutes is roughly the outer edge of a
 * single long turn.
 */
export const CLAIM_TTL_MS = envNumber("AGENTBOX_CLAIM_TTL_MS", 30 * 60_000);

const COMPACT_AT = envNumber("AGENTBOX_CLAIMS_COMPACT_AT", 5_000);

interface ClaimRecord {
  /** The work, normalised. Two agents describing the same task differently is not solvable here. */
  key: string;
  event: "claim" | "release";
  agentId: string;
  at: string;
  /** What was claimed, as written, for a person reading the file. */
  about: string;
}

export interface Claim {
  key: string;
  agentId: string;
  at: string;
  about: string;
}

/**
 * The key two claims collide on.
 *
 * Deliberately crude: lowercased, punctuation dropped, filler removed — the same treatment memory
 * gives a fact, and for the same reason. Two agents will not phrase a task identically, and being
 * slightly too eager to call two descriptions the same is cheaper than doing the work twice. It
 * cannot catch genuinely different wordings for one task; nothing textual can, and pretending
 * otherwise would be the failure this file exists to avoid.
 */
export function claimKey(about: string): string {
  return about
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(word => word !== "" && !FILLER.has(word))
    .join(" ");
}

const FILLER = new Set([
  "the", "a", "an", "is", "are", "to", "of", "in", "on", "for", "and", "or", "that", "this",
  "it", "please", "we", "i", "you", "should", "need", "needs", "do", "doing", "done",
]);

export class Claims {
  private readonly path: string | undefined;
  private lines = 0;

  /** `null` means keep none; omitted means the default path. */
  constructor(
    path: string | null = claimsPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.path = path ?? undefined;
  }

  /**
   * Takes the work, or reports who already has it.
   *
   * Claiming something you already hold is a renewal, not a conflict: an agent still working says
   * so by claiming again, and the alternative would punish exactly the agent doing the right thing.
   */
  claim(options: {
    agentId: string;
    about: string;
    now?: Date;
  }): { ok: true; renewed: boolean } | { ok: false; held: Claim } {
    const now = options.now ?? new Date();
    const key = claimKey(options.about);
    if (key === "") return { ok: true, renewed: false };

    const held = this.holderOf(key, now);
    if (held !== undefined && held.agentId !== options.agentId) {
      return { ok: false, held };
    }

    this.append({
      key,
      event: "claim",
      agentId: options.agentId,
      at: now.toISOString(),
      about: options.about.replace(/\s+/g, " ").trim().slice(0, 200),
    });
    return { ok: true, renewed: held !== undefined };
  }

  /** Gives the work back, whether finished or abandoned. */
  release(agentId: string, about: string, now = new Date()): void {
    const key = claimKey(about);
    if (key === "") return;
    this.append({ key, event: "release", agentId, at: now.toISOString(), about });
    if (this.lines > COMPACT_AT) this.compact(now);
  }

  /** Who holds this work right now, if anyone. */
  holderOf(key: string, now = new Date()): Claim | undefined {
    const live = this.live(now);
    return live.get(key);
  }

  /** Everything currently held, for showing a person who is on what. */
  all(now = new Date()): Claim[] {
    return [...this.live(now).values()];
  }

  /**
   * Current claims, replayed from the log with expiry applied.
   *
   * Expiry is computed on read rather than written on a timer: nothing has to be running for a
   * claim to lapse, which is the property that matters when the thing that stopped running is the
   * process holding it.
   */
  private live(now: Date): Map<string, Claim> {
    const held = new Map<string, Claim>();
    for (const record of this.read()) {
      if (record.event === "release") {
        held.delete(record.key);
        continue;
      }
      held.set(record.key, {
        key: record.key,
        agentId: record.agentId,
        at: record.at,
        about: record.about,
      });
    }
    for (const [key, claim] of held) {
      if (now.getTime() - Date.parse(claim.at) > CLAIM_TTL_MS) held.delete(key);
    }
    return held;
  }

  private append(record: ClaimRecord): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
      this.lines += 1;
    } catch (error) {
      // Never fail a turn over bookkeeping. What is lost is the claim, which means the work can be
      // taken twice — the behaviour everything had before this file existed.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`claims: cannot write ${this.path} (${detail})`);
    }
  }

  private read(): ClaimRecord[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    try {
      const records: ClaimRecord[] = [];
      let lines = 0;
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        lines += 1;
        try {
          const record = JSON.parse(line) as ClaimRecord;
          if (typeof record?.key === "string") records.push(record);
        } catch {
          // A torn last line costs one claim, not the file.
        }
      }
      this.lines = lines;
      return records;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`claims: cannot read ${this.path} (${detail})`);
      return [];
    }
  }

  /** Rewrites the file with only what is still held. */
  private compact(now: Date): void {
    if (this.path === undefined) return;
    try {
      const kept = [...this.live(now).values()].map(claim =>
        JSON.stringify({
          key: claim.key,
          event: "claim",
          agentId: claim.agentId,
          at: claim.at,
          about: claim.about,
        } satisfies ClaimRecord)
      );
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length === 0 ? "" : `${kept.join("\n")}\n`, "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`claims: cannot compact ${this.path} (${detail})`);
    }
  }
}

/** What the agent is told when the work is already someone else's. */
export function heldElsewhere(held: Claim, nameOf: (agentId: string) => string): string {
  return (
    `${nameOf(held.agentId)} claimed this at ${held.at.slice(0, 19).replace("T", " ")}: ` +
    `"${held.about}". Doing it as well would mean two of you doing the same work and, if it ` +
    `changes anything, doing it twice. Pick something else, or ask them where they have got to — ` +
    `and if you believe they have stopped, say so rather than starting in parallel. A claim lapses ` +
    `on its own after ${Math.round(CLAIM_TTL_MS / 60_000)} minutes without being renewed.`
  );
}
