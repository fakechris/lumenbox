/**
 * What a tool result may ask the harness to do (INV-861).
 *
 * Before this an extension could only answer in text, so anything with a lifecycle — ask the
 * person first and then continue, start something that finishes later, come back to it tomorrow —
 * had to be written into the core per extension, or left to the model to remember. The harness now
 * reads a short, closed list of **effects** from a result and does them itself:
 *
 * - `pause_turn` — puts a confirmation in front of the person (the ordinary approval card and chat
 *   push, `Policy.requestConfirmation`). When they answer, the harness calls the extension's
 *   host-only `resumeTool` with `{ ...resumeInput, approved }` and delivers what it returns. The
 *   agent is told to stop and wait; it does not retry anything.
 * - `background_job` — the extension started work that finishes later. `api.jobDone` delivers the
 *   result to the agent that started it; after a restart the harness calls `resumeTool` with
 *   `{ jobId, recovering: true }` so the extension can pick the job back up.
 * - `reminder` — delivered to the agent as a system note at or after `at`.
 *
 * Each is written to the pending-work ledger before the agent hears it was accepted, and settled
 * once delivered, so a restart neither loses one nor delivers it twice in silence. Anything outside
 * the list is dropped with a log line: an effect is never code. The shape comes from Manus Cue's
 * addon results (`job_start`, `agent_pause`, …); the machinery is ours — approvals, pending work,
 * the inbox — because every piece of it already existed.
 */

import type { McpManager, ToolEffect } from "./mcp.ts";
import { MCP_SEPARATOR } from "./mcp.ts";
import type { OpenFork, PendingWork } from "./pending-work.ts";
import type { PendingApproval } from "./policy.ts";

/** A reminder further out than this is refused: it is a plan, and plans belong in a task or a routine. */
export const MAX_REMINDER_MS = 366 * 24 * 3_600_000;

/** Reads effects from a tool's raw result, keeping only well-formed members of the closed set. */
export function parseEffects(raw: unknown): { effects: ToolEffect[]; problems: string[] } {
  const effects: ToolEffect[] = [];
  const problems: string[] = [];
  if (raw === undefined) return { effects, problems };
  if (!Array.isArray(raw)) return { effects, problems: ["effects must be a list"] };
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const text = (key: string) => (typeof item[key] === "string" ? (item[key] as string).trim() : "");
    switch (item.type) {
      case "pause_turn":
        if (text("reason") === "" || text("resumeTool") === "") problems.push("pause_turn needs a reason and a resumeTool");
        else
          effects.push({
            type: "pause_turn",
            reason: text("reason"),
            resumeTool: text("resumeTool"),
            ...(item.resumeInput !== null && typeof item.resumeInput === "object" && !Array.isArray(item.resumeInput)
              ? { resumeInput: item.resumeInput as Record<string, unknown> }
              : {}),
          });
        break;
      case "background_job":
        if (text("jobId") === "" || text("resumeTool") === "") problems.push("background_job needs a jobId and a resumeTool");
        else effects.push({ type: "background_job", jobId: text("jobId"), resumeTool: text("resumeTool"), ...(text("brief") !== "" ? { brief: text("brief") } : {}) });
        break;
      case "reminder":
        if (text("text") === "" || text("at") === "") problems.push("reminder needs text and at");
        else effects.push({ type: "reminder", text: text("text"), at: text("at") });
        break;
      default:
        problems.push(`unknown effect ${JSON.stringify(item.type ?? null)} ignored`);
    }
  }
  return { effects, problems };
}

export interface EffectsDeps {
  pendingWork: PendingWork;
  policy: {
    requestConfirmation(input: { agentId: string; agentName: string; description: string; action?: string }): PendingApproval;
    pending(): PendingApproval[];
  };
  mcp: () => McpManager | undefined;
  /** Queues a system note durably in the conversation; returns whether it was admitted. */
  deliver: (agentId: string, text: string, conversation: string) => boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

/** What applying a result's effects produced: a line for the model, and the approval a pause opened. */
export interface Applied {
  notes: string[];
  approval?: { id: string };
}

function serverOf(tool: string): string {
  const at = tool.indexOf(MCP_SEPARATOR);
  return at > 0 ? tool.slice(0, at) : "";
}

export class Effects {
  constructor(private readonly deps: EffectsDeps) {}

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The callback a result names, prefixed with the result's own server, if it is one only the harness may call. */
  private callback(tool: string, bare: string): string | undefined {
    const full = `${serverOf(tool)}${MCP_SEPARATOR}${bare}`;
    return this.deps.mcp()?.isHostOnly(full) === true ? full : undefined;
  }

  /**
   * Acts on the effects of one tool result. `tool` is the prefixed name that returned them; a
   * callback it names must be a host-only tool of the same server — a result cannot aim the
   * harness at another server's tools, or at a tool the model could call itself.
   */
  apply(input: { agentId: string; agentName: string; conversation: string; tool: string; effects: readonly ToolEffect[] }): Applied {
    const applied: Applied = { notes: [] };
    for (const effect of input.effects) {
      switch (effect.type) {
        case "pause_turn": {
          if (applied.approval !== undefined) {
            applied.notes.push("[A second pause in one result was ignored: one confirmation at a time.]");
            continue;
          }
          const resume = this.callback(input.tool, effect.resumeTool);
          if (resume === undefined) {
            this.log(`${input.tool}: pause_turn names ${effect.resumeTool}, which is not a host-only tool of its server; ignored`);
            applied.notes.push(`[The tool asked to pause for a confirmation but named no valid callback; nothing is waiting.]`);
            continue;
          }
          const approval = this.deps.policy.requestConfirmation({
            agentId: input.agentId,
            agentName: input.agentName,
            description: effect.reason,
            action: `continue ${input.tool} once you answer`,
          });
          this.deps.pendingWork.prepare({
            agentId: input.agentId,
            kind: "pause",
            parent: input.conversation,
            child: resume,
            brief: effect.reason,
            data: { approvalId: approval.id, reason: effect.reason, resumeInput: effect.resumeInput ?? {}, agentName: input.agentName },
          });
          applied.approval = { id: approval.id };
          applied.notes.push(
            `[Waiting for the person to confirm: "${effect.reason}". End your turn now. When they answer, the ` +
              `result comes back to you by itself — do not ask again and do not retry.]`
          );
          break;
        }
        case "background_job": {
          const resume = this.callback(input.tool, effect.resumeTool);
          if (resume === undefined) {
            this.log(`${input.tool}: background_job names ${effect.resumeTool}, which is not a host-only tool of its server; ignored`);
            applied.notes.push(`[The tool reported a background job but named no valid recovery callback; it is not tracked.]`);
            continue;
          }
          this.deps.pendingWork.prepare({
            agentId: input.agentId,
            kind: "ext-job",
            parent: input.conversation,
            child: `${serverOf(input.tool)}:${effect.jobId}`,
            brief: effect.brief ?? effect.jobId,
            data: { jobId: effect.jobId, server: serverOf(input.tool), resumeTool: resume, brief: effect.brief ?? effect.jobId },
          });
          applied.notes.push(`[Background job ${effect.jobId} is running; its result is delivered to you when it finishes. Do not wait for it or poll.]`);
          break;
        }
        case "reminder": {
          const at = new Date(effect.at);
          const now = this.now();
          if (Number.isNaN(at.getTime()) || at.getTime() - now.getTime() > MAX_REMINDER_MS) {
            applied.notes.push(`[The reminder was not set: "${effect.at}" is not a time within a year.]`);
            continue;
          }
          this.deps.pendingWork.prepare({
            agentId: input.agentId,
            kind: "reminder",
            parent: input.conversation,
            child: "reminder",
            brief: effect.text,
            data: { text: effect.text, at: at.toISOString(), tool: input.tool },
          });
          applied.notes.push(`[Reminder set for ${at.toISOString()}.]`);
          break;
        }
      }
    }
    return applied;
  }

  private openOf(kind: OpenFork["kind"]): OpenFork[] {
    return this.deps.pendingWork.open().filter(work => work.kind === kind);
  }

  /**
   * A person answered an approval. If a `pause_turn` is waiting on it, the harness calls the
   * extension's callback and delivers what it said; returns whether one was. Told before the
   * record is settled, so a crash in between costs a repeated note rather than a lost one.
   */
  async settleApproval(approvalId: string, how: "allowed" | "refused"): Promise<boolean> {
    const pause = this.openOf("pause").find(work => work.data?.approvalId === approvalId);
    if (pause === undefined) return false;
    const reason = String(pause.data?.reason ?? pause.brief);
    const approved = how === "allowed";
    let text: string;
    let failed = false;
    try {
      const mcp = this.deps.mcp();
      if (mcp === undefined) throw new Error("no tool servers are loaded");
      const result = await mcp.callFromHost(pause.child, { ...((pause.data?.resumeInput as Record<string, unknown>) ?? {}), approved });
      text = result.text;
      const follow = this.apply({ agentId: pause.agentId, agentName: String(pause.data?.agentName ?? ""), conversation: pause.parent, tool: pause.child, effects: result.effects ?? [] });
      if (follow.notes.length > 0) text = `${text}\n${follow.notes.join("\n")}`;
    } catch (error) {
      failed = true;
      text = `The follow-up could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
    const delivered = this.deps.deliver(
      pause.agentId,
      `[You asked the person to confirm "${reason}"; they ${approved ? "confirmed" : "declined"}.] ${text}`,
      pause.parent
    );
    if (!delivered) {
      this.log(`pause ${pause.id}: the answer could not be delivered to ${pause.agentId}; left open`);
      return true;
    }
    this.deps.pendingWork.commit([{ id: pause.id, how: failed ? "failed" : "done" }], this.now());
    return true;
  }

  /** An extension says its background job finished. Delivers once; returns whether a job was open. */
  jobDone(server: string, jobId: string, text: string, ok = true): boolean {
    const job = this.openOf("ext-job").find(work => work.child === `${server}:${jobId}`);
    if (job === undefined) return false;
    const delivered = this.deps.deliver(job.agentId, `[Background job ${jobId} (${job.brief}) ${ok ? "finished" : "failed"}] ${text}`, job.parent);
    if (!delivered) return false;
    this.deps.pendingWork.commit([{ id: job.id, how: ok ? "done" : "failed" }], this.now());
    return true;
  }

  /** Delivers every reminder that is due. Returns how many were. */
  deliverDue(): number {
    const now = this.now();
    let count = 0;
    for (const reminder of this.openOf("reminder")) {
      const at = new Date(String(reminder.data?.at ?? ""));
      if (Number.isNaN(at.getTime()) || at > now) continue;
      if (!this.deps.deliver(reminder.agentId, `[Reminder you set: ${String(reminder.data?.text ?? reminder.brief)}]`, reminder.parent)) continue;
      this.deps.pendingWork.commit([{ id: reminder.id, how: "done" }], now);
      count += 1;
    }
    return count;
  }

  /**
   * After a restart, once extensions are loaded: background jobs are handed back to their
   * extension to pick up; a pause whose approval no longer waits (answered while the process was
   * down, or lost) is reported to the agent and closed; reminders simply stay open for
   * `deliverDue`.
   */
  async recover(): Promise<{ resumedJobs: number; lostJobs: number; closedPauses: number }> {
    const outcome = { resumedJobs: 0, lostJobs: 0, closedPauses: 0 };
    const mcp = this.deps.mcp();
    for (const job of this.openOf("ext-job")) {
      const resume = String(job.data?.resumeTool ?? "");
      if (mcp?.isHostOnly(resume) === true) {
        try {
          await mcp.callFromHost(resume, { jobId: job.data?.jobId, recovering: true });
          outcome.resumedJobs += 1;
          continue;
        } catch (error) {
          this.log(`job ${job.child}: ${resume} failed on recovery: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (this.deps.deliver(job.agentId, `[Background job ${String(job.data?.jobId)} (${job.brief}) was lost in a restart: nothing picked it back up. Anything it did is an attempt, not a result.]`, job.parent)) {
        this.deps.pendingWork.dropped(job.id, "restart", this.now());
        outcome.lostJobs += 1;
      }
    }
    const waiting = new Set(this.deps.policy.pending().map(approval => approval.id));
    for (const pause of this.openOf("pause")) {
      if (waiting.has(String(pause.data?.approvalId))) continue;
      if (this.deps.deliver(pause.agentId, `[The confirmation you asked for ("${String(pause.data?.reason ?? pause.brief)}") is no longer waiting after a restart, and its follow-up did not run. Ask again if it is still needed.]`, pause.parent)) {
        this.deps.pendingWork.dropped(pause.id, "restart", this.now());
        outcome.closedPauses += 1;
      }
    }
    return outcome;
  }
}
