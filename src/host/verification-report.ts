/**
 * A verification report with its recording (INV-1925, docs/101).
 *
 * A member writes the plan first (scenarios, each with the facts it will observe), starts recording
 * its own desktop, checks each assertion as it goes and finishes with a conclusion. The host stamps
 * every check with the moment it arrived and its offset into the recording, so where an assertion
 * sits on the timeline is not the model's to say. The box only records; the report lives on the
 * host beside the task board, and the video stays in the box under its retention (INV-1949).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { outcomeLine } from "../protocol/index.ts";
import type { AttentionItem } from "./attention.ts";
import type { TaskStore } from "./tasks.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";

export const VERIFY_TOOL = "Verify";
/** Reports kept per member; older ones go when a new one is planned. */
export const REPORTS_KEPT_PER_MEMBER = 200;
const TEXT_MAX = 600;
const SCENARIOS_MAX = 20;
const ASSERTIONS_MAX = 30;

export interface Assertion {
  id: string;
  /** The fact to observe, written down before it was looked at. */
  fact: string;
  result?: "pass" | "fail";
  observed?: string;
  at?: string;
  /** Milliseconds into the recording, by the host's clock. */
  offsetMs?: number;
}

export interface VerificationScenario {
  id: string;
  name: string;
  assertions: Assertion[];
}

export interface VerificationReport {
  id: string;
  agentId: string;
  agentName: string;
  conversation: string;
  taskId?: string;
  title: string;
  /** The commit or build being verified. */
  version: string;
  state: "planned" | "recording" | "finished" | "abandoned";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  recording?: { file: string; display: number };
  scenarios: VerificationScenario[];
  conclusion?: string;
}

export interface ReportCounts {
  passed: number;
  failed: number;
  unchecked: number;
}

/** Always counted from the assertions, never stored. */
export function reportCounts(report: Pick<VerificationReport, "scenarios">): ReportCounts {
  const all = report.scenarios.flatMap(scenario => scenario.assertions);
  return {
    passed: all.filter(item => item.result === "pass").length,
    failed: all.filter(item => item.result === "fail").length,
    unchecked: all.filter(item => item.result === undefined).length,
  };
}

/** Where a board keeps its reports: beside the board's own file, like its deliverables. */
export function reportsDir(tasksFile: string): string {
  return join(dirname(tasksFile), "verification-reports");
}

export class VerificationReports {
  constructor(readonly dir: string) {}

  get(id: string): VerificationReport | undefined {
    if (!/^vr-[a-f0-9]{8}$/.test(id)) return undefined;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as VerificationReport;
    } catch {
      return undefined;
    }
  }

  save(report: VerificationReport): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${report.id}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  /** A member's reports, newest first. */
  list(agentId: string): VerificationReport[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(name => /^vr-[a-f0-9]{8}\.json$/.test(name))
      .map(name => this.get(name.slice(0, -5)))
      .filter((report): report is VerificationReport => report !== undefined && report.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** The member's report still being written in this conversation, if any. */
  open(agentId: string, conversation: string): VerificationReport | undefined {
    return this.list(agentId).find(report => report.conversation === conversation && (report.state === "planned" || report.state === "recording"));
  }

  /** Drops the oldest past `keep`; answers how many went. */
  prune(agentId: string, keep = REPORTS_KEPT_PER_MEMBER): number {
    const old = this.list(agentId).slice(keep);
    for (const report of old) unlinkSync(join(this.dir, `${report.id}.json`));
    return old.length;
  }

  /** Every finished report, newest first. */
  finished(): VerificationReport[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter(name => /^vr-[a-f0-9]{8}\.json$/.test(name))
      .map(name => this.get(name.slice(0, -5)))
      .filter((report): report is VerificationReport => report?.state === "finished")
      .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
  }
}

/** On the person's "needs you": the latest finished report on each task waiting for review, failures first. */
export function reportAttention(reports: VerificationReports, tasks: Pick<TaskStore, "get">, mayRead: (agentId: string) => boolean): AttentionItem[] {
  const seen = new Set<string>();
  const items: (AttentionItem & { failed: number })[] = [];
  for (const report of reports.finished()) {
    if (report.taskId === undefined || seen.has(report.taskId) || !mayRead(report.agentId)) continue;
    seen.add(report.taskId);
    if (tasks.get(report.taskId)?.status !== "review") continue;
    const counts = reportCounts(report);
    items.push({
      kind: "verification", ref: report.id, with: report.agentName, failed: counts.failed,
      title: `${report.agentName} verified ${report.taskId}: ${report.title}`,
      detail: `${counts.passed} passed · ${counts.failed} failed${counts.unchecked ? ` · ${counts.unchecked} not checked` : ""} — ${report.conclusion ?? ""}`.slice(0, 300),
    });
  }
  return items.sort((a, b) => b.failed - a.failed).map(({ failed: _failed, ...item }) => item);
}

export function withVerifyTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: VERIFY_TOOL,
    description:
      "Verify a piece of work on your desktop and hand the person a report with a recording. In order: " +
      "`plan` (title, the version you are verifying, and scenarios, each with the facts you will observe, written " +
      "before you look); `start` (records your desktop); `check` once per assertion as you observe it (pass or fail, " +
      "and what you actually saw); `finish` with a conclusion (what passed first, then what failed and what you saw). " +
      "The host notes when each check happened, so check right after you observe, not at the end. The person gets a " +
      "card with the counts and a page that plays the recording at each assertion. `abandon` drops an unfinished report.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["plan", "start", "check", "finish", "abandon"] },
        title: { type: "string", description: "plan: what is being verified, one line." },
        version: { type: "string", description: "plan: the commit, build or version verified." },
        scenarios: {
          type: "array",
          description: "plan: each scenario and the facts to observe in it.",
          items: {
            type: "object",
            properties: { name: { type: "string" }, assertions: { type: "array", items: { type: "string" } } },
            required: ["name", "assertions"],
          },
        },
        assertion: { type: "string", description: "check: the assertion's id from the plan, e.g. \"s1.a2\"." },
        result: { type: "string", enum: ["pass", "fail"], description: "check: what the observation showed." },
        observed: { type: "string", description: "check: the fact you actually saw, in one or two sentences." },
        conclusion: { type: "string", description: "finish: what passed, then what failed and what was seen." },
      },
      required: ["action"],
    },
  } as never);
}

function refused(reason: string): ToolOutcome {
  return { text: outcomeLine("refused", reason), isError: true };
}

function line(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

/** The card the conversation shows: built here from the report, so its numbers are not the model's. */
export function reportCard(report: VerificationReport): Record<string, unknown>[] {
  const counts = reportCounts(report);
  return [
    { id: "root", component: "Column", children: ["head", "stats", "conclusion", "open"] },
    { id: "head", component: "Text", text: `${report.title} · ${report.version}` },
    { id: "stats", component: "Row", children: ["passed", "failed", "unchecked"] },
    { id: "passed", component: "Stat", label: "Passed", value: String(counts.passed), tone: "ok" },
    { id: "failed", component: "Stat", label: "Failed", value: String(counts.failed), tone: counts.failed > 0 ? "danger" : "neutral" },
    { id: "unchecked", component: "Stat", label: "Not checked", value: String(counts.unchecked), tone: counts.unchecked > 0 ? "warn" : "neutral" },
    { id: "conclusion", component: "Callout", tone: counts.failed > 0 ? "danger" : "ok", title: "Conclusion", text: report.conclusion ?? "" },
    { id: "open", component: "Link", text: "Open the report and its recording", to: report.id },
  ];
}

function storeOf(context: ToolContext): VerificationReports | undefined {
  const path = context.tasks?.path;
  return path ? new VerificationReports(reportsDir(path)) : undefined;
}

export async function verifyTool(context: ToolContext, input: Record<string, unknown>, now: () => Date = () => new Date()): Promise<ToolOutcome> {
  const store = storeOf(context);
  if (store === undefined) return refused("there is no task board here to keep a report beside");
  const conversation = context.conversation ?? "main";
  const open = store.open(context.agent.id, conversation);
  const action = String(input.action ?? "");

  if (action === "plan") {
    if (open !== undefined) return refused(`report ${open.id} is still ${open.state}; finish or abandon it first`);
    const title = line(input.title), version = line(input.version);
    if (title === "") return refused("title says in one line what is being verified");
    if (version === "") return refused("version names the commit, build or version being verified");
    const raw = Array.isArray(input.scenarios) ? input.scenarios : [];
    if (raw.length === 0 || raw.length > SCENARIOS_MAX) return refused(`scenarios is a list of 1 to ${SCENARIOS_MAX} scenarios`);
    const scenarios: VerificationScenario[] = [];
    for (const [index, item] of raw.entries()) {
      const scenario = (item ?? {}) as { name?: unknown; assertions?: unknown };
      const name = line(scenario.name);
      const facts = (Array.isArray(scenario.assertions) ? scenario.assertions : []).map(line).filter(fact => fact !== "");
      if (name === "") return refused(`scenario ${index + 1} needs a name`);
      if (facts.length === 0 || facts.length > ASSERTIONS_MAX) return refused(`scenario "${name}" needs 1 to ${ASSERTIONS_MAX} facts to observe`);
      const id = `s${index + 1}`;
      scenarios.push({ id, name, assertions: facts.map((fact, at) => ({ id: `${id}.a${at + 1}`, fact })) });
    }
    const taskId = context.taskBinding?.taskId;
    const report: VerificationReport = {
      id: `vr-${randomBytes(4).toString("hex")}`,
      agentId: context.agent.id,
      agentName: context.agent.profile.name,
      conversation,
      ...(taskId !== undefined ? { taskId } : {}),
      title,
      version,
      state: "planned",
      createdAt: now().toISOString(),
      scenarios,
    };
    store.save(report);
    store.prune(context.agent.id);
    const ids = scenarios.map(scenario => `${scenario.id} ${scenario.name}: ${scenario.assertions.map(item => item.id).join(", ")}`).join("; ");
    return { text: `Planned ${report.id}. Assertions: ${ids}. Now Verify start, then check each one as you observe it.` };
  }

  if (open === undefined) return refused("there is no report being written here; Verify plan first");

  if (action === "abandon") {
    if (open.state === "recording" && context.box !== undefined) await context.box.stopRecording(open.recording?.display).catch(() => undefined);
    store.save({ ...open, state: "abandoned", finishedAt: now().toISOString() });
    return { text: `Abandoned ${open.id}.` };
  }

  if (action === "start") {
    if (open.state === "recording") return refused(`${open.id} is already recording`);
    if (context.box === undefined) return refused("there is no box to record a desktop on");
    const display = context.displayIndex ?? 0;
    try {
      await context.ensureDesktop?.();
      const recording = await context.box.startRecording({ display, name: `verify-${open.id}` });
      store.save({ ...open, state: "recording", startedAt: now().toISOString(), recording: { file: recording.file, display: recording.display } });
    } catch (error) {
      return { text: outcomeLine("failed", `the recording did not start (${error instanceof Error ? error.message : String(error)})`), isError: true };
    }
    return { text: `Recording your desktop for ${open.id}. Do each scenario and Verify check each assertion right after you observe it.` };
  }

  if (open.state !== "recording") return refused(`${open.id} is not recording yet; Verify start first`);

  if (action === "check") {
    const id = line(input.assertion);
    const result: Assertion["result"] = input.result === "pass" || input.result === "fail" ? input.result : undefined;
    const observed = line(input.observed);
    const target = open.scenarios.flatMap(scenario => scenario.assertions).find(item => item.id === id);
    if (target === undefined) return refused(`there is no assertion ${id || "(none given)"} in ${open.id}`);
    if (result === undefined) return refused("result is pass or fail");
    if (observed === "") return refused("observed says what you actually saw");
    const at = now();
    const offsetMs = Math.max(0, at.getTime() - Date.parse(open.startedAt ?? at.toISOString()));
    const scenarios = open.scenarios.map(scenario => ({
      ...scenario,
      assertions: scenario.assertions.map((item): Assertion => (item.id === id ? { ...item, result, observed, at: at.toISOString(), offsetMs } : item)),
    }));
    store.save({ ...open, scenarios });
    const counts = reportCounts({ scenarios });
    return { text: `${id} ${result === "pass" ? "passed" : "failed"}. ${counts.unchecked} left to check.` };
  }

  if (action === "finish") {
    const conclusion = line(input.conclusion);
    if (conclusion === "") return refused("conclusion says what passed, then what failed and what was seen");
    if (context.box !== undefined) await context.box.stopRecording(open.recording?.display).catch(() => undefined);
    const report: VerificationReport = { ...open, state: "finished", finishedAt: now().toISOString(), conclusion };
    store.save(report);
    const counts = reportCounts(report);
    const shown = context.showUI === undefined ? undefined : await context.showUI({
      ...(context.caller?.userId !== undefined ? { principalId: context.caller.userId } : {}),
      agentId: context.agent.id, agentName: context.agent.profile.name, conversation,
      surface: `verify-${report.id}`, title: `Verification: ${report.title}`, components: reportCard(report),
      ...(context.work ? { work: context.work } : {}),
    });
    const where = shown === undefined || "error" in shown ? "" : ` The card is shown ${shown.where}.`;
    return { text: `Finished ${report.id}: ${counts.passed} passed, ${counts.failed} failed, ${counts.unchecked} not checked.${where} The report page is /verification/${report.id}.` };
  }

  return refused("action is plan, start, check, finish or abandon");
}
