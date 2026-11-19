/**
 * Who opened a turn in the record, decided from what was written at the door (INV-1808).
 *
 * The transcript is written for the model. Its `fromPerson` stamp was derived from the shape of
 * the message that opened the turn, and for a long time a host prompt had that shape: audits until
 * 2026-11-04, first-run and template cues until INV-829, routines before the synthetic flag. A
 * backfill that believed the stamp restored 643 audit prompts out of 784 candidates as requests a
 * person had made. So the stamp is a claim to be checked, never the proof.
 *
 * The proof is ingress evidence, keyed by the message ids a turn cites in `causedBy`:
 *   - the door's ledger (`messages.jsonl`): a line is written when a chat door lets a person's
 *     message in, with the channel, the chat and who sent it;
 *   - the heard record (`heard/<agent>.jsonl`): written by the bus when a turn takes its messages,
 *     with the sender as the host knew it.
 * Where neither exists the answer is `unknown`, and it stays unknown until a person says otherwise.
 * What the text reads like is offered to that person as a note; it never decides. A person quoting
 * an audit's wording is still a person, and a host prompt with a person's stamp is still the host.
 */

import type { HeardRow } from "../agents/heard-record.ts";
import type { MessageRecord } from "../channels/messages.ts";
import { beforeWake, type HistoryEntry } from "./compaction.ts";
import { type ChannelId, entryChannel } from "./model-text.ts";

/** Read-only views of the two ingress records. */
export interface IngressEvidence {
  /** The door's line for a message id, or undefined when no door let it in. */
  door(id: string): MessageRecord | undefined;
  /** What the bus knew about a message when an agent started on it, or undefined from before that record. */
  heard(agentId: string, id: string): HeardRow | undefined;
}

/** No evidence at all: every stamped entry is `unknown`. For callers and tests that have none to offer. */
export const NO_EVIDENCE: IngressEvidence = { door: () => undefined, heard: () => undefined };

export type OpeningEntry = HistoryEntry & { causedBy?: readonly string[]; turnId?: string };

export type Provenance =
  | {
      by: "person";
      evidence: "door" | "heard";
      /** The person's words: as the door kept them, whole; else their part of the turn's text. */
      text: string;
      /** The ids the evidence covers, in the order the turn cites them. */
      sourceIds: string[];
      /** The principal the bus admitted it under, when the heard record has one. Never invented. */
      principal?: string;
      channel?: string;
      chatKey?: string;
      identity?: string;
    }
  | { by: "host"; why: string }
  | {
      by: "unknown";
      why: string;
      text: string;
      sourceIds: string[];
      /** What the channel table makes of the text. A note for the person deciding, not a decision. */
      reads: ChannelId;
    };

/**
 * The one decision. `entry` is a plain user-role transcript entry; anything else is the host's.
 *
 * Order matters and is the whole rule: evidence that a person sent it, then evidence that the host
 * did, then the absence of any claim, and only then the unverified claim — which is `unknown`.
 */
export function openingProvenance(agentId: string, entry: OpeningEntry, evidence: IngressEvidence): Provenance {
  if ("kind" in entry || entry.role !== "user") return { by: "host", why: "not a message that opens a turn" };
  const sourceIds = [...new Set(entry.causedBy ?? [])];
  const reads = entryChannel(entry);
  const doors = sourceIds.flatMap(id => { const row = evidence.door(id); return row === undefined ? [] : [row]; });
  if (doors.length > 0) {
    const first = doors[0]!;
    const principal = doors.map(row => evidence.heard(agentId, row.id)?.speaker).find(speaker => speaker?.by === "person" && speaker.principal !== undefined);
    return {
      by: "person", evidence: "door", text: doors.map(row => row.text).join("\n\n"), sourceIds: doors.map(row => row.id),
      ...(principal?.by === "person" && principal.principal !== undefined ? { principal: principal.principal } : {}),
      channel: first.channel, chatKey: first.chatKey, identity: first.identity,
    };
  }
  const heard = sourceIds.map(id => ({ id, row: evidence.heard(agentId, id) }));
  // Until INV-829 a cue opened its turn the way a person's message does, and was heard as theirs.
  const persons = reads === "cue" ? [] : heard.filter(item => item.row?.speaker.by === "person");
  if (persons.length > 0) {
    const principal = persons.map(item => item.row!.speaker).find(speaker => speaker.by === "person" && speaker.principal !== undefined);
    return {
      by: "person", evidence: "heard", text: beforeWake(entry.text), sourceIds: persons.map(item => item.id),
      ...(principal?.by === "person" && principal.principal !== undefined ? { principal: principal.principal } : {}),
    };
  }
  if (entry.host === true) return { by: "host", why: "stamped by the host when it was written" };
  if (sourceIds.length > 0 && heard.every(item => item.row !== undefined) && reads !== "cue") return { by: "host", why: `heard from ${[...new Set(heard.map(item => item.row!.speaker.by))].join(", ")}` };
  if (entry.fromPerson !== true) return { by: "host", why: "the turn was never recorded as a person's" };
  return {
    by: "unknown", text: beforeWake(entry.text), sourceIds, reads,
    why: sourceIds.length === 0 ? "stamped as a person's, and cites no message to check it against" : "stamped as a person's, and no door or heard record has its message",
  };
}
