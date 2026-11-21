/**
 * Who judged, and what it read: the provenance every verdict of the product's judges is written
 * with (INV-1773).
 *
 * Four judges run in the product: the auto-review of binding tool calls (auto-review.ts), the
 * answer review of replies (answer-review.ts), the memory judge of candidate memories
 * (memory-judge.ts), and the decision model (jev.ts), which answers in place of any of them where
 * its switch is on and beside them where it is in shadow. Changing the judge changes the verdict,
 * so a verdict that does not name its judge cannot be held against a person's label later. Every
 * line those judges write now carries:
 *
 *   - `judge` — which of the four gave the answer acted on;
 *   - `judgeModel` — the model, as its provider or the decision model named it;
 *   - `judgeVersion` — a digest of the words it was asked with: a reworded prompt is another judge;
 *   - `question` — `<judge>:<question>`, the yes-or-no a person labels (QUESTIONS below);
 *   - `evidence` — what it read, by name, and the digest of the judged output a label is matched
 *     to. Never the text: the ledgers keep the hashes they kept before.
 *
 * Each question is put so that "yes" is the failure the judge acts on — the shape the evaluation's
 * judges and labels already have (src/evals/judges.ts, calibration.ts), so one label format and one
 * kappa serve both.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivedLines } from "./jsonl.ts";

export type JudgeName = "auto-review" | "answer-review" | "memory-judge" | "jev";

/** One verdict as a person labels it: the question, the judge's answer, and the output it was about. */
export interface Judged {
  question: string;
  verdict: "present" | "absent" | "invalid";
  digest: string;
}

/** The four fields INV-1773 asks every verdict to carry, and the judge they belong to. */
export interface JudgeProvenance {
  judge: JudgeName;
  judgeModel: string;
  judgeVersion: string;
  question: string;
  evidence: { read: readonly string[]; digest: string };
}

/**
 * What a judge's verdict measures. `satisfaction` is a judgement made from the chat alone — the
 * request and the reply — and says whether the reply looks like it serves the person, not whether
 * the work was done; it is kept out of anything that counts work as completed. A judge that reads
 * the tool calls and the state they left behind (auto-review) is not that.
 */
export type Dimension = "authorisation" | "satisfaction" | "memory";

export interface QuestionInfo {
  judge: Exclude<JudgeName, "jev">;
  dimension: Dimension;
  /** What the judge reads, by name, as `evidence.read` records it. */
  read: readonly string[];
  /** Whether the labelling page can show a person what was judged (judge-sheet.ts says how). */
  labellable: boolean;
}

/** The questions, by the name a verdict and a label carry. The decision model answers the same ones. */
export const QUESTIONS: Readonly<Record<string, QuestionInfo>> = {
  "auto-review:unauthorised": { judge: "auto-review", dimension: "authorisation", read: ["the person's words", "operator rules", "the agent's words", "the call"], labellable: true },
  "answer-review:not-answered": { judge: "answer-review", dimension: "satisfaction", read: ["the request", "the reply"], labellable: true },
  "memory-judge:fromContent": { judge: "memory-judge", dimension: "memory", read: ["the candidate", "known memories", "the conversation"], labellable: true },
  "memory-judge:narrowsRules": { judge: "memory-judge", dimension: "memory", read: ["the candidate", "known memories", "the conversation"], labellable: true },
  // Answerable only beside the line the candidate was compared with, which is not kept with the verdict: recorded, never put to a person.
  "memory-judge:contradicts": { judge: "memory-judge", dimension: "memory", read: ["the candidate", "known memories", "the conversation"], labellable: false },
  "memory-judge:duplicate": { judge: "memory-judge", dimension: "memory", read: ["the candidate", "known memories", "the conversation"], labellable: false },
};

/** The ledgers verdicts are written to, under ~/.agentbox. */
export const JUDGE_LEDGERS = {
  "auto-review": "auto-review.jsonl",
  "answer-review": "answer-review.jsonl",
  "memory-judge": "memory-judge.jsonl",
  shadow: "jev-shadow.jsonl",
} as const;

/** The judge named on a record: the point's own, or the decision model when it answered. */
export function provenanceOf(
  question: string,
  by: { path: "own"; model: string; version: string } | { path: "jev"; model: string; version: string },
  digest: string
): JudgeProvenance {
  const info = QUESTIONS[question];
  if (info === undefined) throw new Error(`no judge question ${question}`);
  return { judge: by.path === "jev" ? "jev" : info.judge, judgeModel: by.model, judgeVersion: by.version, question, evidence: { read: info.read, digest } };
}

/** A verdict read back from a ledger, whichever judge wrote it: what calibration and the labelling page work from. */
export interface ProductVerdict extends Judged {
  judge: JudgeName;
  judgeModel: string;
  judgeVersion: string;
  at: string;
  agent: string;
  /** Where the judged text can be found again, if it is kept anywhere (judge-sheet.ts). */
  locate: { ledger: keyof typeof JUDGE_LEDGERS; messageId?: string; conversation?: string; callId?: string; tool?: string };
}

function lines(path: string): Record<string, unknown>[] {
  const live = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  return [...archivedLines(path), ...live].flatMap(line => {
    if (line.trim() === "") return [];
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed !== null && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
    } catch {
      return []; // a torn last line is not a record
    }
  });
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const isVerdict = (value: unknown): value is Judged["verdict"] => value === "present" || value === "absent" || value === "invalid";
const isJudge = (value: unknown): value is JudgeName => value === "auto-review" || value === "answer-review" || value === "memory-judge" || value === "jev";

/**
 * Every verdict on this installation that names its judge, oldest first. A line written before
 * INV-1773 names none and is left out: it cannot be held against a label, because nothing says
 * which judge gave it. The decision model's shadow answers count as its own verdicts — a label is
 * about an output, so the same label checks the point's judge and the decision model on it.
 */
export function readVerdicts(home: string): ProductVerdict[] {
  const out: ProductVerdict[] = [];
  for (const ledger of ["auto-review", "answer-review", "memory-judge"] as const) {
    for (const row of lines(join(home, JUDGE_LEDGERS[ledger]))) {
      const evidence = row.evidence as { digest?: unknown } | undefined;
      const question = text(row.question), model = text(row.judgeModel), version = text(row.judgeVersion), digest = text(evidence?.digest), at = text(row.at);
      if (!isJudge(row.judge) || question === undefined || model === undefined || version === undefined || digest === undefined || at === undefined || !isVerdict(row.judged)) continue;
      out.push({
        judge: row.judge, judgeModel: model, judgeVersion: version, question, verdict: row.judged, digest, at, agent: text(row.agent) ?? "",
        locate: {
          ledger, ...(text(row.messageId) !== undefined ? { messageId: text(row.messageId)! } : {}), ...(text(row.conversation) !== undefined ? { conversation: text(row.conversation)! } : {}),
          ...(text(row.callId) !== undefined ? { callId: text(row.callId)! } : {}), ...(text(row.tool) !== undefined ? { tool: text(row.tool)! } : {}),
        },
      });
    }
  }
  for (const row of lines(join(home, JUDGE_LEDGERS.shadow))) {
    const model = text(row.judgeModel), version = text(row.judgeVersion), at = text(row.at);
    if (model === undefined || version === undefined || at === undefined || !Array.isArray(row.judged)) continue;
    for (const one of row.judged as Partial<Judged>[]) {
      if (typeof one?.question !== "string" || typeof one.digest !== "string" || !isVerdict(one.verdict)) continue;
      out.push({ judge: "jev", judgeModel: model, judgeVersion: version, question: one.question, verdict: one.verdict, digest: one.digest, at, agent: text(row.agent) ?? "", locate: { ledger: "shadow" } });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
