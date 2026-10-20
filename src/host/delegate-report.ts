/**
 * The delegated engine's report, in a shape the host can check (INV-1261).
 *
 * An engine's completion event says it finished or failed; it does not say what it did or
 * why that counts. So the brief asks for a report in four parts — done, each item with
 * evidence that can be looked at; not done; problems; a verdict — and the host validates it
 * at the gate rather than reading the engine's last paragraph and guessing. The rule the
 * shape enforces, from agentic_factory: a claim by the coder is not evidence; a command's
 * output is, a path is, a diff is. `unknown` is never the engine's to say.
 *
 * Two ways in: the MCP face's `delegate_submit` tool (engines with an MCP client — the
 * report is checked while the run is still on, and a bad one is sent back to be redone),
 * or a file at `reportPath(jobId)` written before the run ends (engines without one — pi,
 * and mcode's one-shot form, which loads no MCP servers); the host reads and checks it when
 * the run settles, and a bad file is a missing report. Settling reads the report before the
 * completion event, records both when they disagree, and infers nothing.
 */
import { redactText } from "./secret-redaction.ts";

export type DelegateEvidence =
  | { kind: "command"; command: string; output: string }
  | { kind: "path"; path: string }
  | { kind: "diff"; summary: string };

export interface DelegateReport {
  done: { what: string; evidence: DelegateEvidence }[];
  not_done: { what: string; why?: string }[];
  problems: string[];
  verdict: "done" | "partial" | "failed";
}

/** Where an engine without an MCP client leaves its report, read when the job settles. */
export const REPORTS_DIR = "/home/box/work/.lumenbox/reports";
export function reportPath(jobId: string): string {
  return `${REPORTS_DIR}/${jobId}.json`;
}

const MAX_ITEMS = 32;
const MAX_TEXT = 2_000;
const MAX_TOTAL = 64 * 1024;
const VERDICTS = new Set(["done", "partial", "failed"]);

/** The report, checked; or every reason it is not one, so the engine can fix it in one go. */
export function validateDelegateReport(input: unknown): { report: DelegateReport } | { errors: string[] } {
  const errors: string[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { errors: ["the report must be a JSON object with done, not_done, problems and verdict"] };
  const raw = input as Record<string, unknown>;
  const text = (value: unknown, where: string, required = true): string | undefined => {
    if (typeof value !== "string" || value.trim() === "") {
      if (required) errors.push(`${where} must be a non-empty string`);
      return undefined;
    }
    if (value.length > MAX_TEXT) errors.push(`${where} is over ${MAX_TEXT} characters; cut it to the part that shows the point`);
    return redactText(value.slice(0, MAX_TEXT));
  };
  const items = (value: unknown, where: string): unknown[] => {
    if (!Array.isArray(value)) {
      errors.push(`${where} must be an array (empty is fine)`);
      return [];
    }
    if (value.length > MAX_ITEMS) errors.push(`${where} has ${value.length} items; at most ${MAX_ITEMS}`);
    return value.slice(0, MAX_ITEMS);
  };

  const done = items(raw.done, "done").map((entry, i) => {
    const where = `done[${i}]`;
    const record = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const what = text(record.what, `${where}.what`) ?? "";
    const evidenceRaw = (record.evidence !== null && typeof record.evidence === "object" ? record.evidence : undefined) as Record<string, unknown> | undefined;
    let evidence: DelegateEvidence | undefined;
    if (evidenceRaw === undefined) {
      errors.push(`${where}.evidence is missing: a claim is not evidence; give the command and its output, a path, or a diff summary`);
    } else if (evidenceRaw.kind === "command") {
      const command = text(evidenceRaw.command, `${where}.evidence.command`);
      const output = text(evidenceRaw.output, `${where}.evidence.output`);
      if (command !== undefined && output !== undefined) evidence = { kind: "command", command, output };
    } else if (evidenceRaw.kind === "path") {
      const path = text(evidenceRaw.path, `${where}.evidence.path`);
      if (path !== undefined) evidence = { kind: "path", path };
    } else if (evidenceRaw.kind === "diff") {
      const summary = text(evidenceRaw.summary, `${where}.evidence.summary`);
      if (summary !== undefined) evidence = { kind: "diff", summary };
    } else {
      errors.push(`${where}.evidence.kind must be command, path or diff`);
    }
    return { what, evidence: evidence ?? { kind: "path" as const, path: "" } };
  });
  const notDone = items(raw.not_done, "not_done").map((entry, i) => {
    const record = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const what = text(record.what, `not_done[${i}].what`) ?? "";
    const why = text(record.why, `not_done[${i}].why`, false);
    return { what, ...(why !== undefined ? { why } : {}) };
  });
  const problems = items(raw.problems, "problems").map((entry, i) => text(entry, `problems[${i}]`) ?? "");
  const verdict = typeof raw.verdict === "string" && VERDICTS.has(raw.verdict) ? (raw.verdict as DelegateReport["verdict"]) : undefined;
  if (verdict === undefined) errors.push("verdict must be done, partial or failed (unknown is the host's to say, not yours)");
  if (verdict === "done" && notDone.length > 0) errors.push("verdict done with items not done: say partial");
  if (verdict === "done" && done.length === 0) errors.push("verdict done with nothing in done: what was done, and what shows it?");
  const unknown = Object.keys(raw).filter(key => !["done", "not_done", "problems", "verdict"].includes(key));
  if (unknown.length > 0) errors.push(`unknown field(s): ${unknown.join(", ")}`);
  if (errors.length > 0) return { errors };
  const report: DelegateReport = { done, not_done: notDone, problems, verdict: verdict! };
  if (JSON.stringify(report).length > MAX_TOTAL) return { errors: [`the report is over ${MAX_TOTAL} bytes; keep outputs to the lines that show the point`] };
  return { report };
}

/** The report in a few lines, for the note the delegating agent gets. */
export function summariseReport(report: DelegateReport): string {
  const line = (entry: DelegateReport["done"][number]) => {
    const e = entry.evidence;
    const shown = e.kind === "command" ? `\`${e.command}\` → ${e.output.split("\n")[0]?.slice(0, 80) ?? ""}` : e.kind === "path" ? e.path : `diff: ${e.summary.slice(0, 80)}`;
    return `${entry.what} (${shown})`;
  };
  const parts = [
    `verdict ${report.verdict}`,
    report.done.length > 0 ? `done: ${report.done.map(line).join("; ")}` : "done: nothing",
    ...(report.not_done.length > 0 ? [`not done: ${report.not_done.map(entry => entry.why !== undefined ? `${entry.what} — ${entry.why}` : entry.what).join("; ")}`] : []),
    ...(report.problems.length > 0 ? [`problems: ${report.problems.join("; ")}`] : []),
  ];
  return parts.join(". ");
}

/** What the brief tells the engine about delivering the report, by the channel it has. */
export function deliveryInstructions(channel: "mcp" | "file", jobId: string): string {
  const shape =
    'a JSON object {"done":[{"what":"…","evidence":{"kind":"command","command":"…","output":"…"} | {"kind":"path","path":"…"} | {"kind":"diff","summary":"…"}}],' +
    '"not_done":[{"what":"…","why":"…"}],"problems":["…"],"verdict":"done"|"partial"|"failed"}';
  const rule = "Every done item needs evidence that can be looked at — a command and its output, a file path, or a diff summary; your own statement is not evidence. verdict done only when not_done is empty.";
  return channel === "mcp"
    ? `When you finish, deliver your report by calling the MCP tool \`delegate_submit\` with ${shape}. ${rule} If the tool answers with errors, fix the report and call it again; the run is not complete until it accepts.`
    : `When you finish, write your report to ${reportPath(jobId)} (create the directory if needed) as ${shape}. ${rule} The host reads and checks that file when you exit; a missing or malformed file counts as no report.`;
}

/**
 * The outcome, with the report read first and the engine's event second (INV-1261). The
 * report's verdict decides when the two agree or the event has nothing to say; when they
 * contradict each other — the report says done, the event says failed, or the reverse — the
 * outcome is unknown and the sentence names both, because inferring which to trust is the
 * thing this exists to stop doing.
 */
export function judgeWithReport(
  engine: { outcome: "done" | "failed" | "aborted" | "unknown"; why: string },
  report: DelegateReport | undefined
): { outcome: "done" | "failed" | "aborted" | "unknown"; why: string } {
  // No report: a failure or a stop stands on the event alone, but a "done" with no report is a
  // claim with nothing behind it, which is unknown, not done.
  if (report === undefined) {
    return engine.outcome === "done"
      ? { outcome: "unknown", why: `${engine.why}, but it delivered no report — a completion claim with no evidence is not a result` }
      : { outcome: engine.outcome, why: `${engine.why}; no report was delivered` };
  }
  const fromReport = report.verdict === "failed" ? "failed" : "done";
  const partial = report.verdict === "partial" ? ` (partial: ${report.not_done.length} not done)` : "";
  if (engine.outcome === "aborted") return { outcome: "aborted", why: `${engine.why}; the engine had delivered a report saying ${report.verdict}${partial}` };
  if (engine.outcome === "unknown" || engine.outcome === fromReport) {
    return { outcome: fromReport, why: `the engine's report says ${report.verdict}${partial}, with ${report.done.length} done item(s) carrying evidence` };
  }
  return {
    outcome: "unknown",
    why: `the engine's report says ${report.verdict}${partial} but its completion event says ${engine.outcome} (${engine.why}); both are recorded and neither is taken over the other`,
  };
}

