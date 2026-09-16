/**
 * What was decided, written down when it was decided (INV-551, docs/54 §B3).
 *
 * The live test that produced this file: a person asked an agent on a work item *why it
 * had judged something*, and the agent — correctly — answered that it had nothing to go
 * on and asked for a link. Nothing was wrong with the agent. Nothing had been written
 * down at the time, so there was nothing to read back, and the only alternatives were an
 * honest "I cannot recover it" or a fluent invention. The red team's phrasing was exact:
 * the problem is not how to deliver the question to the agent, it is whether anything was
 * recorded that could answer it.
 *
 * A receipt is deliberately small and deliberately *not* a transcript:
 *
 *   - **Subject** is a stable key somebody can look up later — `task:t12`,
 *     `inv:INV-553`, `question:q3` — not a sentence.
 *   - **Decision** is what was done, in one line.
 *   - **Because** is the reason *as stated at the time*. Absent is a fact too: it means
 *     nobody wrote one, and the honest answer three months later is "the record does not
 *     show why", never a reconstruction presented as memory.
 *   - **Evidence** are pointers that still resolve: run ids, PR urls, a conversation.
 *
 * Its own append-only file, not the transcript and not the task history: transcripts are
 * compacted, task history is capped at the last N changes, and both are shaped for
 * reading a story rather than for answering "why". A receipt has to outlive them.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";

export interface Receipt {
  at: string;
  /** Who decided: an agent id, `aging`, `web:<principal>`, `host`. */
  by: string;
  byName?: string;
  /** A stable key: `task:t12`, `inv:INV-553`, `question:q3`, `routine:weekly-retro`. */
  subject: string;
  /** What was decided, in one line. */
  decision: string;
  /** The reason as it was stated then. Absent means nobody wrote one. */
  because?: string;
  /** Pointers that still resolve: run ids, PR urls, a conversation id. */
  evidence?: string[];
  /** Where to find the turn this happened in. */
  conversation?: string;
}

const MAX_LINE = 2_000;

export class Receipts {
  constructor(private readonly path: string | null) {}

  /** Records one judgement. Never throws: a decision is not undone by a full disk. */
  write(receipt: Receipt): void {
    if (this.path === null) return;
    const line = {
      ...receipt,
      decision: receipt.decision.slice(0, 300),
      ...(receipt.because !== undefined ? { because: receipt.because.slice(0, 600) } : {}),
      ...(receipt.evidence !== undefined && receipt.evidence.length > 0
        ? { evidence: receipt.evidence.map(item => item.slice(0, 300)).slice(0, 8) }
        : {}),
    };
    try {
      appendLine(this.path, JSON.stringify(line).slice(0, MAX_LINE));
    } catch {
      // Logged by whoever later finds nothing here; losing a receipt must not lose the
      // decision it describes.
    }
  }

  /** Everything recorded about one subject, oldest first. */
  forSubject(subject: string, limit = 20): Receipt[] {
    return this.read().filter(receipt => receipt.subject === subject).slice(-limit);
  }

  /** The most recent receipts, newest last, for a person or a page. */
  recent(limit = 50): Receipt[] {
    return this.read().slice(-limit);
  }

  private read(): Receipt[] {
    if (this.path === null || !existsSync(this.path)) return [];
    const out: Receipt[] = [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return out;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as Receipt;
        if (typeof parsed.subject === "string" && typeof parsed.decision === "string") out.push(parsed);
      } catch {
        // One torn line does not hide the rest.
      }
    }
    return out;
  }
}

/**
 * What an agent should be told about a subject before it answers "why did you decide X".
 *
 * The shape matters: each line says when, who, what, and — separately — whether a reason
 * was recorded. A missing `because` is printed as such rather than omitted, because the
 * difference between "decided for this reason" and "decided, reason not written down" is
 * the difference between an answer and a guess.
 */
export function describeReceipts(receipts: readonly Receipt[]): string {
  if (receipts.length === 0) return "";
  const lines = receipts.map(receipt => {
    const when = receipt.at.slice(0, 16).replace("T", " ");
    const who = receipt.byName ?? receipt.by;
    const why = receipt.because === undefined ? "(no reason was written down at the time)" : receipt.because;
    const where = receipt.evidence !== undefined && receipt.evidence.length > 0 ? ` [${receipt.evidence.join(", ")}]` : "";
    return `- ${when} ${who}: ${receipt.decision} — ${why}${where}`;
  });
  return `What was written down at the time:\n${lines.join("\n")}`;
}
