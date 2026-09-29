/**
 * Fan-out by plan (INV-862): one sub-agent per item, then optionally one reducer, run behind the
 * turn and delivered as a single message.
 *
 * Fork answers "split this into a few pieces now" and stops at twelve, because each piece is a full
 * turn and the model schedules them by hand. Thirty items and a summary meant batches the model had
 * to track itself, and a restart made it forget which batches had finished. A **plan** says the
 * whole job at once — the items, what to ask about each, what to do with the answers — so the
 * harness can count it, ask the person when it is large, run it with bounded concurrency, and pick
 * it back up after a restart without re-running what finished.
 *
 * The plan is data, not code. Manus Cue's workflow addon lets the model write JavaScript for this
 * and runs it in QuickJS; Chris chose (2026-09-29) a declarative plan instead: `node:vm` is not a
 * boundary (model code reaches `process` through `this.constructor.constructor`), and a real
 * sandbox would be a fourth runtime dependency. A plan runs no code, needs nothing new, and replays
 * deterministically by construction; what it gives up is branching, which "N items → answers →
 * one summary" does not need.
 *
 * - **Counted exactly.** Calls = items + the reducer. Above `confirmAt` the person confirms first
 *   (`Policy.requestConfirmation`, the INV-861 path); nothing runs until they do.
 * - **Idempotent by position.** Each item's answer is kept under the plan's hash and its index. A
 *   resumed or re-submitted plan runs only the items without an answer.
 * - **Fenced like a fork.** Items run in `fork/…` conversations, so they get the fork prompt, the
 *   fork tool fence (no Orchestrate, no Fork, no messaging) and the fork sweep's cleanup.
 * - **One record.** The pending-work ledger holds one `orchestrate` record per plan: prepared when
 *   submitted, admitted when it starts, committed when the result is delivered.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLineDurably } from "./jsonl.ts";
import type { OpenFork, PendingWork } from "./pending-work.ts";
import type { PendingApproval } from "./policy.ts";

/** Above this many sub-agent calls the person confirms before anything runs. */
export const ORCHESTRATE_CONFIRM_AT = 20;
/** A plan may not name more items than this: past it, it is a batch job, not a fan-out. */
export const MAX_ORCHESTRATE_ITEMS = 200;
/** Items running at once, by default. Each is a full model turn. */
export const ORCHESTRATE_CONCURRENCY = 4;
/** How much of one item's answer reaches the parent when there is no reducer. */
export const ITEM_REPORT_CHARS = 4000;

export interface OrchestrationPlan {
  /** What the whole job is for, in a line; shown to the person and in the result. */
  brief: string;
  items: string[];
  /** What each sub-agent is asked; `{{item}}` is replaced with its item. */
  prompt: string;
  /** What each answer must contain, appended to every item's brief. */
  expect?: string;
  /** The reducer's brief; `{{results}}` is replaced with every item's answer. */
  reduce?: string;
}

export type ItemStatus = "done" | "partial" | "blocked" | "unstated" | "failed";
interface ItemResult {
  index: number;
  status: ItemStatus;
  text: string;
}

/** Reads a plan from tool input, or says what is wrong with it. */
export function parsePlan(input: Record<string, unknown>, maxItems = MAX_ORCHESTRATE_ITEMS): { plan: OrchestrationPlan } | { problem: string } {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
  const items = Array.isArray(input.items) ? input.items.map(item => String(item).trim()).filter(item => item !== "") : [];
  if (text("brief") === "") return { problem: "A plan needs a brief: what the whole job is for." };
  if (items.length === 0) return { problem: "A plan needs at least one item." };
  if (items.length > maxItems) return { problem: `${items.length} items is more than the ${maxItems} a plan may hold. Split the job, or narrow it.` };
  if (!text("prompt").includes("{{item}}")) return { problem: "The prompt must contain {{item}}, where each item goes." };
  if (text("reduce") !== "" && !text("reduce").includes("{{results}}")) {
    return { problem: "The reduce brief must contain {{results}}, where the items' answers go." };
  }
  return {
    plan: {
      brief: text("brief"),
      items,
      prompt: text("prompt"),
      ...(text("expect") !== "" ? { expect: text("expect") } : {}),
      ...(text("reduce") !== "" ? { reduce: text("reduce") } : {}),
    },
  };
}

/** The plan's identity: same brief, items, prompt, expectation and reducer → same answers reused. */
export function planHash(plan: OrchestrationPlan): string {
  const canonical = JSON.stringify([plan.brief, plan.items, plan.prompt, plan.expect ?? "", plan.reduce ?? ""]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** How many sub-agent turns a plan costs. */
export function planCalls(plan: OrchestrationPlan): number {
  return plan.items.length + (plan.reduce !== undefined ? 1 : 0);
}

export function itemBrief(plan: OrchestrationPlan, index: number): string {
  const item = plan.items[index] ?? "";
  return (
    `Item ${index + 1} of ${plan.items.length} in "${plan.brief}".\n\n` +
    plan.prompt.split("{{item}}").join(item) +
    (plan.expect !== undefined ? `\n\nYour answer must contain: ${plan.expect}` : "")
  );
}

export function reduceBrief(plan: OrchestrationPlan, results: readonly ItemResult[]): string {
  const answers = results
    .map(result => `--- item ${result.index + 1}: ${plan.items[result.index] ?? ""} (${result.status}) ---\n${result.text}`)
    .join("\n\n");
  return `The last step of "${plan.brief}".\n\n${(plan.reduce ?? "").split("{{results}}").join(answers)}`;
}

export interface OrchestrationDeps {
  pendingWork: PendingWork;
  policy: {
    requestConfirmation(input: { agentId: string; agentName: string; description: string; action?: string }): PendingApproval;
    pending(): PendingApproval[];
  };
  /**
   * Runs one sub-agent turn in a fork conversation of the agent and returns its final message,
   * handoff line included. Throws when the turn could not run.
   */
  runChild: (agentId: string, conversation: string, brief: string) => Promise<string>;
  /** Reads the handoff line off a child's answer (tools.ts `readHandoff`). */
  readHandoff: (text: string) => { status: "done" | "partial" | "blocked" | "unstated"; body: string; reason?: string };
  /** Queues a system note durably in the conversation; returns whether it was admitted. */
  deliver: (agentId: string, text: string, conversation: string) => boolean;
  /** Where each plan's answers are kept, one file per plan hash. Resolved when first needed. */
  resultsDir: string | (() => string);
  confirmAt?: number;
  concurrency?: number;
  log?: (line: string) => void;
}

interface Running {
  id: string;
  agentId: string;
  parent: string;
  plan: OrchestrationPlan;
  hash: string;
}

export class Orchestrations {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly deps: OrchestrationDeps) {}

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private dir(): string {
    return typeof this.deps.resultsDir === "function" ? this.deps.resultsDir() : this.deps.resultsDir;
  }

  private resultsPath(hash: string): string {
    return join(this.dir(), `${hash}.jsonl`);
  }

  /** What is already known for a plan, by index; -1 is the reducer. */
  private results(hash: string): Map<number, ItemResult> {
    const known = new Map<number, ItemResult>();
    const path = this.resultsPath(hash);
    if (!existsSync(path)) return known;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const result = JSON.parse(line) as ItemResult;
        if (typeof result.index === "number" && typeof result.text === "string") known.set(result.index, result);
      } catch {
        // A torn last line costs one re-run of that item.
      }
    }
    return known;
  }

  private keep(hash: string, result: ItemResult): void {
    mkdirSync(this.dir(), { recursive: true });
    // Durable: replay after a crash trusts these lines to mean "this item is answered".
    appendLineDurably(this.resultsPath(hash), JSON.stringify(result));
  }

  private open(): OpenFork[] {
    return this.deps.pendingWork.open().filter(work => work.kind === "orchestrate");
  }

  private toRunning(work: OpenFork): Running | undefined {
    const plan = work.data?.plan as OrchestrationPlan | undefined;
    if (plan === undefined || !Array.isArray(plan.items)) return undefined;
    return { id: work.id, agentId: work.agentId, parent: work.parent, plan, hash: String(work.data?.hash ?? planHash(plan)) };
  }

  /**
   * Takes a plan from a turn. Returns what the model is told, and the approval when the person has
   * to confirm first. A plan identical to one still open is not started twice.
   */
  submit(input: { agentId: string; agentName: string; parent: string; plan: OrchestrationPlan }): { text: string; approval?: { id: string } } {
    const hash = planHash(input.plan);
    const calls = planCalls(input.plan);
    const already = this.open().find(work => work.agentId === input.agentId && work.data?.hash === hash);
    if (already !== undefined) {
      return {
        text:
          `This plan is already ${already.admitted ? "running" : "waiting for the person to confirm"}; its result will ` +
          `arrive here as one message. Do not submit it again.`,
      };
    }
    const done = [...this.results(hash).keys()].filter(index => index >= 0).length;
    const confirmAt = this.deps.confirmAt ?? ORCHESTRATE_CONFIRM_AT;
    const needsConfirm = calls - done > confirmAt;
    const approval = needsConfirm
      ? this.deps.policy.requestConfirmation({
          agentId: input.agentId,
          agentName: input.agentName,
          description: `Run ${calls} sub-agent turns for "${input.plan.brief}" (${input.plan.items.length} items${input.plan.reduce !== undefined ? " and a summary" : ""}).`,
          action: "start a fan-out of sub-agents",
        })
      : undefined;
    const id = this.deps.pendingWork.prepare({
      agentId: input.agentId,
      kind: "orchestrate",
      parent: input.parent,
      child: `plan:${hash}`,
      brief: input.plan.brief,
      data: { plan: input.plan, hash, ...(approval !== undefined ? { approvalId: approval.id } : {}) },
    });
    const reused = done > 0 ? ` ${done} item(s) answered by an earlier run of this plan are reused.` : "";
    if (approval !== undefined) {
      return {
        approval: { id: approval.id },
        text:
          `This plan needs ${calls} sub-agent turns, over the ${confirmAt} that run without asking, so the person ` +
          `has been asked to confirm it.${reused} End your turn now and say that you are waiting for their go-ahead. ` +
          `When they answer, it starts (or not) by itself and the result arrives here as one message — do not ` +
          `resubmit, poll, or predict it.`,
      };
    }
    this.start({ id, agentId: input.agentId, parent: input.parent, plan: input.plan, hash });
    return {
      text:
        `Started ${calls} sub-agent turn(s) for "${input.plan.brief}" in the background.${reused} The result arrives ` +
        `here as one message. End your turn with what the person should hear; do not check on it or predict it.`,
    };
  }

  /** A person answered a plan's confirmation. Returns whether a plan was waiting on it. */
  settleApproval(approvalId: string, how: "allowed" | "refused"): boolean {
    const work = this.open().find(item => item.data?.approvalId === approvalId && !item.admitted);
    if (work === undefined) return false;
    const running = this.toRunning(work);
    if (running === undefined) return false;
    if (how === "allowed") {
      this.start(running);
      return true;
    }
    if (this.deps.deliver(work.agentId, `[The person declined the plan "${running.plan.brief}"; nothing ran. Do not resubmit it unless they ask.]`, work.parent)) {
      this.deps.pendingWork.dropped(work.id, "refused");
    }
    return true;
  }

  /**
   * After a restart: a started plan continues from the items without an answer; a plan whose
   * confirmation no longer waits is reported and closed; one still waiting stays for the person.
   */
  recover(): { resumed: number; closed: number } {
    const outcome = { resumed: 0, closed: 0 };
    const waiting = new Set(this.deps.policy.pending().map(approval => approval.id));
    for (const work of this.open()) {
      const running = this.toRunning(work);
      if (running === undefined) continue;
      if (work.admitted || work.data?.approvalId === undefined) {
        this.start(running, false);
        outcome.resumed += 1;
        continue;
      }
      if (waiting.has(String(work.data.approvalId))) continue;
      if (this.deps.deliver(work.agentId, `[The plan "${running.plan.brief}" was waiting for a confirmation that is gone after a restart; nothing ran. Submit it again if it is still wanted.]`, work.parent)) {
        this.deps.pendingWork.dropped(work.id, "restart");
        outcome.closed += 1;
      }
    }
    return outcome;
  }

  /** Resolves when every plan started by this instance has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  private start(running: Running, markAdmitted = true): void {
    if (this.active.has(running.id)) return;
    if (markAdmitted) this.deps.pendingWork.admitted(running.id, undefined);
    const run = this.run(running)
      .catch(error => this.log(`plan ${running.hash}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.active.delete(running.id));
    this.active.set(running.id, run);
  }

  private async runOne(running: Running, index: number, brief: string): Promise<ItemResult> {
    const conversation = `fork/${running.parent}-plan-${running.hash.slice(0, 8)}-${index < 0 ? "reduce" : index + 1}-${Date.now().toString(36)}`;
    try {
      const said = await this.deps.runChild(running.agentId, conversation, brief);
      const handoff = this.deps.readHandoff(said);
      const text = handoff.body.trim() === "" ? "(said nothing)" : handoff.body.trim();
      return { index, status: handoff.status, text: handoff.reason !== undefined && handoff.status !== "done" ? `${text}\n(${handoff.reason})` : text };
    } catch (error) {
      return { index, status: "failed", text: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(running: Running): Promise<void> {
    const known = this.results(running.hash);
    const missing = running.plan.items.map((_, index) => index).filter(index => !known.has(index));
    const concurrency = Math.max(1, this.deps.concurrency ?? ORCHESTRATE_CONCURRENCY);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < missing.length) {
        const index = missing[next++]!;
        const result = await this.runOne(running, index, itemBrief(running.plan, index));
        this.keep(running.hash, result);
        known.set(index, result);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, () => worker()));

    const items = running.plan.items.map((_, index) => known.get(index)!).filter(result => result !== undefined);
    let summary: ItemResult | undefined;
    if (running.plan.reduce !== undefined) {
      summary = known.get(-1);
      if (summary === undefined) {
        summary = await this.runOne(running, -1, reduceBrief(running.plan, items));
        this.keep(running.hash, summary);
      }
    }
    const failed = items.filter(result => result.status !== "done").length;
    const header = `[The plan "${running.plan.brief}" finished: ${items.length} item(s)${failed > 0 ? `, ${failed} not done` : ""}.`;
    const body =
      summary !== undefined
        ? `${header} The summary:]\n\n${summary.text}`
        : `${header}]\n\n${items
            .map(result => {
              const text = result.text.length > ITEM_REPORT_CHARS ? `${result.text.slice(0, ITEM_REPORT_CHARS)}\n… (cut at ${ITEM_REPORT_CHARS} characters)` : result.text;
              return `--- item ${result.index + 1}: ${running.plan.items[result.index] ?? ""} (${result.status}) ---\n${text}`;
            })
            .join("\n\n")}`;
    if (this.deps.deliver(running.agentId, body, running.parent)) {
      this.deps.pendingWork.commit([{ id: running.id, how: failed === items.length && items.length > 0 ? "failed" : "done" }]);
    } else {
      this.log(`plan ${running.hash}: finished, but the result could not be delivered; it stays open for the next start`);
    }
  }
}
