/**
 * The standalone supervisor (INV-1518, docs/90 §3.5): a model-driven principal on the side door.
 *
 * It gets five of the door's tools — start a goal, read the record, pause or clear its own goal, flag
 * for a person, list the team — and none that touch the box: a supervisor is not a hand.
 * The model is woken only when something happened: once to start the goal, then whenever the goal's
 * record moves, or after a long quiet. Between wakes the host holds the watch, which costs nothing.
 * The door's rules are the door's: a refusal comes back to the model as the door wrote it.
 *
 * Every model turn, tool call and door reply goes to a transcript, so a run can be read afterwards
 * the way a task's record can. Neither the door's token nor the model key is ever in it.
 */

import type { Door } from "../watchdog/client.ts";
import type { TaskRecord } from "../web/mcp-record.ts";
import type { FunctionTool, InputItem, ModelAsk, ModelTurn } from "./openai.ts";

/** Five: watching is the host's, between wakes. A real run had the model spend its calls holding watch itself. */
export const SUPERVISOR_TOOLS = ["goal_start", "task_status", "goal_control", "raise_attention", "list_agents"] as const;

export interface SupervisorLimits {
  maxMinutes: number;
  maxModelCalls: number;
  /** A quiet this long wakes the model anyway, with the record as it stands. */
  idleWakeMinutes: number;
  /** Tool rounds within one wake before the host stops listening. */
  maxRoundsPerWake: number;
}

export const DEFAULT_SUPERVISOR_LIMITS: SupervisorLimits = { maxMinutes: 120, maxModelCalls: 60, idleWakeMinutes: 30, maxRoundsPerWake: 6 };

export interface SupervisorDeps {
  door: Door & { tools?: () => Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]> };
  ask: ModelAsk;
  record: (entry: Record<string, unknown>) => void;
  log: (line: string) => void;
  runId: string;
  limits?: Partial<SupervisorLimits>;
  now?: () => Date;
  /** Seconds a watch waits; tests use 0. */
  watchSeconds?: number;
  /** A person asked this run to stop (INV-1527): checked between watches and before each wake. */
  shouldStop?: () => boolean;
}

export interface SupervisorResult {
  outcome: "completed" | "cleared" | "cancelled" | "no_goal" | "limit_time" | "limit_calls" | "model_error" | "stopped";
  goalId?: string;
  modelCalls: number;
  usage: { input: number; output: number; reasoning: number };
  toolCalls: Record<string, number>;
  refusals: string[];
  startedAt: string;
  endedAt: string;
}

export const SUPERVISOR_INSTRUCTIONS = [
  "You supervise a team of agents from outside, through a door of tools. You are one principal on that door, not a worker.",
  "Your job: start the one goal you are given with goal_start, then keep watch over it until it is completed or cleared.",
  "After you start it, stop: the host watches for you and wakes you when the goal's record changes, or after a long quiet, with the record. Then decide what, if anything, to do:",
  "- nothing (reply in one line, no tool call) when the work is moving;",
  "- raise_attention with a precise one-line note when a person must decide or look (a stop by the system, a failing check, no progress);",
  "- goal_control pause when your own goal is wasting effort; clear only if the objective has become pointless.",
  "You cannot resume a goal the system stopped, raise a budget, or mark work done; the door refuses those, and a person decides them.",
  "Do not start a second goal. Keep tool calls few. Never invent facts that are not in the record.",
].join("\n");

/**
 * What the model may fill in. The key is the host's. goal_start's agent and budget are the operator's:
 * a real run had the model invent a budget nobody asked for and guess an agent called "coordinator".
 */
const HOST_OWNED: Record<string, string[]> = { goal_start: ["agent", "budget"] };
const modelSchema = (name: string, schema: Record<string, unknown>) => {
  const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  for (const key of ["idempotency_key", ...(HOST_OWNED[name] ?? [])]) delete properties[key];
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter(key => key in properties) : undefined;
  return { ...schema, properties, ...(required !== undefined ? { required } : {}) };
};

export class Supervisor {
  private readonly limits: SupervisorLimits;
  private previous: string | undefined;
  private modelCalls = 0;
  private keySeq = 0;
  private readonly usage = { input: 0, output: 0, reasoning: 0 };
  private readonly toolCalls: Record<string, number> = {};
  private readonly refusals: string[] = [];
  private goalId: string | undefined;
  private tools: FunctionTool[] = [];
  private goalOptions: { agent?: string; budget?: number } = {};

  constructor(private readonly deps: SupervisorDeps) {
    this.limits = { ...DEFAULT_SUPERVISOR_LIMITS, ...deps.limits };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The six tools, described as the door describes them, without the key the host fills in. */
  private async loadTools(): Promise<void> {
    const listed = (await this.deps.door.tools?.()) ?? [];
    this.tools = SUPERVISOR_TOOLS.map(name => {
      const tool = listed.find(entry => entry.name === name);
      if (tool === undefined) throw new Error(`the door has no ${name}; it is too old for the supervisor`);
      return { name, description: tool.description, parameters: modelSchema(name, tool.inputSchema) };
    });
  }

  private async callModel(input: InputItem[]): Promise<ModelTurn> {
    this.modelCalls++;
    const turn = await this.deps.ask({ instructions: SUPERVISOR_INSTRUCTIONS, input, tools: this.tools, ...(this.previous !== undefined ? { previous: this.previous } : {}) });
    this.previous = turn.id;
    this.usage.input += turn.usage.input;
    this.usage.output += turn.usage.output;
    this.usage.reasoning += turn.usage.reasoning;
    this.deps.record({ at: this.now().toISOString(), kind: "model", n: this.modelCalls, calls: turn.calls.map(call => ({ name: call.name, arguments: call.arguments })), text: turn.text, usage: turn.usage });
    return turn;
  }

  /** One wake: the model speaks, its tool calls run through the door, until it stops calling tools. */
  private async wake(message: string): Promise<void> {
    let input: InputItem[] = [{ role: "user", content: message }];
    for (let round = 0; round < this.limits.maxRoundsPerWake; round++) {
      if (this.modelCalls >= this.limits.maxModelCalls) return;
      const turn = await this.callModel(input);
      if (turn.calls.length === 0) return;
      input = [];
      for (const call of turn.calls) input.push({ type: "function_call_output", call_id: call.callId, output: await this.runTool(call.name, call.arguments) });
    }
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.toolCalls[name] = (this.toolCalls[name] ?? 0) + 1;
    if (!(SUPERVISOR_TOOLS as readonly string[]).includes(name)) {
      const refusal = `${name} is not one of your tools.`;
      this.refusals.push(refusal);
      this.deps.record({ at: this.now().toISOString(), kind: "tool", name, arguments: args, refused: refusal });
      return refusal;
    }
    if (name === "goal_start" && this.goalId !== undefined) {
      const refusal = `You already started ${this.goalId}; one goal per run.`;
      this.refusals.push(refusal);
      this.deps.record({ at: this.now().toISOString(), kind: "tool", name, arguments: args, refused: refusal });
      return refusal;
    }
    const writes = name === "goal_start" || name === "goal_control" || name === "raise_attention";
    const owned = name === "goal_start" ? { agent: undefined, budget: undefined, ...this.goalOptions } : {};
    const sent = writes ? { ...args, ...owned, idempotency_key: `supervise-${this.deps.runId}-${++this.keySeq}` } : args;
    for (const key of Object.keys(sent)) if (sent[key] === undefined) delete sent[key];
    const reply = await this.deps.door.call(name, sent, name === "watch" ? { timeoutMs: 60_000 } : {});
    if (reply.isError) this.refusals.push(`${name}: ${reply.text.split("\n")[0]}`);
    if (name === "goal_start" && !reply.isError) this.goalId = /^(t\d+)/.exec(reply.text)?.[1];
    this.deps.record({ at: this.now().toISOString(), kind: "tool", name, arguments: args, isError: reply.isError, reply: reply.text.slice(0, 2000) });
    return reply.isError ? `REFUSED by the door: ${reply.text}` : reply.text;
  }

  private async goalRecord(): Promise<TaskRecord | undefined> {
    if (this.goalId === undefined) return undefined;
    const reply = await this.deps.door.call("task_status", { task_id: this.goalId });
    return ((reply.structured?.tasks ?? []) as TaskRecord[])[0];
  }

  private ended(record: TaskRecord | undefined): SupervisorResult["outcome"] | undefined {
    if (record === undefined) return undefined;
    if (record.pursuit?.status === "complete" || record.outcome.status === "completed") return "completed";
    if (record.pursuit?.status === "cleared") return "cleared";
    if (record.outcome.status === "cancelled") return "cancelled";
    return undefined;
  }

  async run(objective: string, options: { agent?: string; budget?: number } = {}): Promise<SupervisorResult> {
    const startedAt = this.now();
    const result = (outcome: SupervisorResult["outcome"]): SupervisorResult => {
      const done: SupervisorResult = { outcome, ...(this.goalId !== undefined ? { goalId: this.goalId } : {}), modelCalls: this.modelCalls, usage: { ...this.usage }, toolCalls: { ...this.toolCalls }, refusals: [...this.refusals], startedAt: startedAt.toISOString(), endedAt: this.now().toISOString() };
      this.deps.record({ at: done.endedAt, kind: "end", ...done });
      return done;
    };
    await this.loadTools();
    this.goalOptions = { ...options };
    this.deps.record({ at: startedAt.toISOString(), kind: "start", objective, ...options, tools: this.tools.map(tool => tool.name), limits: this.limits });
    try {
      await this.wake(`Your goal, to start now with goal_start (the objective, in these words or clearer; the agent and budget are set for you):\n${objective}`);
    } catch (error) {
      this.deps.log(`supervisor: ${error instanceof Error ? error.message : String(error)}`);
      return result("model_error");
    }
    if (this.goalId === undefined) return result("no_goal");
    let cursor = String((await this.deps.door.call("watch", {})).structured?.cursor ?? "0");
    let lastWake = this.now().getTime();
    for (;;) {
      const record = await this.goalRecord();
      const end = this.ended(record);
      if (end !== undefined) return result(end);
      if (this.now().getTime() - startedAt.getTime() >= this.limits.maxMinutes * 60_000) return result("limit_time");
      if (this.modelCalls >= this.limits.maxModelCalls) return result("limit_calls");
      if (this.deps.shouldStop?.() === true) return result("stopped");
      const watched = await this.deps.door.call("watch", { since: cursor, wait_seconds: this.deps.watchSeconds ?? 30 }, { timeoutMs: 60_000 });
      const feed = watched.structured as { events?: { taskId: string; status: string; stage?: string; pursuit?: { status: string; pausedReason?: string } }[]; cursor?: string } | undefined;
      cursor = feed?.cursor ?? cursor;
      const mine = (feed?.events ?? []).filter(event => event.taskId === this.goalId);
      const quiet = this.now().getTime() - lastWake >= this.limits.idleWakeMinutes * 60_000;
      if (mine.length === 0 && !quiet) continue;
      const current = await this.goalRecord();
      if (this.ended(current) !== undefined) return result(this.ended(current)!);
      if (this.deps.shouldStop?.() === true) return result("stopped");
      lastWake = this.now().getTime();
      const what = mine.length > 0 ? `The goal's record changed: ${mine.map(event => `${event.status}${event.stage !== undefined ? ` ${event.stage}` : ""}${event.pursuit !== undefined ? ` goal ${event.pursuit.status}${event.pursuit.pausedReason !== undefined ? ` (${event.pursuit.pausedReason})` : ""}` : ""}`).join("; ")}.` : `No change for ${this.limits.idleWakeMinutes} minutes.`;
      try {
        await this.wake(`${what}\nThe record of ${this.goalId} now:\n${JSON.stringify(current)}`);
      } catch (error) {
        this.deps.log(`supervisor: ${error instanceof Error ? error.message : String(error)}`);
        return result("model_error");
      }
    }
  }
}

export function summaryOf(objective: string, result: SupervisorResult): string {
  const tools = Object.entries(result.toolCalls).map(([name, count]) => `${name} ×${count}`).join(", ") || "none";
  return [
    `# Supervisor run`,
    "",
    `Objective: ${objective}`,
    `Goal: ${result.goalId ?? "none started"}`,
    `Outcome: ${result.outcome}`,
    `From ${result.startedAt} to ${result.endedAt}`,
    `Model calls: ${result.modelCalls}; tokens in ${result.usage.input}, out ${result.usage.output} (reasoning ${result.usage.reasoning})`,
    `Tools: ${tools}`,
    `Refused: ${result.refusals.length === 0 ? "nothing" : ""}`,
    ...result.refusals.map(refusal => `- ${refusal}`),
    "",
  ].join("\n");
}
