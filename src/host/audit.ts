/**
 * The audit: what turns "the assignee says done" into "done".
 *
 * The board's review gate already enforces that an assignee cannot accept its own
 * work; what was missing is the review itself as a mechanism rather than a hope.
 * This module holds the pieces: the prompt that sends a reviewer agent to audit a
 * task, how its reply settles the task (parsed by the goal gate's parser, failing
 * closed), and the workspace
 * snapshot that makes "read-only" a checked property instead of a convention —
 * a reviewer that edits the work is no longer reviewing it, and the failure is
 * not that it would cheat but that "fixed it" and "checked it" become the same
 * act with nobody able to tell which happened.
 *
 * The protocol is natural language with exactly three parsed header lines, on
 * purpose: prose is where audit evidence lives, and a reviewer forced to emit
 * JSON spends its care on syntax. (The shape follows the reference design in
 * research/LONGHORIZON-HARNESS-COMPARISON.md.)
 */

import { type ChecklistItem, type GoalVerdict, parseGoalVerdict } from "./goal-mode.ts";
import type { Task } from "./tasks.ts";

/**
 * What the auditor is asked to judge item by item: the task's acceptance criteria as one
 * checklist item, when the requester wrote any. The goal gate's parser reads it back, so an
 * ordinary audit and a goal verification are one protocol with one parser (INV-817).
 */
export function auditChecklist(task: Pick<Task, "contract">): ChecklistItem[] {
  const acceptance = task.contract?.acceptance;
  return acceptance === undefined ? [] : [{ id: "acceptance", text: acceptance }];
}

/**
 * What the auditor's reply means for the task. Fails closed: a reply the parser cannot read
 * is not a pass, and the task does not move forward on it — it stays where it was, with a
 * note saying the audit gave no verdict, for the person to read. A parsed rejection sends the
 * work back to doing with the findings; a parsed pass leaves it in review, because done is the
 * requester's word and the audit only made that word safe.
 */
export function settleAudit(
  task: Pick<Task, "contract">,
  reply: string
): { status: "review" | "doing"; note: string; verdict: GoalVerdict | undefined } {
  const verdict = parseGoalVerdict(reply, auditChecklist(task));
  if (verdict === undefined) {
    return { status: "review", note: "audit gave no verdict (reply did not follow the protocol); not accepted — a person decides", verdict };
  }
  if (!verdict.passed) {
    const items = verdict.items.filter(item => item.verdict !== "proven").map(item => `${item.id} ${item.verdict}${item.evidence !== undefined ? ` (${item.evidence})` : ""}`);
    return {
      status: "doing",
      note: `audit did not pass${items.length > 0 ? `: ${items.join("; ")}` : ""}${verdict.nextAction !== undefined ? ` — next: ${verdict.nextAction}` : ""}`,
      verdict,
    };
  }
  return { status: "review", note: "audit passed: complete and clean; awaiting the requester's acceptance", verdict };
}

/**
 * The prompt that sends a reviewer to audit a claimed-done task.
 *
 * The load-bearing sentences, each here because its absence has a known failure:
 * re-derive the constraints from the original request (auditing against the
 * assignee's summary audits the summary); a populated field or an open file is
 * not completion (the consumed final state is); do not modify files (the
 * snapshot outside this prompt checks it anyway); move the task at the end
 * (an audit that reports into the void changes nothing).
 */
export function buildAuditPrompt(input: {
  task: Task;
  assigneeName: string;
  conversation?: string;
}): string {
  const where =
    input.conversation !== undefined
      ? `conversation "${input.conversation}"`
      : "the main conversation";
  const acceptance = input.task.contract?.acceptance;
  const checklist = auditChecklist(input.task);
  return [
    `Audit task ${input.task.id}: "${input.task.title}", which ${input.assigneeName} claims is done.`,
    "",
    // The standard before the work (docs/20 §3): an auditor that reads the history first
    // derives the criteria from what was done, and then everything done meets them.
    ...(acceptance !== undefined
      ? [`Acceptance criteria, in the requester's words — judge against these first:\n${acceptance}`, ""]
      : []),
    `Read their work with ReadHistory (${where}) and reproduce the step that matters yourself ` +
      "rather than trusting their account of it — the failure you exist to catch is the one " +
      "where a step looked like it worked and did not.",
    "",
    "Re-derive the acceptance constraints from the original request below, independently, and " +
      "check the work against those — not against the assignee's summary of them. A populated " +
      "field, a correct preview, an open file are not completion; the consumed final state is. " +
      "If several candidate artifacts exist, prove the right one is the one that counts.",
    "",
    "Do not modify any files. An audit that edits the work is void, and the workspace is " +
      "checked for changes after your turn.",
    "",
    "Reply with exactly these three header lines first, then your evidence in prose — what you " +
      "verified, what you could not, what is wrong:",
    "Status: complete|incomplete|blocked",
    "Integrity: clean|suspect",
    "Contract audit: aligned|needs_revision|unknown",
    ...checklist.map(item => `Item ${item.id}: proven|contradicted|incomplete|unverified — one line of evidence`),
    "Next action: what the assignee should do next, or none",
    "",
    "The host reads those lines, not your prose: a reply without them counts as no verdict, " +
      "and no verdict is not a pass.",
    "",
    "Finally, move the task with the Tasks tool. If your own headers say complete and clean, " +
      "add a note saying what you verified and LEAVE IT IN REVIEW — done is the requester's " +
      "word, not yours; they accept in the chat, and your job was to make that acceptance " +
      "safe. Otherwise move it back to doing, with a note quoting your findings so the " +
      "assignee knows exactly what to fix.",
    "",
    `Original request: ${input.task.description ?? input.task.title}`,
  ].join("\n");
}

/**
 * A workspace manifest: path → sha256, from one shell invocation in the box.
 *
 * `find | sort | xargs sha256sum` rather than anything cleverer, because the box
 * is a real Linux and the property needed is only "did anything change between
 * two moments". The chats/ tree is excluded — the channel file exchange writes
 * there during ordinary delivery, and an audit must not be invalidated by an
 * inbox arriving.
 */
export const MANIFEST_COMMAND =
  "find /home/box/work -path /home/box/work/chats -prune -o -type f -print0 2>/dev/null " +
  "| sort -z | xargs -0 -r sha256sum 2>/dev/null";

export function parseManifest(stdout: string): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match !== null) manifest.set(match[2]!, match[1]!);
  }
  return manifest;
}

/** Paths that differ between two manifests — added, removed, or rewritten. */
export function manifestDiff(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(path);
  }
  return changed.sort();
}
