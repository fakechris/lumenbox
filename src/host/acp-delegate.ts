/**
 * Delegate as a session (INV-1234, docs/81): the host side of an engine kept alive in the box.
 *
 * The one-shot Delegate starts a job and reads its report when it ends. A session is the
 * same contract — a pending-work record per brief, the engine's own word for the outcome,
 * the same note to the agent — over a different wire: boxd holds the engine's ACP process
 * (boxd/acp-service.ts) and this file watches its events. What the watching does:
 *
 *   - the engine's answer to the prompt settles the brief: `end_turn` is done, `cancelled`
 *     is aborted, an error is failed; the process exiting with the brief open is failed;
 *   - the engine's `session/request_permission` is a question for the policy gate, answered
 *     `allow-once` or `deny` and never `allow-always` — a standing grant inside an engine is a
 *     grant the host cannot see; nobody answering in time ends the turn with `session/cancel`,
 *     because the engine would otherwise hold it open forever (measured);
 *   - a steer is the engine's own steer, with this host's idempotency key; `steered` means
 *     delivered, not adopted, and is recorded as exactly that;
 *   - after a restart, a session is loaded with the engine session id and cwd stored on the
 *     brief's record, in that cwd only; anything else is a definite failure, never a retry.
 *
 * Metering is not here: the engine's model traffic goes through the relay, whose rows are
 * the bill (model-relay.ts). `usage_update` from the engine is context occupancy, not tokens.
 */
import { createHash } from "node:crypto";
import type { AcpEvent } from "../protocol/index.ts";
import type { BoxClient } from "../box/client.ts";
import { awaitDelegatedConsent } from "./delegated-consent.ts";
import { delegateEndedNote } from "./engine-report.ts";
import { describeWorktree, worktreeState } from "./worktree-state.ts";
import type { PendingWork } from "./pending-work.ts";
import type { PolicyGate } from "./policy.ts";

export type AcpBox = Pick<BoxClient, "acpOpen" | "acpSend" | "acpReply" | "acpEvents" | "acpClose" | "acpSessions"> & Partial<Pick<BoxClient, "exec">>;

export interface AcpDelegateDeps {
  pendingWork?: PendingWork;
  policy?: PolicyGate;
  /** The note to the agent that delegated, in the conversation it delegated from. */
  deliver: (agentId: string, text: string, conversation: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How long one events poll waits in the box before answering empty. */
  eventsTimeoutMs?: number;
  /** Consent waiting, overridable for tests. */
  consentPollMs?: number;
  consentWaitMs?: number;
}

/** What the record of a brief carries for a session, beside `engine` (pending-work `data`). */
export interface SessionData {
  mode: "session";
  engineSessionId: string;
  cwd: string;
  /** The id of the `session/prompt` request whose response settles this brief. */
  promptRpcId: number;
}

interface Watch {
  jobId: string;
  agentId: string;
  agentName: string;
  conversation: string;
  box: AcpBox;
  engineSessionId: string;
  cwd: string;
  /** The brief in flight, if any: its prompt's rpc id and what the engine has said so far. */
  inFlight?: { promptRpcId: number; brief: string; text: string };
  since: number;
  stopped: boolean;
}

export interface StartInput {
  box: AcpBox;
  agentId: string;
  agentName: string;
  conversation: string;
  engine: string;
  /** The command that runs the engine's ACP surface in the box (preset.acp.command). */
  command: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  workId?: string;
  turnId?: string;
  call?: string;
  display?: number;
}

export class AcpDelegates {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: AcpDelegateDeps) {}

  /** The sessions this host is watching, for the tool's own list. */
  list(): { jobId: string; agentId: string; engineSessionId: string; cwd: string; busy: boolean }[] {
    return [...this.watches.values()].map(w => ({ jobId: w.jobId, agentId: w.agentId, engineSessionId: w.engineSessionId, cwd: w.cwd, busy: w.inFlight !== undefined }));
  }

  get(jobId: string): Watch | undefined {
    return this.watches.get(jobId);
  }

  /** Stops watching everything without touching the engines: what a host does on its way out. The records stay, for reattach. */
  stop(): void {
    for (const watch of this.watches.values()) watch.stopped = true;
    this.watches.clear();
  }

  /**
   * Opens the engine, records the brief, sends it, and starts watching. The record is written
   * after the open so it carries the engine's session id from the start; a record that cannot
   * be written closes the session again, because a brief nobody can settle must not run.
   */
  async start(input: StartInput, jobId: string): Promise<{ jobId: string; engineSessionId: string; logPath: string }> {
    const opened = await input.box.acpOpen({
      session_id: jobId,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      ...(input.display !== undefined ? { display: input.display } : {}),
      ...(input.call !== undefined ? { call: input.call } : {}),
    });
    const watch: Watch = {
      jobId,
      agentId: input.agentId,
      agentName: input.agentName,
      conversation: input.conversation,
      box: input.box,
      engineSessionId: opened.engine_session_id,
      cwd: input.cwd,
      since: 0,
      stopped: false,
    };
    this.watches.set(jobId, watch);
    try {
      await this.brief(watch, input.prompt, { engine: input.engine, workId: input.workId, turnId: input.turnId });
    } catch (error) {
      this.watches.delete(jobId);
      await input.box.acpClose({ session_id: jobId }).catch(() => undefined);
      throw error;
    }
    void this.loop(watch);
    return { jobId, engineSessionId: opened.engine_session_id, logPath: opened.log_path };
  }

  /** A further brief on an open session: refused while one is in flight. */
  async continueWith(jobId: string, prompt: string, extra: { engine: string; workId?: string; turnId?: string }): Promise<void> {
    const watch = this.watches.get(jobId);
    if (watch === undefined) throw new Error(`${jobId} is not an open delegate session on this host`);
    if (watch.inFlight !== undefined) throw new Error(`${jobId} is still working on its current brief; steer it, or wait for it to finish`);
    await this.brief(watch, prompt, extra);
  }

  private async brief(watch: Watch, prompt: string, extra: { engine: string; workId?: string; turnId?: string }): Promise<void> {
    const sent = await watch.box.acpSend({
      session_id: watch.jobId,
      method: "session/prompt",
      params: { sessionId: watch.engineSessionId, prompt: [{ type: "text", text: prompt }] },
    });
    const promptRpcId = sent.rpc_id!;
    const data: SessionData & { engine: string } = { engine: extra.engine, mode: "session", engineSessionId: watch.engineSessionId, cwd: watch.cwd, promptRpcId };
    const id = this.deps.pendingWork?.prepare({
      agentId: watch.agentId,
      kind: "delegate",
      parent: watch.conversation,
      child: watch.jobId,
      brief: `${extra.engine}: ${prompt}`,
      ...(extra.workId !== undefined ? { workId: extra.workId } : {}),
      ...(extra.turnId !== undefined ? { turnId: extra.turnId } : {}),
      data: { ...data },
    });
    if (id !== undefined) this.deps.pendingWork?.admitted(id, undefined);
    watch.inFlight = { promptRpcId, brief: `${extra.engine}: ${prompt}`, text: "" };
  }

  /**
   * The engine's own steer, keyed so a repeat is a repeat. `delivered` is the engine saying it
   * took the text into the running turn — not that it changed course; `idle` is the engine
   * saying there is no turn to steer, which the tool turns into a new brief.
   */
  async steer(jobId: string, text: string): Promise<"delivered" | "duplicate" | "idle"> {
    const watch = this.watches.get(jobId);
    if (watch === undefined) throw new Error(`${jobId} is not an open delegate session on this host`);
    const key = createHash("sha256").update(`${jobId}\0${watch.inFlight?.promptRpcId ?? 0}\0${text}`).digest("hex").slice(0, 16);
    const sent = await watch.box.acpSend({
      session_id: jobId,
      method: "mcode/session/steer",
      params: { sessionId: watch.engineSessionId, text, clientRequestId: key },
    });
    const answer = await this.answerTo(watch, sent.rpc_id!, 15_000);
    if (answer === undefined) throw new Error(`${jobId} did not answer the steer in time`);
    if (answer.error !== undefined) {
      const message = String((answer.error as { message?: unknown }).message ?? "");
      if (/active ACP prompt Turn/i.test(message)) return "idle";
      throw new Error(`${jobId} refused the steer: ${message}`);
    }
    const mode = String((answer.result as { mode?: unknown })?.mode ?? "");
    return mode === "duplicate" ? "duplicate" : "delivered";
  }

  /** `session/cancel`: a notification; the brief settles when the engine answers its prompt. */
  async cancel(jobId: string): Promise<boolean> {
    const watch = this.watches.get(jobId);
    if (watch === undefined) throw new Error(`${jobId} is not an open delegate session on this host`);
    if (watch.inFlight === undefined) return false;
    await watch.box.acpSend({ session_id: jobId, method: "session/cancel", params: { sessionId: watch.engineSessionId }, notify: true });
    return true;
  }

  /** Ends the engine; a brief still in flight is settled as aborted by the host's own hand. */
  async close(jobId: string, why = "closed by the agent"): Promise<void> {
    const watch = this.watches.get(jobId);
    if (watch === undefined) throw new Error(`${jobId} is not an open delegate session on this host`);
    watch.stopped = true;
    this.watches.delete(jobId);
    await watch.box.acpClose({ session_id: jobId }).catch(() => undefined);
    if (watch.inFlight !== undefined) this.settle(watch, "aborted", `the session was ${why} before the engine answered`);
  }

  /**
   * After a restart: every brief recorded as a session is looked for in the box. A session
   * still running there is watched again; a detached one is loaded with its stored engine
   * session id in its stored cwd — the brief that was in flight is then unknown, because the
   * engine's answer to it is gone with the old process; a load the engine refuses is failed.
   */
  async reattach(box: AcpBox, items: { agentId: string; agentName: string; conversation: string; jobId: string; brief: string; data: SessionData & { engine: string } }[]): Promise<void> {
    if (items.length === 0) return;
    let sessions: Awaited<ReturnType<AcpBox["acpSessions"]>>["sessions"];
    try {
      sessions = (await box.acpSessions()).sessions;
    } catch (error) {
      this.deps.log?.(`acp: could not list the box's sessions after restart: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const item of items) {
      if (this.watches.has(item.jobId)) continue;
      const known = sessions.find(s => s.session_id === item.jobId);
      const watch: Watch = {
        jobId: item.jobId,
        agentId: item.agentId,
        agentName: item.agentName,
        conversation: item.conversation,
        box,
        engineSessionId: item.data.engineSessionId,
        cwd: item.data.cwd,
        since: 0,
        stopped: false,
        inFlight: { promptRpcId: item.data.promptRpcId, brief: item.brief, text: "" },
      };
      if (known?.running === true) {
        this.watches.set(item.jobId, watch);
        void this.loop(watch);
        continue;
      }
      if (known === undefined) {
        this.settle(watch, "failed", "the box no longer has this session, and a session is not re-run");
        continue;
      }
      // Detached: a record from before the restart. Load it, in its own cwd, with the same command.
      try {
        await box.acpOpen({ session_id: item.jobId, command: known.command, cwd: item.data.cwd, engine_session_id: item.data.engineSessionId, env: {} });
      } catch (error) {
        this.settle(watch, "failed", `the engine could not load its session after the restart: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      this.watches.set(item.jobId, watch);
      this.settle(watch, "unknown", "the host restarted while the engine was working; its session was loaded again, but its answer to this brief is gone — read the log, then continue the session with a new brief");
      void this.loop(watch);
    }
  }

  private async answerTo(watch: Watch, rpcId: number, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    // A cursor of its own: the loop's cursor is the loop's. Events are kept, so both see all.
    const deadline = (this.deps.now ?? Date.now)() + timeoutMs;
    let since = 0;
    while ((this.deps.now ?? Date.now)() < deadline) {
      const page = await watch.box.acpEvents({ session_id: watch.jobId, since, timeout_ms: 1_000 });
      for (const event of page.events) {
        since = event.seq;
        if (event.kind === "response" && event.message?.id === rpcId) return event.message;
      }
      if (!page.running) return undefined;
    }
    return undefined;
  }

  private async loop(watch: Watch): Promise<void> {
    while (!watch.stopped) {
      let page: Awaited<ReturnType<AcpBox["acpEvents"]>>;
      try {
        page = await watch.box.acpEvents({ session_id: watch.jobId, since: watch.since, timeout_ms: this.deps.eventsTimeoutMs ?? 25_000 });
      } catch (error) {
        this.deps.log?.(`acp ${watch.jobId}: events unreachable (${error instanceof Error ? error.message : String(error)}); retrying`);
        await new Promise(resolve => setTimeout(resolve, 2_000));
        continue;
      }
      for (const event of page.events) {
        // A keeper told to stop while a poll was out hands nothing on: the next keeper will.
        if (watch.stopped) return;
        watch.since = event.seq;
        await this.handle(watch, event);
      }
      if (watch.stopped) return;
      if (!page.running) {
        // The engine is gone. A brief in flight is failed; the watch ends either way.
        if (watch.inFlight !== undefined) this.settle(watch, "failed", `the engine exited (${page.exit_code ?? "unknown"}) before answering`);
        watch.stopped = true;
        this.watches.delete(watch.jobId);
        return;
      }
    }
  }

  private async handle(watch: Watch, event: AcpEvent): Promise<void> {
    if (event.kind === "update") {
      const update = (event.message?.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string" && watch.inFlight !== undefined) {
        watch.inFlight.text += update.content.text;
      }
      return;
    }
    if (event.kind === "request") {
      await this.engineAsks(watch, event.message!);
      return;
    }
    if (event.kind === "response") {
      if (watch.inFlight === undefined || event.message?.id !== watch.inFlight.promptRpcId) return;
      const message = event.message;
      if (message.error !== undefined) {
        const text = String((message.error as { message?: unknown }).message ?? "the engine refused the prompt");
        this.settle(watch, "failed", `the engine reported a failure: ${text}`);
        return;
      }
      const stop = String((message.result as { stopReason?: unknown })?.stopReason ?? "");
      if (stop === "end_turn") this.settle(watch, "done", "the engine reported it completed the brief");
      else if (stop === "cancelled") this.settle(watch, "aborted", "the engine confirmed the cancel");
      else if (stop === "max_turn_requests") this.settle(watch, "aborted", "the engine reached its turn budget");
      else this.settle(watch, "failed", `the engine stopped with ${stop || "no reason"}`);
      return;
    }
    if (event.kind === "exit" && watch.inFlight !== undefined) {
      this.settle(watch, "failed", `the engine exited (${event.exit_code ?? "unknown"}) before answering`);
    }
  }

  /** The engine asked something. Only a permission question is answered; anything else is refused by name. */
  private async engineAsks(watch: Watch, message: Record<string, unknown>): Promise<void> {
    const rpcId = message.id as number | string;
    if (message.method !== "session/request_permission") {
      await watch.box.acpReply({ session_id: watch.jobId, rpc_id: rpcId, error: { code: -32601, message: `${String(message.method)} is not something this host answers` } }).catch(() => undefined);
      return;
    }
    const params = (message.params ?? {}) as { toolCall?: { name?: string; title?: string; rawInput?: unknown }; options?: { optionId: string; kind: string }[] };
    const engineTool = params.toolCall?.name ?? params.toolCall?.title ?? "tool";
    const input = params.toolCall?.rawInput !== null && typeof params.toolCall?.rawInput === "object" ? (params.toolCall.rawInput as Record<string, unknown>) : {};
    const allowOnce = params.options?.find(o => o.kind === "allow_once")?.optionId ?? "allow-once";
    const deny = params.options?.find(o => o.kind === "reject_once")?.optionId ?? "deny";
    const consent = await awaitDelegatedConsent(
      this.deps.policy,
      { agentId: watch.agentId, agentName: watch.agentName, jobId: watch.jobId, engineTool, input },
      { now: this.deps.now, pollMs: this.deps.consentPollMs, waitMs: this.deps.consentWaitMs, log: this.deps.log, by: "acp-delegate" }
    );
    if (watch.stopped) return;
    // Never allow-always: a grant that lives inside the engine is one the gate never sees again.
    const optionId = consent.allow ? allowOnce : deny;
    await watch.box.acpReply({ session_id: watch.jobId, rpc_id: rpcId, result: { outcome: { outcome: "selected", optionId } } }).catch(() => undefined);
    if (!consent.allow && consent.timedOut === true) {
      // The engine would hold the turn open for ever on a question nobody answered (measured);
      // the host ends it instead, and the brief settles as aborted when the engine confirms.
      this.deps.log?.(`acp ${watch.jobId}: consent timed out; cancelling the turn`);
      await watch.box.acpSend({ session_id: watch.jobId, method: "session/cancel", params: { sessionId: watch.engineSessionId }, notify: true }).catch(() => undefined);
    }
  }

  private settle(watch: Watch, outcome: "done" | "failed" | "aborted" | "unknown", why: string): void {
    const inFlight = watch.inFlight;
    watch.inFlight = undefined;
    if (inFlight === undefined) return;
    // Asked after the engine's word, never instead of it (INV-1258); the commit waits for git.
    void (async () => {
      const worktree = watch.box.exec !== undefined ? await worktreeState(watch.box as Pick<BoxClient, "exec">, watch.cwd) : undefined;
      const committed = this.deps.pendingWork?.commitDelegate(watch.jobId, outcome, { why, ...(worktree !== undefined ? { worktree: describeWorktree(worktree) } : {}) }) ?? true;
      if (!committed) return;
      const answer = outcome === "done" && inFlight.text.trim() !== "" ? ` Its answer: ${inFlight.text.trim().slice(0, 1_500)}` : "";
      this.deps.deliver(
        watch.agentId,
        `${delegateEndedNote(watch.jobId, inFlight.brief, { outcome, why, ...(worktree !== undefined ? { worktree } : {}) })}${answer} [The session stays open: continue it with Delegate session_id=${watch.jobId}, or close it.]`,
        watch.conversation
      );
    })();
  }
}
