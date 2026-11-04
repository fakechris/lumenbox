/**
 * What went wrong in an agent's real sessions, for its check-up (INV-1575).
 *
 * `agentbox improve` imagines situations from the agent's definition and sees how it does. What it
 * could not see is what already went wrong in use, and that is written down: in the agent's own
 * records. This reads them — deterministically, no model — and names five kinds of failure:
 *
 * - **correction**: a person, right after a reply, says it was wrong ("不对", "我说的是…", "no, …");
 * - **refusal**: a tool result the policy refused ("Refused by rule …", "Refused: this command …");
 * - **retry**: the same tool with the same input three or more times in a row;
 * - **stopped**: a person stopped the turn ("A person stopped this turn …");
 * - **rejected**: the goal gate turned down a completion claim, or handed the goal to a person.
 *
 * Each case keeps where it is (conversation and time) so a person can read it in the record, and
 * the message that led to it, so the worst can be replayed as check-up scenarios.
 */

export type FailureKind = "correction" | "refusal" | "retry" | "stopped" | "rejected";
export const FAILURE_KINDS: readonly FailureKind[] = ["correction", "refusal", "retry", "stopped", "rejected"];

export interface FailureCase {
  kind: FailureKind;
  conversation: string;
  at: string;
  /** What shows the failure, cut short. */
  excerpt: string;
  /** The last message from a person or teammate before it: the situation to replay. */
  request: string;
  /** For ordering within a kind: a retry's repeat count; otherwise 1. */
  weight: number;
}

export interface SessionFailures {
  since: string;
  counts: Record<FailureKind, number>;
  cases: FailureCase[];
}

interface Entry {
  role?: string;
  kind?: string;
  text?: string;
  at?: string;
  blocks?: { type?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; text?: string }[];
}

const CORRECTION = /^\s*(不对|错了|不是这样|不是这个|你理解错|理解错了|我说的是|我的意思是|重新来|还是不对|还是错|搞错了|no[,.!]|nope\b|wrong\b|that'?s not\b|not what i\b|i said\b|try again\b|still (wrong|not)\b|actually,)/i;
const REFUSAL = /^Refused\b|Refused by rule\b|\bA person declined\b|\bwas declined by\b/;
const STOPPED = /A person stopped this turn/;
const REJECTED = /完成申请没有通过验证|验证连续 \d+ 次没通过/;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map(part => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join(" ") : "";
const cut = (text: string, n = 200) => text.replace(/\s+/g, " ").trim().slice(0, n);
/** A message a person or teammate sent: not a host note, a job notice or the record's own markers. */
const isRequest = (entry: Entry) => entry.role === "user" && entry.kind === undefined && typeof entry.text === "string" && !/^\s*(<host_notification|\[A command|\[Summary of|\[newer message\])/.test(entry.text);
const fromPerson = (entry: Entry) => isRequest(entry) && !/^\s*\[agent\]/.test(entry.text!);

/** The failures in `conversations` since `since`, counted by kind, each with where it is and what led to it. */
export function mineSessionFailures(conversations: readonly { conversation: string; entries: readonly unknown[] }[], since: Date): SessionFailures {
  const cases: FailureCase[] = [];
  const after = since.toISOString();
  for (const { conversation, entries } of conversations) {
    let request = "";
    let repliedSinceRequest = false;
    let lastCall: { key: string; count: number; at: string; name: string } | undefined;
    const closeRun = () => {
      if (lastCall !== undefined && lastCall.count >= 3) cases.push({ kind: "retry", conversation, at: lastCall.at, excerpt: `${lastCall.name} called ${lastCall.count} times in a row with the same input`, request, weight: lastCall.count });
      lastCall = undefined;
    };
    for (const raw of entries) {
      const entry = raw as Entry;
      const at = entry.at ?? "";
      const recent = at >= after;
      if (isRequest(entry)) {
        closeRun();
        if (recent && fromPerson(entry) && repliedSinceRequest && CORRECTION.test(entry.text!)) cases.push({ kind: "correction", conversation, at, excerpt: cut(entry.text!), request, weight: 1 });
        if (recent && REJECTED.test(entry.text!)) cases.push({ kind: "rejected", conversation, at, excerpt: cut(entry.text!), request, weight: 1 });
        request = cut(entry.text!, 2000);
        repliedSinceRequest = false;
        continue;
      }
      if (entry.role === "user" && entry.kind === undefined && typeof entry.text === "string" && recent && REJECTED.test(entry.text)) {
        cases.push({ kind: "rejected", conversation, at, excerpt: cut(entry.text), request, weight: 1 });
        continue;
      }
      if (entry.role === "assistant") {
        if (entry.kind === undefined || (entry.blocks ?? []).some(block => block.type === "text" && (block.text ?? "").trim() !== "")) repliedSinceRequest = true;
        for (const block of entry.blocks ?? []) {
          if (block.type !== "tool_use") continue;
          const key = `${block.name}\u0000${JSON.stringify(block.input ?? null)}`;
          if (lastCall !== undefined && lastCall.key === key) lastCall.count += 1;
          else { closeRun(); if (recent) lastCall = { key, count: 1, at, name: String(block.name) }; }
        }
        continue;
      }
      if (entry.kind === "results" && recent) {
        for (const block of entry.blocks ?? []) {
          const text = textOf(block.content);
          if (STOPPED.test(text)) cases.push({ kind: "stopped", conversation, at, excerpt: cut(text), request, weight: 1 });
          else if (REFUSAL.test(text)) cases.push({ kind: "refusal", conversation, at, excerpt: cut(text), request, weight: 1 });
        }
      }
    }
    closeRun();
  }
  const counts = Object.fromEntries(FAILURE_KINDS.map(kind => [kind, cases.filter(c => c.kind === kind).length])) as Record<FailureKind, number>;
  // Within a kind: the heaviest first, then the most recent.
  cases.sort((a, b) => FAILURE_KINDS.indexOf(a.kind) - FAILURE_KINDS.indexOf(b.kind) || b.weight - a.weight || (a.at < b.at ? 1 : -1));
  return { since: after, counts, cases };
}

/** The worst cases to replay as check-up scenarios: one per kind first, then by weight; only ones with a request to replay. */
export function replayable(failures: SessionFailures, max = 4): FailureCase[] {
  const withRequest = failures.cases.filter(c => c.request.trim() !== "");
  const picked: FailureCase[] = [];
  for (const kind of FAILURE_KINDS) { const first = withRequest.find(c => c.kind === kind); if (first !== undefined && picked.length < max) picked.push(first); }
  for (const c of withRequest) if (picked.length < max && !picked.includes(c)) picked.push(c);
  return picked;
}

/** The report section: counts by kind and a few references per kind a person can find in the record. */
export function renderSessionFailures(failures: SessionFailures, perKind = 3): string {
  const lines = [`## From real sessions (since ${failures.since.slice(0, 10)})`, "", FAILURE_KINDS.map(kind => `${kind} ${failures.counts[kind]}`).join(" · "), ""];
  for (const kind of FAILURE_KINDS) {
    const shown = failures.cases.filter(c => c.kind === kind).slice(0, perKind);
    if (shown.length === 0) continue;
    lines.push(`### ${kind}`, "", ...shown.map(c => `- ${c.conversation} · ${c.at.slice(0, 19).replace("T", " ")} — ${c.excerpt}${c.request ? `\n  after: "${cut(c.request, 120)}"` : ""}`), "");
  }
  return lines.join("\n");
}
