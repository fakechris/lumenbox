/** A check spends authority granted for one user goal, never authority inferred from a card move. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { evidenceDigest } from "./review-dispatch.ts";
import type { Task } from "./tasks.ts";
import type { ProviderProfile } from "./provider.ts";
import { configuredRates } from "./provider-fallback.ts";
import type { Rates } from "./spend.ts";
export const LEDGER_KIND: LedgerKind = "record";

export interface FileCheck {
  path: string;
  sha256: string;
  acceptance: string;
}
export type ResultCheckPolicy =
  | { mode: "manual" }
  | { mode: "files"; reason: string; files: FileCheck[] }
  | {
      mode: "model";
      reason: string;
      acceptance: string;
      paths: string[];
      reviewers: number;
      maxRounds: number;
      maxDispatches: number;
      maxCalls: number;
      maxMs: number;
      maxCost: number;
    };
interface CheckPlan {
  id: string;
  taskId: string;
  digest: string;
  goal: string;
  reviewers: string[];
  at: string;
  deadline: number;
  phase: "running" | "stopped";
  reason?: string;
}
interface CheckAccount {
  key: string;
  taskId: string;
  goal: string;
  by: string;
  policy: ResultCheckPolicy;
  rounds: number;
  dispatches: number;
  calls: number;
  reservedCost: number;
  startedAt?: number;
  plans: CheckPlan[];
}
export interface CheckSnapshot {
  policy: ResultCheckPolicy;
  rounds: number;
  dispatches: number;
  calls: number;
  reservedCost: number;
  startedAt?: number;
  plans: readonly CheckPlan[];
}
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const effectivePlan = (plan: CheckPlan, now: number): CheckPlan =>
  plan.phase === "running" && plan.deadline <= now
    ? { ...plan, phase: "stopped", reason: "The check's cumulative time allowance is exhausted." }
    : plan;
const keyOf = (task: Task) => task.workRoot?.state.id ?? task.id;
export const checkGoal = (task: Task): string =>
  hash([
    task.id,
    task.title,
    task.description,
    task.contract,
    task.workRoot?.state.id,
    task.workRoot?.state.generation,
    task.workRoot?.state.epoch,
  ]);
const finite = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;
const pathAllowed = (path: unknown): path is string =>
  typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..") && !/[\0\r\n]/.test(path) && path.length < 1000;

export function parseCheckPolicy(raw: unknown): ResultCheckPolicy {
  const row = raw as ResultCheckPolicy;
  if (row?.mode === "manual") return { mode: "manual" };
  if (!row || !("reason" in row) || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 1000)
    throw new Error("A check requires a concrete reason tied to the user's goal.");
  if (
    row.mode === "files" &&
    Array.isArray(row.files) &&
    row.files.length > 0 &&
    row.files.length <= 30 &&
    row.files.every(
      file =>
        pathAllowed(file.path) &&
        /^[a-f0-9]{64}$/.test(file.sha256) &&
        typeof file.acceptance === "string" &&
        file.acceptance.trim().length > 0 &&
        file.acceptance.length <= 1000,
    )
  )
    return structuredClone(row);
  if (
    row.mode === "model" &&
    typeof row.acceptance === "string" &&
    row.acceptance.trim() &&
    row.acceptance.length <= 1000 &&
    Array.isArray(row.paths) &&
    row.paths.length <= 30 &&
    row.paths.every(pathAllowed) &&
    [row.reviewers, row.maxRounds, row.maxDispatches, row.maxCalls, row.maxMs].every(Number.isInteger) &&
    finite(row.reviewers, 8) &&
    finite(row.maxRounds, 10) &&
    finite(row.maxDispatches, 32) &&
    finite(row.maxCalls, 100) &&
    finite(row.maxMs, 600_000) &&
    finite(row.maxCost, 100)
  )
    return structuredClone(row);
  throw new Error("Invalid check policy: provide finite limits, acceptance and exact read-only evidence paths.");
}

export class ResultChecks {
  private readonly accounts = new Map<string, CheckAccount>();
  constructor(
    private readonly path?: string,
    private readonly now = () => Date.now(),
    private readonly rates: () => Rates = configuredRates,
  ) {
    if (path && existsSync(path))
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { schema: string; account: CheckAccount };
        if (row.schema !== "result-check/v1" || !row.account?.key || !Array.isArray(row.account.plans))
          throw new Error("Invalid result-check authority; restore its ledger before running checks.");
        parseCheckPolicy(row.account.policy);
        if (
          ![row.account.rounds, row.account.dispatches, row.account.calls, row.account.reservedCost].every(
            value => Number.isFinite(value) && value >= 0,
          )
        )
          throw new Error("Invalid cumulative check budget.");
        this.accounts.set(row.account.key, row.account);
      }
  }
  private save(account: CheckAccount): void {
    if (this.path) appendLineDurably(this.path, JSON.stringify({ schema: "result-check/v1", account }));
    this.accounts.set(account.key, structuredClone(account));
  }
  /** Caller must authenticate the operator before granting; agents never receive this method as a tool. */
  grant(task: Task, raw: unknown, by: string): CheckSnapshot {
    if (
      task.workRoot?.state.unresolved ||
      task.workRoot?.cancellation ||
      task.workRoot?.state.status === "cancelled" ||
      task.status === "done" ||
      task.status === "dropped"
    )
      throw new Error("Ended or unverified work cannot acquire check authority.");
    const policy = parseCheckPolicy(raw),
      old = this.accounts.get(keyOf(task));
    if (old?.plans.some(plan => plan.phase === "running" && plan.deadline > this.now()))
      throw new Error("Stop the existing check before changing its policy.");
    this.save({
      key: keyOf(task),
      taskId: task.id,
      goal: checkGoal(task),
      by,
      policy,
      rounds: old?.rounds ?? 0,
      dispatches: old?.dispatches ?? 0,
      calls: old?.calls ?? 0,
      reservedCost: old?.reservedCost ?? 0,
      ...(old?.startedAt !== undefined ? { startedAt: old.startedAt } : {}),
      plans: old?.plans ?? [],
    });
    return this.snapshot(task);
  }
  snapshot(task: Task): CheckSnapshot {
    const account = this.accounts.get(keyOf(task));
    return structuredClone(
      account
        ? {
            policy: account.goal === checkGoal(task) ? account.policy : { mode: "manual" as const },
            rounds: account.rounds,
            dispatches: account.dispatches,
            calls: account.calls,
            reservedCost: account.reservedCost,
            ...(account.startedAt !== undefined ? { startedAt: account.startedAt } : {}),
            plans: account.plans.map(plan => effectivePlan(plan, this.now())),
          }
        : { policy: { mode: "manual" as const }, rounds: 0, dispatches: 0, calls: 0, reservedCost: 0, plans: [] },
    );
  }
  begin(task: Task, reviewers: string[]): { plan?: CheckPlan; reason?: string } {
    const account = this.accounts.get(keyOf(task));
    if (!account || account.goal !== checkGoal(task) || account.policy.mode === "manual")
      return { reason: "No automatic check was authorized for this goal; the result awaits your inspection." };
    if (
      task.workRoot?.cancellation ||
      task.workRoot?.state.status === "cancelled" ||
      task.workRoot?.state.unresolved ||
      task.status !== "review"
    )
      return { reason: "This work is no longer eligible for a result check." };
    const digest = evidenceDigest(task);
    if (account.plans.some(plan => plan.taskId === task.id && plan.digest === digest))
      return { reason: "This evidence already has a check activity; unchanged evidence is not dispatched again." };
    const policy = account.policy;
    if (policy.mode === "files" && account.rounds >= 3)
      return { reason: "The deterministic check round limit is exhausted; a person decides." };
    if (
      policy.mode === "model" &&
      (reviewers.length !== policy.reviewers ||
        account.rounds >= policy.maxRounds ||
        account.dispatches + reviewers.length > policy.maxDispatches ||
        account.calls >= policy.maxCalls ||
        account.reservedCost >= policy.maxCost)
    )
      return { reason: "The check's total budget or eligible reviewer limit is exhausted; a person decides." };
    const startedAt = account.startedAt ?? this.now(),
      deadline = startedAt + (policy.mode === "model" ? policy.maxMs : 60_000);
    if (deadline <= this.now()) return { reason: "The check's cumulative time allowance is exhausted; a person decides." };
    const plan: CheckPlan = {
      id: randomUUID(),
      taskId: task.id,
      digest,
      goal: account.goal,
      reviewers,
      at: new Date(this.now()).toISOString(),
      deadline,
      phase: "running",
    };
    this.save({
      ...account,
      startedAt,
      rounds: account.rounds + 1,
      dispatches: account.dispatches + reviewers.length,
      plans: [...account.plans, plan],
    });
    return { plan };
  }
  active(task: Task, id: string, reviewerId?: string): boolean {
    const account = this.accounts.get(keyOf(task)),
      plan = account?.plans.find(row => row.id === id);
    return (
      !!account &&
      !!plan &&
      plan.phase === "running" &&
      plan.deadline > this.now() &&
      plan.goal === checkGoal(task) &&
      plan.digest === evidenceDigest(task) &&
      task.status === "review" &&
      !task.workRoot?.cancellation &&
      task.workRoot?.state.status !== "cancelled" &&
      !task.workRoot?.state.unresolved &&
      (!reviewerId || plan.reviewers.includes(reviewerId))
    );
  }
  /** Worst-case reservations precede each physical provider attempt; crashes and failures never refund them. */
  reserve(task: Task, id: string, reviewerId: string, profile: ProviderProfile): { allowed: boolean; reason?: string } {
    const account = this.accounts.get(keyOf(task));
    if (!this.active(task, id, reviewerId) || !account || account.policy.mode !== "model")
      return { allowed: false, reason: "The check is stale, stopped or expired." };
    const deny = (reason: string) => {
      this.stop(task, id, reason);
      return { allowed: false, reason };
    };
    const policy = account.policy,
      rate = this.rates()[profile.model],
      context = profile.contextWindow;
    if (
      !rate ||
      ((profile.promptCaching || profile.implicitCaching) && (rate.cacheReadPerM === undefined || rate.cacheWritePerM === undefined)) ||
      !finite(context, 10_000_000) ||
      !finite(profile.maxTokens, 1_000_000) ||
      ![rate.inputPerM, rate.outputPerM, rate.cacheReadPerM ?? rate.inputPerM, rate.cacheWritePerM ?? rate.inputPerM].every(
        value => Number.isFinite(value) && value >= 0,
      )
    )
      return deny("A priced model and declared context/output bounds are required before spending the check budget.");
    const cost =
      (context! * Math.max(rate.inputPerM, rate.cacheReadPerM ?? rate.inputPerM, rate.cacheWritePerM ?? rate.inputPerM) +
        profile.maxTokens * rate.outputPerM) /
      1e6;
    if (account.calls + 1 > policy.maxCalls || account.reservedCost + cost > policy.maxCost)
      return deny("The check's cumulative call or cost allowance is exhausted.");
    this.save({ ...account, calls: account.calls + 1, reservedCost: account.reservedCost + cost });
    return { allowed: true };
  }
  stop(task: Task, id: string, reason: string): boolean {
    const account = this.accounts.get(keyOf(task)),
      found = account?.plans.find(plan => plan.id === id && plan.taskId === task.id);
    if (!account || !found) return false;
    if (found.phase !== "stopped")
      this.save({
        ...account,
        plans: account.plans.map(plan =>
          plan.id === id ? { ...plan, phase: "stopped", reason: effectivePlan(plan, this.now()).reason ?? reason.slice(0, 1000) } : plan,
        ),
      });
    return true;
  }
}
