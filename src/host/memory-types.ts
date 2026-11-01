/**
 * What a memory is like, as four scores that may each be high (INV-1472): a remembered event, a
 * fact about the world, how something is done, what somebody prefers. `kind` says where a line
 * came from; this says what it is for, so a request about how to do a thing can lean toward the
 * procedural lines and one about taste toward the preferences. Absent on lines from before, and
 * on lines the judge did not score, which read as equal on every axis.
 */

import { envNumber } from "../config.ts";

export type MemoryTypeName = "episodic" | "semantic" | "procedural" | "preference";
export type MemoryTypes = Record<MemoryTypeName, number>;
export const MEMORY_TYPE_NAMES: readonly MemoryTypeName[] = ["episodic", "semantic", "procedural", "preference"];

/** The questions, asked of a memory line at write and of the reply to a message at select. */
export const TYPE_INSTRUCTIONS: Record<MemoryTypeName, (it: string) => string> = {
  episodic: it => `Is ${it} about something that happened — an event, an exchange, a thing done at a time?`,
  semantic: it => `Is ${it} a fact about the world or the person's situation that stays true on its own?`,
  procedural: it => `Is ${it} about how to do something — steps, a method, a command, a convention to follow?`,
  preference: it => `Is ${it} about what the person likes, wants, avoids or how they want things done?`,
};

/**
 * How much the request's type profile and the memory's agree, 0..1: the dot product over the four
 * axes, normalised (INV-1472). A memory without scores, or a request without them, is 0.5 —
 * neither favoured nor held back. The weight `MEMORY_TYPE_WEIGHT` scales it into a selection
 * score as `score × (1 + weight × (affinity − 0.5) × 2)`; at 0 nothing changes.
 */
export const MEMORY_TYPE_WEIGHT = envNumber("AGENTBOX_MEMORY_TYPE_WEIGHT", 0.2);

export function typeAffinity(record: { types?: MemoryTypes }, request: MemoryTypes | undefined): number {
  if (record.types === undefined || request === undefined) return 0.5;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (const name of MEMORY_TYPE_NAMES) {
    dot += record.types[name] * request[name];
    a += record.types[name] ** 2;
    b += request[name] ** 2;
  }
  return a === 0 || b === 0 ? 0.5 : dot / Math.sqrt(a * b);
}

/** A selection probability leaned by the type affinity; identity at weight 0. */
export function leanedByType(p: number, record: { types?: MemoryTypes }, request: MemoryTypes | undefined, weight = MEMORY_TYPE_WEIGHT): number {
  return p * (1 + weight * (typeAffinity(record, request) - 0.5) * 2);
}
