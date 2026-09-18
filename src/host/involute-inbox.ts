/**
 * Answering the questions people put to our agents on a work item (INV-553, docs/54).
 *
 * Involute now carries the other half: a comment's `@handle` resolves to an actor
 * server-side, a mention from a human opens a ledger row with a deadline, and exactly one
 * *execution* may hold it at a time. This is our consumer — the "bridge" of docs/54 §A, and
 * deliberately the smallest thing that closes the loop:
 *
 *   `agent_inbox` → `agent_request_claim` → one turn → `agent_request_answer`
 *
 * Five rules that are not obvious, each from the design review or from the ledger's own
 * contract:
 *
 * - **The claim belongs to an execution, not to an actor (INV-582).** `agent_request_claim`
 *   returns a `claim_token`; answering and renewing require it, and a stale session of the
 *   same actor is refused. The token is kept for the life of the turn and the 60-second lease
 *   is renewed while the turn runs — a turn is usually longer than a minute, and an answer
 *   arriving after the lease lapsed is refused as somebody else's.
 * - **One at a time per agent, with the wait visible.** A person can @ one agent on twenty
 *   items in a morning. Since INV-554 that is a real queue: single concurrency, a capacity,
 *   and past it a refusal in words rather than silent queueing behind nineteen others.
 * - **Claim before work, and take the refusal quietly.** Two consumers will exist (ours
 *   and a Codex one). Losing the race is the normal case, not an error.
 * - **When the agent cannot answer, the request is left open for the ledger's hand-off,
 *   not closed (INV-582, INV-589).** The ledger hands a request to the declared successor
 *   *when its deadline passes* — by opening a new request to them, never by letting them
 *   claim this one — and it only hands off a request that is still open. So a stand-in is
 *   arranged by saying, in the thread, that no answer is coming from here, as
 *   `input-required`, which posts the words and hands the claim back. `failed` is for when
 *   there is nobody to hand to.
 * - **A question back is `input-required`, not failure.** If the agent asked the person
 *   something during the turn, the request says so and keeps its place.
 *
 * Polling, not webhooks, on purpose: a laptop behind a NAT has no inbound port, and the
 * ledger is the same one either way — a webhook would only tell us to come and look.
 */

import { randomUUID } from "node:crypto";
import { conversationIdFor } from "../agents/registry.ts";
import { ActorQueues, type QueueView } from "./actor-queue.ts";
import { type StandIn, type Successor, standInAttribution, standInCheck, standInPrompt, unansweredDetail } from "./successor.ts";

/** A row as `agent_inbox` returns it. */
export interface InboxRequest {
  id: string;
  work_id: string;
  work_identifier?: string;
  root_comment_id?: string | null;
  body: string;
  state: string;
  deadline_at?: string;
  requested_by_actor_id?: string;
  claimed_by?: string | null;
  /**
   * Set when this request was opened by the ledger's hand-off from one that went unanswered
   * (INV-589): the id of the request it continues. The answer then says so (INV-582 A4).
   * Optional on the wire — proposed to the ledger; absent, a handed-off question reads as a
   * fresh one and is answered as such.
   */
  handed_off_from_id?: string | null;
  /** The handle of the actor first asked, when the ledger says. */
  handed_off_from_handle?: string | null;
  hop_count?: number;
}

/** One of our agents, with the credential that makes it itself on the other side. */
export interface InvoluteAgent {
  agentId: string;
  agentName: string;
  handle: string;
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface ConsumerDeps {
  agents: () => readonly InvoluteAgent[];
  /**
   * What was written down about this work item when the decisions were made (INV-551).
   *
   * Without it, "why did you decide X" can only be answered from an impression. The live
   * test that proved the loop also proved this: the agent answered, correctly, that it
   * had nothing to go on — which is the right answer and a useless one.
   */
  receiptsFor?: (subject: string) => string;
  /** Runs one turn in the thread's own conversation and returns what the agent said. */
  runTurn: (input: { agentId: string; prompt: string; conversation: string }) => Promise<string>;
  /** Whether this agent may answer this person at all (docs/54 §3.6, INV-575). */
  mayAnswer: (input: { agentId: string; requestedByActorId: string | undefined }) => { ok: true } | { ok: false; why: string };
  /** Whether the agent left a question of its own open during that turn (INV-526). */
  askedBack?: (input: { agentId: string; conversation: string }) => boolean;
  /**
   * Whether this turn may be paid for, asked **before** it runs (INV-554 A4).
   *
   * The policy gate reads tokens already spent, which answers "have we overspent" after the
   * money is gone. A question that cannot be paid for should be refused while it is still
   * a question — the person hears a reason instead of watching a deadline pass.
   */
  mayAfford?: (input: { agentId: string; payer: string | undefined }) => { ok: true } | { ok: false; why: string };
  /** How many questions may wait per agent before the next is refused. Default 8. */
  capacity?: number;
  /**
   * Who answers when this agent cannot (INV-556). Named here so the words in the thread can
   * say who to expect; the hand-off itself is the ledger's, from the successor declared on
   * the actor over there (`successorActorId`), and this should name the same one.
   */
  successorFor?: (handle: string) => Successor | undefined;
  /**
   * Whether this agent could take a turn at all right now — its record is still here, its
   * box answers. When it cannot, the request is still claimed in its name for exactly one
   * purpose: to say, in its own words, that no answer is coming from here, so the ledger's
   * hand-off has something to go on and the asker is not left to wait out a deadline.
   */
  canRun?: (agentId: string) => boolean;
  /** Recorded on the ledger's audit with every claim and answer, so the session can be found later. */
  sessionId?: string;
  /** How often a held claim is renewed while a turn runs. Default 25s against the ledger's 60s lease. */
  renewMs?: number;
  log: (line: string) => void;
  now?: () => Date;
}

export interface PollOutcome {
  answered: string[];
  asked: string[];
  failed: string[];
  skipped: string[];
  /** Turned down because the agent already had a queue full of them (INV-554). */
  refused: string[];
  /** Answered by a declared stand-in, under its own name, after the ledger handed it over (INV-556, INV-582). */
  stoodIn: string[];
  /** Left open in words for the ledger to hand to the successor when the deadline passes (INV-582). */
  heldForHandoff: string[];
  /** Nobody answered, and this is who to ask. The attention projection reads these. */
  unanswered: { id: string; work: string; agent: string; detail: string }[];
  /** What is waiting, per agent, so a queue is something a person can see. */
  queues: QueueView[];
}

/** The conversation a thread's turns run in: one per thread, so two questions never cross. */
export function conversationFor(request: Pick<InboxRequest, "work_identifier" | "work_id" | "root_comment_id">): string {
  const work = request.work_identifier ?? request.work_id;
  const thread = request.root_comment_id ?? "main";
  return conversationIdFor(`involute:${work}:${thread}`);
}

/**
 * What the agent is asked to do, in the words the answer has to live up to.
 *
 * The instruction about evidence is the whole reason this is a prompt and not a template:
 * an agent asked "why did you decide X" three months on will produce a fluent story if
 * nothing stops it. What stops it is being told, in the same breath, that an answer with
 * no citation must say so (docs/54 §3.6, docs/20).
 */
export function promptFor(
  request: InboxRequest,
  agentName: string,
  handle: string,
  context?: { work?: string; receipts?: string }
): string {
  const work = request.work_identifier ?? request.work_id;
  return (
    `[involute ${work}] You are @${handle} on Involute, the work tracker. Somebody asked you ` +
    `this on the work item:\n\n${request.body}\n\n` +
    (context?.work !== undefined && context.work !== "" ? `The work item, as it stands:\n${context.work}\n\n` : "") +
    (context?.receipts !== undefined && context.receipts !== "" ? `${context.receipts}\n\n` : "") +
    `Answer them in a few sentences, as ${agentName}. Rules for this answer:\n` +
    `- Cite what it rests on — a run, a PR, a test, a line in the record — and link it.\n` +
    `- If the record does not show why it was decided, say "the record does not show it" and ` +
    `say what you can reconstruct now, marked as reconstruction. Do not invent a reason that sounds right.\n` +
    `- If you need something from them before you can answer, ask it plainly; the question goes back to them.\n` +
    `- No status theatre: they can read the board. Answer the question they asked.`
  );
}

/** The contract as one readable block: enough to answer from, short enough to be read. */
export function describeWork(context: unknown): string {
  if (context === null || typeof context !== "object") return "";
  const work = ((context as Record<string, unknown>).work ?? context) as Record<string, unknown>;
  const lines: string[] = [];
  const say = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") lines.push(`${label}: ${value.trim().slice(0, 600)}`);
  };
  say("title", work.title);
  say("state", typeof work.state === "object" && work.state !== null ? (work.state as Record<string, unknown>).name : work.state);
  say("outcome", work.outcome);
  say("acceptance", work.acceptance);
  say("verification", work.verification);
  say("description", work.description);
  const runs = (context as Record<string, unknown>).runs;
  if (Array.isArray(runs) && runs.length > 0) {
    const recent = runs.slice(-3).map(run => {
      const row = run as Record<string, unknown>;
      return `${String(row.status ?? "?")} ${String(row.summary ?? "").slice(0, 200)}`;
    });
    lines.push(`recent runs: ${recent.join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * What is said, in the thread, when no answer is coming from here and a stand-in is
 * declared: the fact and who to expect. Posted as `input-required` so the request stays
 * open for the ledger to hand off; `failed` would close it and nobody would be handed
 * anything (INV-582).
 */
export function heldForHandoffNote(input: { agentName: string; successor: Successor; because?: string }): string {
  const seen = input.because !== undefined && input.because.trim() !== "" ? ` From this side: ${input.because.trim()}.` : "";
  const next =
    input.successor.kind === "agent"
      ? `When the deadline passes, the ledger hands this to @${input.successor.handle}, its declared stand-in, who answers in their own name.`
      : `When the deadline passes, the ledger hands this to ${input.successor.name}, who is named as its stand-in.`;
  return `No answer is coming from ${input.agentName} on this one.${seen} ${next}`;
}

/** Against the ledger's 60s lease: renew well inside it, and never so often as to be noise. */
const DEFAULT_RENEW_MS = 25_000;

export class InvoluteConsumer {
  private readonly now: () => Date;
  private readonly sessionId: string;
  private readonly renewMs: number;
  /** One bounded queue per agent (INV-554); kept across passes, which is what makes a queue. */
  private readonly queues: ActorQueues;
  /** The claim token of each request this execution holds, for as long as it holds it. */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly deps: ConsumerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sessionId = deps.sessionId ?? `lumenbox:${randomUUID()}`;
    this.renewMs = deps.renewMs ?? DEFAULT_RENEW_MS;
    this.queues = new ActorQueues({ capacity: deps.capacity ?? 8, concurrency: 1, now: this.now });
  }

  /** What each agent is answering and what is waiting behind it. */
  queueView(): QueueView[] {
    return this.queues.views();
  }

  /** One pass: every agent's inbox into its queue, then the one turn its queue allows. */
  async poll(): Promise<PollOutcome> {
    const outcome: PollOutcome = { answered: [], asked: [], failed: [], skipped: [], refused: [], stoodIn: [], heldForHandoff: [], unanswered: [], queues: [] };
    for (const agent of this.deps.agents()) {
      try {
        await this.pollOne(agent, outcome);
      } catch (error) {
        this.deps.log(`involute: ${agent.handle} inbox failed — ${message(error)}`);
      }
    }
    outcome.queues = this.queues.views();
    return outcome;
  }

  private async pollOne(agent: InvoluteAgent, outcome: PollOutcome): Promise<void> {
    const page = (await agent.call("agent_inbox", { first: 20 })) as { requests?: InboxRequest[] } | undefined;
    const requests = page?.requests ?? [];
    const queue = this.queues.for(agent.handle);
    const seen = new Map<string, InboxRequest>();

    for (const request of requests) {
      seen.set(request.id, request);
      // Withdrawn, or already closed by somebody else. Remembered as cancelled rather than
      // merely dropped: the next pass, a redelivery or a restart will offer this id again,
      // and answering a question that was taken back is worse than being slow (INV-554 A3).
      if (request.state === "canceled" || request.state === "cancelled" || request.state === "failed" || request.state === "completed") {
        queue.cancel(request.id);
        continue;
      }
      const admission = queue.offer({
        id: request.id,
        subject: request.work_identifier ?? request.work_id,
        ...(request.deadline_at !== undefined ? { deadlineAt: Date.parse(request.deadline_at) } : {}),
        ...(request.requested_by_actor_id !== undefined ? { payer: request.requested_by_actor_id } : {}),
      });
      if (admission.accepted) continue;
      if (admission.reason === "lapsed") {
        // Past its deadline: the ledger's own sweep owns it, and answering into a closed
        // request would be a second answer to a question nobody is still waiting on.
        outcome.skipped.push(request.id);
        continue;
      }
      if (admission.reason === "full") {
        if (await this.claim(agent, request, outcome)) {
          await this.answer(agent, request, admission.why, "failed");
          outcome.refused.push(request.id);
          this.deps.log(`involute: ${agent.handle} turned down ${request.id} — queue full (${queue.depth} waiting)`);
        }
        continue;
      }
      // `known`: an ordinary pass re-offering what it offered last time, and `cancelled`:
      // already answered for. Neither is worth a word.
    }

    // Anything we were holding that the inbox no longer lists has been withdrawn or taken by
    // somebody else. Dropped and remembered, so a redelivery of the same id does not revive it.
    for (const id of queue.retainOnly(new Set(requests.map(row => row.id)))) {
      this.tokens.delete(id);
      this.deps.log(`involute: ${agent.handle} dropped ${id} — no longer in the inbox`);
    }

    const next = queue.next();
    if (next === undefined) return;
    const request = seen.get(next.id);
    if (request === undefined) {
      // It was queued from an earlier pass and the inbox no longer lists it — answered
      // elsewhere, or withdrawn. Release the slot rather than hold it for a ghost.
      queue.done(next.id);
      return;
    }
    try {
      await this.runOne(agent, request, outcome);
    } finally {
      queue.done(next.id);
      this.tokens.delete(request.id);
    }
  }

  /**
   * Claims a request, or says why not. Losing the race to another consumer is normal.
   *
   * The token that comes back is this execution's right to answer and to renew, and is
   * not recoverable: the ledger refuses an answer without it, and refuses one from a
   * different session of the same actor (INV-582).
   */
  private async claim(agent: InvoluteAgent, request: InboxRequest, outcome: PollOutcome): Promise<boolean> {
    try {
      const result = (await agent.call("agent_request_claim", { id: request.id, session_id: this.sessionId })) as { claim_token?: unknown } | undefined;
      if (typeof result?.claim_token === "string" && result.claim_token !== "") this.tokens.set(request.id, result.claim_token);
      return true;
    } catch (error) {
      this.deps.log(`involute: ${agent.handle} did not get ${request.id} (${message(error)})`);
      outcome.skipped.push(request.id);
      return false;
    }
  }

  /** Renews the held claim while `work` runs, so an answer at the end is still ours to give. */
  private async whileHolding<T>(agent: InvoluteAgent, request: InboxRequest, work: () => Promise<T>): Promise<T> {
    const token = this.tokens.get(request.id);
    if (token === undefined) return work();
    const timer = setInterval(() => {
      void agent.call("agent_request_claim", { id: request.id, claim_token: token, session_id: this.sessionId }).catch((error: unknown) => {
        // Said once per failure and not retried harder: if the lease is gone, the answer
        // will be refused and that refusal is logged where it happens.
        this.deps.log(`involute: ${agent.handle} could not renew its claim on ${request.id} (${message(error)})`);
      });
    }, this.renewMs);
    timer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  private async runOne(agent: InvoluteAgent, request: InboxRequest, outcome: PollOutcome): Promise<void> {
    // Claimed before anything else, including before deciding to refuse: holding the claim
    // is what gives the right to answer at all (the ledger refuses an answer from a caller
    // that does not hold it), and a refusal is an answer.
    if (!(await this.claim(agent, request, outcome))) return;

    // Known not to be able to answer — its record is gone, its box does not respond. Said in
    // its own words and left open for the ledger's hand-off; not answered `failed`, which
    // would close the request and hand nobody anything (INV-582).
    if (this.deps.canRun?.(agent.agentId) === false) {
      this.deps.log(`involute: ${agent.handle} cannot take a turn; leaving ${request.id} open for the ledger's hand-off`);
      await this.giveUp(agent, request, outcome, `${agent.agentName} is not able to run here at the moment`);
      return;
    }

    const allowed = this.deps.mayAnswer({ agentId: agent.agentId, requestedByActorId: request.requested_by_actor_id });
    if (!allowed.ok) {
      // Said out loud rather than ignored: a person who asked and hears nothing assumes
      // the system is broken, which is worse than being told the rule.
      await this.answer(agent, request, `I cannot answer this one: ${allowed.why}`, "failed");
      outcome.failed.push(request.id);
      this.deps.log(`involute: ${agent.handle} refused ${request.id} — ${allowed.why}`);
      return;
    }

    // Before the turn, not after it: a question that cannot be paid for is refused while it
    // is still a question, rather than discovered when the bill is already spent (INV-554).
    const affordable = this.deps.mayAfford?.({ agentId: agent.agentId, payer: request.requested_by_actor_id }) ?? { ok: true as const };
    if (!affordable.ok) {
      await this.answer(agent, request, `I cannot take this one right now: ${affordable.why}`, "failed");
      outcome.failed.push(request.id);
      this.deps.log(`involute: ${agent.handle} could not pay for ${request.id} — ${affordable.why}`);
      return;
    }

    const conversation = conversationFor(request);
    const work = request.work_identifier ?? request.work_id;
    // Read the item with the agent's own credential before answering about it, and put
    // what was written down at the time beside it. An agent asked "why" with neither is
    // being invited to invent (INV-551).
    let item = "";
    try {
      item = describeWork(await agent.call("work_get_context", { id: work }));
    } catch (error) {
      this.deps.log(`involute: ${agent.handle} could not read ${work} (${message(error)})`);
    }
    const receipts = this.deps.receiptsFor?.(`inv:${work}`) ?? "";

    // A request the ledger handed to this agent after another went unanswered (INV-589) is
    // answered as a stand-in: in this agent's own name, from the record, with the relation
    // stated — never as if the question had been put to it first (INV-582 A4, docs/54 §D).
    const standIn = standInFor(agent, request);
    const prompt =
      standIn !== undefined
        ? standInPrompt({ body: request.body, work }, standIn, { item, receipts })
        : promptFor(request, agent.agentName, agent.handle, { work: item, receipts });

    let said = "";
    try {
      said = (await this.whileHolding(agent, request, () => this.deps.runTurn({ agentId: agent.agentId, prompt, conversation }))).trim();
    } catch (error) {
      this.deps.log(`involute: ${agent.handle} could not answer ${request.id} — ${message(error)}`);
      await this.giveUp(agent, request, outcome, `I could not finish looking into this: ${message(error)}`);
      return;
    }
    if (said === "") {
      this.deps.log(`involute: ${agent.handle} produced nothing for ${request.id}`);
      await this.giveUp(agent, request, outcome, "I ran and produced nothing worth posting");
      return;
    }
    const askedBack = this.deps.askedBack?.({ agentId: agent.agentId, conversation }) === true;
    if (standIn !== undefined) {
      const guard = standInCheck({ postingAs: agent.handle, standIn });
      if (!guard.ok) {
        // Unreachable by construction — the stand-in is the agent whose credential this is —
        // and checked anyway: the day this becomes reachable is the day a refactor has quietly
        // made impersonation possible.
        this.deps.log(`involute: ${guard.why}`);
        return;
      }
      said = `${said}\n\n${standInAttribution(standIn, receipts !== "" ? "what is written down on this item" : undefined)}`;
    }
    await this.answer(agent, request, said, askedBack ? "input-required" : "completed");
    (askedBack ? outcome.asked : standIn !== undefined ? outcome.stoodIn : outcome.answered).push(request.id);
    this.deps.log(`involute: ${agent.handle} answered ${work} (${request.id})${standIn !== undefined ? ` standing in after a hand-off` : ""}`);
  }

  /**
   * The agent that was asked could not answer. What happens next is the ledger's: it hands
   * the request to the declared successor when the deadline passes — by opening a new request
   * to them, never by letting them take this one (INV-589). So this side's job is to say, in
   * the thread and in the agent's own name, that no answer is coming from here, and to leave
   * the request open so there is something to hand off. With nobody declared, it is closed
   * `failed` with the fact and who to ask — never a guess about why (INV-556 A4).
   */
  private async giveUp(agent: InvoluteAgent, request: InboxRequest, outcome: PollOutcome, because: string): Promise<void> {
    const work = request.work_identifier ?? request.work_id;
    const successor = this.deps.successorFor?.(agent.handle);
    if (successor !== undefined) {
      const note = heldForHandoffNote({ agentName: agent.agentName, successor, because });
      await this.answer(agent, request, note, "input-required");
      outcome.heldForHandoff.push(request.id);
      outcome.unanswered.push({ id: request.id, work, agent: agent.agentName, detail: note });
      this.deps.log(`involute: ${agent.handle} left ${request.id} open for the ledger to hand to ${successor.kind === "agent" ? `@${successor.handle}` : successor.name}`);
      return;
    }
    const detail = unansweredDetail({ originalName: agent.agentName, successor: undefined, because });
    await this.answer(agent, request, detail, "failed");
    outcome.failed.push(request.id);
    outcome.unanswered.push({ id: request.id, work, agent: agent.agentName, detail });
  }

  private async answer(agent: InvoluteAgent, request: InboxRequest, body: string, state: "completed" | "failed" | "input-required"): Promise<void> {
    const token = this.tokens.get(request.id);
    try {
      await agent.call("agent_request_answer", {
        id: request.id,
        body,
        state,
        session_id: this.sessionId,
        ...(token !== undefined ? { claim_token: token } : {}),
      });
    } catch (error) {
      // The request stays claimed until its lease lapses and then returns to the queue.
      // Not swallowed silently: an answer that never landed is exactly the failure the
      // ledger exists to make visible.
      this.deps.log(`involute: ${agent.handle} could not post its answer to ${request.id} — ${message(error)}`);
    }
  }
}

/** The stand-in relation a handed-off request implies for the agent now holding it, or undefined for a question put to it first. */
function standInFor(agent: InvoluteAgent, request: InboxRequest): StandIn | undefined {
  if (request.handed_off_from_id === undefined || request.handed_off_from_id === null || request.handed_off_from_id === "") return undefined;
  const original = request.handed_off_from_handle?.replace(/^@/, "") ?? "";
  return {
    ...(original !== "" ? { originalHandle: original, originalName: `@${original}` } : { originalName: "the agent this was first put to" }),
    handle: agent.handle,
    name: agent.agentName,
  };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
