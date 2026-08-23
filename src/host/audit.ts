/**
 * The audit: what turns "the assignee says done" into "done".
 *
 * The board's review gate already enforces that an assignee cannot accept its own
 * work; what was missing is the review itself as a mechanism rather than a hope.
 * This module holds the pieces: the three-line report protocol an auditor answers
 * in, the prompt that sends a reviewer agent to audit a task, and the workspace
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

import type { Task } from "./tasks.ts";

export interface AuditReport {
  status: "complete" | "incomplete" | "blocked";
  integrity: "clean" | "suspect";
  contract: "aligned" | "needs_revision" | "unknown";
  body: string;
}

/**
 * Reads an audit report's three header lines, or nothing when they are malformed.
 * The headers may sit after preamble prose — models narrate — but must appear in
 * order, each on its own line.
 */
export function parseAuditReport(text: string): AuditReport | undefined {
  const status = /^Status:\s*(complete|incomplete|blocked)\s*$/im.exec(text)?.[1];
  const integrity = /^Integrity:\s*(clean|suspect)\s*$/im.exec(text)?.[1];
  const contract = /^Contract audit:\s*(aligned|needs_revision|unknown)\s*$/im.exec(text)?.[1];
  if (status === undefined || integrity === undefined || contract === undefined) return undefined;
  return {
    status: status.toLowerCase() as AuditReport["status"],
    integrity: integrity.toLowerCase() as AuditReport["integrity"],
    contract: contract.toLowerCase() as AuditReport["contract"],
    body: text,
  };
}

/** Whether a report justifies calling the task done. The completion guard's rule. */
export function auditAccepts(report: AuditReport): boolean {
  return report.status === "complete" && report.integrity === "clean" && report.contract !== "needs_revision";
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
  return [
    `Audit task ${input.task.id}: "${input.task.title}", which ${input.assigneeName} claims is done.`,
    "",
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
    "",
    "Finally, move the task with the Tasks tool: to done only if your own headers say complete " +
      "and clean; otherwise back to doing, with a note quoting your findings so the assignee " +
      "knows exactly what to fix.",
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
