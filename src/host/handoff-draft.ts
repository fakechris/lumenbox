/**
 * A handoff prepared ahead of a /new (INV-1190).
 *
 * The steward writes a draft while the conversation is idle; a person's /new installs it as
 * the new epoch's opening — but only if the draft still describes the context the person is
 * leaving. The snapshot is captured from the writer's actual input, before any await, and is
 * stored unchanged: refreshing it after the note was written would label an old note with a
 * newer conversation's identity (review round 3).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ContextMode } from "../agents/context-epoch.ts";

/** What a draft was written from. Any field differing later means the draft is stale. */
export interface ContextSnapshot {
  epoch: number;
  mode: ContextMode;
  transcriptLength: number;
  tailHash: string;
  durableHash: string;
}

export interface HandoffDraft {
  snapshot: ContextSnapshot;
  /** The opening entry, as one JSONL line, ready to become entry 0 of the next epoch. */
  opening: string;
  sha256: string;
  createdAt: string;
}

export type DraftLookup =
  | { status: "valid"; opening: string }
  | { status: "stale"; reason: string };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The current context's identity, read synchronously. */
export function snapshotOf(registry: AgentRegistry, agentId: string, conversation: string): ContextSnapshot {
  const store = registry.contextStore(agentId, conversation);
  const { epoch, mode } = store.current();
  const transcript = registry.readTranscript(agentId, conversation);
  return {
    epoch,
    mode,
    transcriptLength: transcript.length,
    tailHash: hash(JSON.stringify(transcript.at(-1) ?? null)),
    durableHash: hash(JSON.stringify(registry.readDurableState(agentId, conversation))),
  };
}

function draftPath(registry: AgentRegistry, agentId: string, conversation: string, epoch: number): string {
  return join(registry.contextStore(agentId, conversation).root, "drafts", `${epoch}.json`);
}

const sameSnapshot = (a: ContextSnapshot, b: ContextSnapshot): string | undefined => {
  if (a.epoch !== b.epoch) return "the conversation already moved to another context";
  if (a.mode !== b.mode) return "the context mode changed";
  if (a.transcriptLength !== b.transcriptLength || a.tailHash !== b.tailHash) return "the conversation went on after it was written";
  if (a.durableHash !== b.durableHash) return "the plan or todos changed after it was written";
  return undefined;
};

/**
 * Stores a draft against the snapshot captured before it was written. Refuses (returns false)
 * when the context has already moved on since that capture: an old note is never saved as current.
 */
export function writeHandoffDraft(
  registry: AgentRegistry,
  agentId: string,
  conversation: string,
  captured: ContextSnapshot,
  opening: string
): boolean {
  if (sameSnapshot(captured, snapshotOf(registry, agentId, conversation)) !== undefined) return false;
  const path = draftPath(registry, agentId, conversation, captured.epoch);
  mkdirSync(join(path, ".."), { recursive: true });
  const draft: HandoffDraft = { snapshot: captured, opening, sha256: hash(opening), createdAt: new Date().toISOString() };
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return true;
}

/**
 * The draft for the context being left, if there is one: valid only when it was written from
 * exactly this context. Read synchronously inside /new, after its other checks.
 */
export function readHandoffDraft(registry: AgentRegistry, agentId: string, conversation: string): DraftLookup | undefined {
  const now = snapshotOf(registry, agentId, conversation);
  const path = draftPath(registry, agentId, conversation, now.epoch);
  if (!existsSync(path)) return undefined;
  let draft: HandoffDraft;
  try {
    draft = JSON.parse(readFileSync(path, "utf8")) as HandoffDraft;
  } catch {
    return { status: "stale", reason: "the prepared handoff could not be read" };
  }
  if (typeof draft.opening !== "string" || hash(draft.opening) !== draft.sha256) {
    return { status: "stale", reason: "the prepared handoff is damaged" };
  }
  const differs = sameSnapshot(draft.snapshot, now);
  return differs === undefined ? { status: "valid", opening: draft.opening } : { status: "stale", reason: differs };
}
