/**
 * The turn's own budget (INV-1354): how many times one turn may ask the model, and how many
 * times it may make the identical tool call, before the work goes back to the person.
 *
 * INV-1277 bounds hops between agents. Nothing bounded an agent by itself: the INV-1340 eval
 * saw one episode make 362 model calls and spend 49M tokens reading, listing and fetching, and
 * stop only at the orchestrator's idle timeout. `detectLoop` (progress.ts) catches one call
 * repeated in consecutive rounds; it does not catch varied busywork, and it cannot stop a
 * call it has already seen three times from running a fourth. This does both, cheaply:
 *
 *   - **calls**: a ceiling on model calls per turn. At 80% the next tool result carries one line
 *     saying so; at the ceiling the turn ends with a report to the person — what was done, what
 *     stopped it — as an outcome, not a failure.
 *   - **repeats**: the same tool with the same arguments (progress.ts's signature) past this
 *     many times is not run again; the last result comes back with a line saying it is a replay.
 *
 * Both are operator settings (`turnBudget` in config.json). Defaults 60 and 3: the eval's
 * honest episodes finished in 3–40 calls, the runaways in 100–362.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { signatureOf } from "./progress.ts";

export interface TurnBudgetConfig {
  /** Model calls one turn may make. */
  calls: number;
  /** Times the identical tool call may run; the next one is a replay. */
  repeats: number;
}

export const DEFAULT_TURN_BUDGET: TurnBudgetConfig = { calls: 60, repeats: 3 };

/** The fraction of `calls` at which the model is warned, once. */
const WARN_AT = 0.8;

export class TurnBudget {
  private used = 0;
  private warned = false;
  private readonly seen = new Map<string, { count: number; result: Anthropic.ToolResultBlockParam["content"] }>();

  constructor(readonly limits: TurnBudgetConfig = DEFAULT_TURN_BUDGET) {}

  /** One more model call. `hit` means this call must not be made; `warn` means say so once. */
  call(): "ok" | "warn" | "hit" {
    if (this.used >= this.limits.calls) return "hit";
    this.used += 1;
    if (!this.warned && this.used >= Math.ceil(this.limits.calls * WARN_AT)) {
      this.warned = true;
      return "warn";
    }
    return "ok";
  }

  get callsUsed(): number {
    return this.used;
  }

  /** The replay for a call seen too often, or undefined when the call should run. */
  replayFor(tool: string, input: unknown): Anthropic.ToolResultBlockParam["content"] | undefined {
    const entry = this.seen.get(signatureOf(tool, input));
    if (entry === undefined || entry.count < this.limits.repeats || entry.result === undefined) return undefined;
    return entry.result;
  }

  /** A call that ran, and what it returned, so the next identical one can be answered from here. */
  ran(tool: string, input: unknown, result: Anthropic.ToolResultBlockParam["content"]): void {
    const key = signatureOf(tool, input);
    const entry = this.seen.get(key);
    // Past the limit the stored result is the last real one; a replay must not replace it with itself.
    const kept = entry !== undefined && entry.count >= this.limits.repeats ? entry.result : result;
    this.seen.set(key, { count: (entry?.count ?? 0) + 1, result: kept });
  }

  /** How many times this exact call has run. */
  repeatsOf(tool: string, input: unknown): number {
    return this.seen.get(signatureOf(tool, input))?.count ?? 0;
  }
}

/** The line appended to a tool result when the budget is 80% spent. */
export function budgetWarning(budget: TurnBudget, chinese: boolean): string {
  const left = budget.limits.calls - budget.callsUsed;
  return chinese
    ? `[本轮预算：已用 ${budget.callsUsed}/${budget.limits.calls} 次模型调用，还剩 ${left} 次。请收口：把已有结果整理成回复，说清还没做完的部分。]`
    : `[Turn budget: ${budget.callsUsed} of ${budget.limits.calls} model calls used, ${left} left. Wrap up: turn what you have into a reply and say what is unfinished.]`;
}

/** The line appended to a replayed result, so the model knows nothing new ran. */
export function replayNote(tool: string, times: number, chinese: boolean): string {
  return chinese
    ? `[这是第 ${times} 次完全相同的 ${tool} 调用，没有重新执行：下面是上一次的结果。换个做法，或者把目前的结论告诉人。]`
    : `[This identical ${tool} call has now been made ${times} times; it was not run again — the result below is the previous one. Change approach, or tell the person what you have.]`;
}

/** What the person is told when the turn ends on its budget: an outcome, said plainly. */
export function budgetReport(budget: TurnBudget, calls: readonly string[], chinese: boolean): string {
  const tools = new Map<string, number>();
  for (const call of calls) {
    const name = call.split(" ")[0] ?? call;
    tools.set(name, (tools.get(name) ?? 0) + 1);
  }
  const top = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => `${name} ×${n}`).join(", ");
  return chinese
    ? `这一轮用完了 ${budget.limits.calls} 次模型调用的预算，我停下来交给你。做过的事：${calls.length} 次工具调用，主要是 ${top || "无"}。没有完成的部分需要你决定：缩小范围、换个做法，或者让我继续。`
    : `This turn used its budget of ${budget.limits.calls} model calls, so I am stopping and handing it back. What ran: ${calls.length} tool calls, mostly ${top || "none"}. What is unfinished needs your call — narrow the task, change the approach, or tell me to continue.`;
}
