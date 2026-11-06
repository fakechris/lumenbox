/**
 * What a sensing routine found, as a proposal on the board (INV-1652).
 *
 * Everything on the board used to start from a person or a timer waking an agent to do
 * something. A sensing routine is the other direction: an agent looks around on a schedule —
 * the board's stalled tasks, the work kernel's ready queue, a repository's open requests, the
 * chats it can read — and writes what it found as *proposals*: a to-do, a problem, an
 * opportunity, a decision somebody has to make. A proposal is not work until a person commits
 * it (the board's Commit button, INV-120 of the task store), which is the inbox's gate.
 *
 * Two facts make it tolerable rather than a second noise source: every proposal names its
 * source and the evidence it rests on, and the same finding is never proposed twice — a
 * fingerprint of source and finding is kept on the task, and a dismissed one stays dismissed.
 */

import { createHash } from "node:crypto";

export type DiscoveryKind = "todo" | "problem" | "opportunity" | "decision";
export const DISCOVERY_KINDS: readonly DiscoveryKind[] = ["todo", "problem", "opportunity", "decision"];

export interface Discovery {
  kind: DiscoveryKind;
  /** Where it was seen: a URL, a task id, a chat, a work item. */
  source: string;
  /** The one line of evidence the finding rests on. */
  evidence: string;
  /** Why it is worth raising now rather than later. */
  whyNow?: string;
  /** Of the source and the finding: the same finding is proposed once. */
  fingerprint: string;
}

/** The schema fragment the Tasks tool spreads into its properties. */
export const DISCOVERY_FIELDS = {
  discovery_kind: { type: "string", enum: [...DISCOVERY_KINDS], description: "For create, from a sensing routine: what you found — a todo, a problem, an opportunity, or a decision somebody must make. Makes the task a proposal a person commits." },
  source: { type: "string", description: "With discovery_kind: where you saw it — a URL, a task id, a chat, a work item." },
  evidence: { type: "string", description: "With discovery_kind: the one line of evidence it rests on, quoted or paraphrased." },
  why_now: { type: "string", description: "With discovery_kind: why it is worth raising now, in one sentence." },
} as const;

/** The same source and the same finding give the same fingerprint, whatever the wording around them. */
export function discoveryFingerprint(source: string, evidence: string): string {
  const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${norm(source)}\u0000${norm(evidence)}`).digest("hex").slice(0, 16);
}

export function parseDiscovery(input: Record<string, unknown>): Discovery | undefined {
  const kind = input.discovery_kind;
  if (typeof kind !== "string" || !(DISCOVERY_KINDS as readonly string[]).includes(kind)) return undefined;
  const source = String(input.source ?? "").trim().slice(0, 300);
  const evidence = String(input.evidence ?? "").trim().slice(0, 500);
  if (source === "" || evidence === "") return undefined;
  const whyNow = typeof input.why_now === "string" && input.why_now.trim() !== "" ? input.why_now.trim().slice(0, 300) : undefined;
  return { kind: kind as DiscoveryKind, source, evidence, ...(whyNow !== undefined ? { whyNow } : {}), fingerprint: discoveryFingerprint(source, evidence) };
}

/** One line for the row and the agent's reply: kind, source, and why now. */
export function describeDiscovery(discovery: Discovery): string {
  return `${discovery.kind} from ${discovery.source}${discovery.whyNow !== undefined ? ` — ${discovery.whyNow}` : ""}`;
}
