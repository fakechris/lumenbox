/**
 * What a delegated engine said about its own run, and the outcome the host records (INV-908).
 *
 * The host used to read a delegation's outcome from the job's exit code alone, and an exit code
 * is not a report: pi 0.85.1 exits 0 on a provider 400 and prints nothing, and Claude Code
 * 2.1.250 reports a 400 in a `result` frame whose subtype is "success" and whose `is_error` is
 * true. So the outcome comes from the engine's own completion event, read from its
 * machine-readable output; without one, it is unknown, never inferred from the exit code.
 *
 * Shapes measured against a stub model server on the pinned versions (docs/25 §INV-908):
 * - claude `-p --output-format stream-json --verbose`: the last `{"type":"result"}` frame.
 * - pi `-p --mode json`: the last `{"type":"agent_end"}`, whose last assistant message carries
 *   `stopReason` ("stop", "error", "aborted") and `errorMessage`.
 * - opencode `run --format json`: `{"type":"error"}` events, and `step_finish` parts whose
 *   `reason` is "stop" on the step that ended the run.
 */

import type { BoxClient } from "../box/client.ts";
import type { OpenFork, PendingWork } from "./pending-work.ts";
import { quoteForShell } from "./presets.ts";

export { MACHINE_OUTPUT } from "./presets.ts";

export type EngineName = "claude" | "pi" | "opencode";

export interface EngineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What the host records for a delegation. Only the engine's report can make it `done`. */
export type DelegateOutcome = "done" | "failed" | "aborted" | "unknown";

export interface EngineReport {
  engine: EngineName;
  /** The engine's own word: it finished, it failed, or it was stopped short (a turn or budget limit). */
  status: "completed" | "failed" | "aborted";
  /** Why, in the engine's words, when it was not completed. */
  detail?: string;
  /** The answer, as the engine gave it last. */
  finalText?: string;
  /**
   * Tokens as the engine counted them, cache reads and writes apart from fresh input (they are
   * usually most of it). Absent when it said nothing, which is not zero.
   */
  usage?: EngineUsage;
  sessionId?: string;
  /** The engine refused to resume the thread it was given (Claude: "No conversation found"). */
  resumeFailed?: boolean;
}

function events(log: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) parsed.push(value as Record<string, unknown>);
    } catch {
      // A line the engine did not write as an event (a warning on the same stream) is not one.
    }
  }
  return parsed;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function claudeReport(all: Record<string, unknown>[]): EngineReport | undefined {
  const result = all.filter(event => event.type === "result").at(-1);
  if (result === undefined) return undefined;
  const subtype = str(result.subtype);
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
  const usage = result.usage as Record<string, unknown> | undefined;
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  const cacheRead = num(usage?.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(usage?.cache_creation_input_tokens) ?? 0;
  const failed = result.is_error === true || (subtype !== undefined && subtype !== "success");
  // A limit the run was given, reached: stopped short rather than broken.
  const stopped = subtype === "error_max_turns" || subtype === "error_max_budget_usd";
  const detail = errors.length > 0 ? errors.join("; ") : str(result.result) ?? subtype;
  return {
    engine: "claude",
    status: !failed ? "completed" : stopped ? "aborted" : "failed",
    ...(failed && detail !== undefined ? { detail } : {}),
    ...(!failed && str(result.result) !== undefined ? { finalText: str(result.result)! } : {}),
    ...(input !== undefined && output !== undefined ? { usage: { input, output, cacheRead, cacheWrite } } : {}),
    ...(str(result.session_id) !== undefined ? { sessionId: str(result.session_id)! } : {}),
    ...(errors.some(error => /No conversation found with session ID/i.test(error)) ? { resumeFailed: true } : {}),
  };
}

function piReport(all: Record<string, unknown>[]): EngineReport | undefined {
  const end = all.filter(event => event.type === "agent_end").at(-1);
  if (end === undefined) return undefined;
  const messages = Array.isArray(end.messages) ? (end.messages as Record<string, unknown>[]) : [];
  const assistant = messages.filter(message => message?.role === "assistant");
  const last = assistant.at(-1);
  const stopReason = str(last?.stopReason);
  // Every attempt's tokens: after an automatic retry pi starts a new agent_end, which holds only
  // the retried loop, so usage is summed over every assistant message_end instead.
  const total: EngineUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let counted = false;
  for (const event of all) {
    const message = event.type === "message_end" ? (event.message as Record<string, unknown> | undefined) : undefined;
    if (message?.role !== "assistant") continue;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (num(usage?.input) === undefined || num(usage?.output) === undefined) continue;
    total.input += num(usage!.input)!;
    total.output += num(usage!.output)!;
    total.cacheRead += num(usage!.cacheRead) ?? 0;
    total.cacheWrite += num(usage!.cacheWrite) ?? 0;
    counted = true;
  }
  const text = Array.isArray(last?.content)
    ? (last!.content as Record<string, unknown>[]).filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("")
    : undefined;
  const session = all.find(event => event.type === "session");
  const status: EngineReport["status"] = stopReason === "error" ? "failed" : stopReason === "aborted" ? "aborted" : last === undefined ? "failed" : "completed";
  return {
    engine: "pi",
    status,
    ...(status !== "completed" ? { detail: str(last?.errorMessage) ?? (last === undefined ? "the run ended without an answer" : `stopped: ${stopReason}`) } : {}),
    ...(status === "completed" && str(text) !== undefined ? { finalText: text! } : {}),
    ...(counted ? { usage: total } : {}),
    ...(str(session?.id) !== undefined ? { sessionId: str(session!.id)! } : {}),
  };
}

function opencodeReport(all: Record<string, unknown>[]): EngineReport | undefined {
  const mine = all.filter(event => typeof event.sessionID === "string");
  if (mine.length === 0) return undefined;
  const error = mine.filter(event => event.type === "error").at(-1);
  const part = (event: Record<string, unknown>) => (event.part ?? {}) as Record<string, unknown>;
  const finishes = mine.filter(event => event.type === "step_finish");
  const total: EngineUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let counted = false;
  for (const finish of finishes) {
    const tokens = part(finish).tokens as Record<string, unknown> | undefined;
    if (num(tokens?.input) === undefined || num(tokens?.output) === undefined) continue;
    const cache = (tokens!.cache ?? {}) as Record<string, unknown>;
    total.input += num(tokens!.input)!;
    total.output += num(tokens!.output)!;
    total.cacheRead += num(cache.read) ?? 0;
    total.cacheWrite += num(cache.write) ?? 0;
    counted = true;
  }
  const usage = counted ? { usage: total } : {};
  const sessionId = { sessionId: String(mine[0]!.sessionID) };
  if (error !== undefined) {
    const body = (error.error ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    return { engine: "opencode", status: "failed", detail: str(data.message) ?? str(body.name) ?? "error", ...usage, ...sessionId };
  }
  // The run is over when its last step stopped for good; a last step that ended on tool calls
  // is a run cut off in the middle, which is no completion report at all.
  if (str(part(finishes.at(-1) ?? {}).reason) !== "stop") return undefined;
  const text = mine.filter(event => event.type === "text").map(event => String(part(event).text ?? "")).join("");
  return { engine: "opencode", status: "completed", ...(text !== "" ? { finalText: text } : {}), ...usage, ...sessionId };
}

/** The engine's completion report in its log, if it wrote one. */
export function parseEngineReport(engine: EngineName, log: string): EngineReport | undefined {
  const all = events(log);
  return engine === "claude" ? claudeReport(all) : engine === "pi" ? piReport(all) : opencodeReport(all);
}

/** The engine a preset name is, when it is one whose report the host reads. */
export function engineNamed(preset: string | undefined): EngineName | undefined {
  return preset === "claude" || preset === "pi" || preset === "opencode" ? preset : undefined;
}

/**
 * The outcome to record, and the sentence that says where it came from. The engine's report
 * decides; the exit code is kept as evidence and decides only a failure nothing contradicts.
 */
export function judgeDelegate(input: {
  exitCode: number | undefined;
  interrupted?: boolean;
  /** The job was stopped by a kill. */
  killed?: boolean;
  report: EngineReport | undefined;
  /** Why there is no report, as a clause, when it is not simply that the engine wrote none. */
  missing?: string;
}): { outcome: DelegateOutcome; why: string } {
  const exit = input.exitCode === undefined ? "no exit code" : `exit code ${input.exitCode}`;
  const report = input.report;
  if (report !== undefined) {
    const said = `${report.engine} reported`;
    if (report.status === "completed") return { outcome: "done", why: `${said} it completed (${exit})` };
    if (report.status === "aborted") return { outcome: "aborted", why: `${said} it stopped short: ${report.detail ?? "no reason given"} (${exit})` };
    return { outcome: "failed", why: `${said} a failure: ${report.detail ?? "no reason given"} (${exit})` };
  }
  if (input.killed === true) return { outcome: "aborted", why: "it was stopped before it finished" };
  if (input.interrupted === true) return { outcome: "unknown", why: "the box daemon restarted under it, so how it ended is not known" };
  const missing = input.missing ?? "the engine gave no completion report";
  if (input.exitCode !== undefined && input.exitCode !== 0) return { outcome: "failed", why: `${missing}, and it exited with ${input.exitCode}` };
  return { outcome: "unknown", why: `${missing}, so the ${exit} says nothing about whether it did the work` };
}

/** How many lines from the end of a log to read: every engine writes its report last. */
const REPORT_LINES = 400;
/** How many bytes from the end, when the box can run a command: under exec's 2 MB output cap. */
const REPORT_BYTES = 1_500_000;

/**
 * The end of a job's log, read through the box. Two reads — the length, then the tail — because
 * the daemon's own job tail is 8 KB, and Claude's `result` line carries the whole final answer.
 */
export async function readLogEnd(
  box: Pick<BoxClient, "readFile"> & Partial<Pick<BoxClient, "exec">>,
  logPath: string
): Promise<{ text: string } | { unreadable: string }> {
  // By bytes first: the daemon refuses to read a file over 8 MB at all, and a long stream-json
  // run passes that. The first line of the tail may be cut, and the parser skips it.
  if (box.exec !== undefined) {
    try {
      const tail = await box.exec(`tail -c ${REPORT_BYTES} -- ${quoteForShell(logPath)}`, { timeoutMs: 15_000 });
      if (tail.exit_code === 0) return { text: tail.stdout };
    } catch {
      // Fall through to the line read, which says why when it fails too.
    }
  }
  try {
    const head = await box.readFile(logPath, { startLine: 1, endLine: 1 });
    const total = (head as { total_lines?: number }).total_lines ?? 1;
    const tail = await box.readFile(logPath, { startLine: Math.max(1, total - REPORT_LINES + 1), endLine: total });
    return { text: String((tail as { content?: unknown }).content ?? "") };
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/** What `settleDelegate` needs: the ledger, the box the job ran in, and the engine threads. */
export interface SettleDeps {
  pendingWork: Pick<PendingWork, "open" | "commitDelegate"> | undefined;
  box: (Pick<BoxClient, "readFile"> & Partial<Pick<BoxClient, "exec">>) | undefined;
  /** Forget a thread the engine could not resume, with the reason (DelegateSessions). */
  dropSession?: (id: string, reason: string) => void;
}

export interface Settled {
  open: OpenFork;
  outcome: DelegateOutcome;
  why: string;
  report?: EngineReport;
}

/**
 * Settles a delegated job that has ended, if its record is still open: reads the engine's report
 * from the end of its log, judges, records the outcome and why, and forgets a thread the engine
 * refused to resume. The one place a delegation's outcome is decided; every observer of a job's
 * end calls it, and the first to commit wins. Returns undefined when nothing was open.
 */
export async function settleDelegate(
  deps: SettleDeps,
  job: { job_id: string; exit_code?: number; interrupted?: boolean; log_path?: string },
  options: { killed?: boolean } = {}
): Promise<Settled | undefined> {
  const open = deps.pendingWork?.open().find(work => work.kind === "delegate" && work.child === job.job_id);
  if (open === undefined) return undefined;
  const engine = engineNamed(typeof open.data?.engine === "string" ? open.data.engine : undefined);
  let report: EngineReport | undefined;
  let missing: string | undefined;
  if (engine === undefined) missing = "the engine that ran it writes no report this host reads";
  else if (job.log_path === undefined || deps.box === undefined) missing = "its log could not be reached";
  else {
    const read = await readLogEnd(deps.box, job.log_path);
    if ("text" in read) report = parseEngineReport(engine, read.text);
    else missing = `its log could not be read (${read.unreadable})`;
  }
  const judged = judgeDelegate({
    exitCode: job.exit_code,
    ...(job.interrupted === true ? { interrupted: true } : {}),
    ...(options.killed === true ? { killed: true } : {}),
    report,
    ...(missing !== undefined ? { missing } : {}),
  });
  if (report?.resumeFailed === true && report.sessionId !== undefined) {
    deps.dropSession?.(report.sessionId, report.detail ?? "the engine could not resume it");
  }
  const committed = deps.pendingWork!.commitDelegate(job.job_id, judged.outcome, {
    why: judged.why,
    ...(report?.usage !== undefined ? { usage: { ...report.usage, source: "engine-report" as const } } : {}),
  });
  if (!committed) return undefined;
  return { open, ...judged, ...(report !== undefined ? { report } : {}) };
}

/** The note the agent that delegated gets when the job ends: what happened, and on whose word. */
export function delegateEndedNote(jobId: string, brief: string, settled: Pick<Settled, "outcome" | "why">): string {
  const what = `${jobId} (${brief.slice(0, 120)})`;
  switch (settled.outcome) {
    case "done":
      return `[A job you delegated finished: ${what}. ${capitalize(settled.why)}. Read its output with Jobs and fold the result into your work, or say why it does not matter.]`;
    case "failed":
      return `[A job you delegated failed: ${what}. ${capitalize(settled.why)}. Do not use its output as a result; read its log to see what went wrong, then fix the cause or say what is blocked.]`;
    case "aborted":
      return `[A job you delegated was stopped before it finished: ${what}. ${capitalize(settled.why)}. What it left is partial; check it before relying on any of it.]`;
    default:
      return `[A job you delegated ended, and whether it did the work is unknown: ${what}. ${capitalize(settled.why)}. Read its log before you use anything from it, and say what you found.]`;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
