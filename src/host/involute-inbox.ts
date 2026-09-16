/**
 * Answering the questions people put to our agents on a work item (INV-553, docs/54).
 *
 * Involute now carries the other half: a comment's `@handle` resolves to an actor
 * server-side, a mention from a human opens a ledger row with a deadline, and exactly one
 * consumer may hold it at a time (its `agent_request_claim` is a single-statement CAS with
 * a lease). This is our consumer — the "bridge" of docs/54 §A, and deliberately the
 * smallest thing that closes the loop:
 *
 *   `agent_inbox` → `agent_request_claim` → one turn → `agent_request_answer`
 *
 * Four rules that are not obvious, each from the design review:
 *
 * - **One at a time per agent, with the wait visible.** A person can @ one agent on twenty
 *   items in a morning. Since INV-554 that is a real queue: single concurrency, a capacity,
 *   and past it a refusal in words rather than silent queueing behind nineteen others.
 * - **Claim before work, and take the refusal quietly.** Two consumers will exist (ours
 *   and a Codex one). Losing the race is the normal case, not an error.
 * - **Answer, or say why not.** A turn that produced nothing is reported `failed` with a
 *   short reason rather than left to time out, because a person watching the thread
 *   should not have to wait out a deadline to learn that nothing happened.
 * - **A question back is `input-required`, not failure.** If the agent asked the person
 *   something during the turn, the request says so and keeps its place.
 *
 * Polling, not webhooks, on purpose: a laptop behind a NAT has no inbound port, and the
 * ledger is the same one either way — a webhook would only tell us to come and look.
 */

import { conversationIdFor } from "../agents/registry.ts";
import { ActorQueues, type QueueView } from "./actor-queue.ts";

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
  /** Whether this agent may answer this person at all (docs/54 §3.6). */
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

export class InvoluteConsumer {
  private readonly now: () => Date;
  /** One bounded queue per agent (INV-554); kept across passes, which is what makes it a queue. */
  private readonly queues: ActorQueues;

  constructor(private readonly deps: ConsumerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.queues = new ActorQueues({ capacity: deps.capacity ?? 8, concurrency: 1, now: this.now });
  }

  /** What each agent is answering and what is waiting behind it. */
  queueView(): QueueView[] {
    return this.queues.views();
  }

  /** One pass: every agent's inbox into its queue, then the one turn its queue allows. */
  async poll(): Promise<PollOutcome> {
    const outcome: PollOutcome = { answered: [], asked: [], failed: [], skipped: [], refused: [], queues: [] };
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
    }
  }

  /** Claims a request, or says why not. Losing the race to another consumer is normal. */
  private async claim(agent: InvoluteAgent, request: InboxRequest, outcome: PollOutcome): Promise<boolean> {
    try {
      await agent.call("agent_request_claim", { id: request.id });
      return true;
    } catch (error) {
      this.deps.log(`involute: ${agent.handle} did not get ${request.id} (${message(error)})`);
      outcome.skipped.push(request.id);
      return false;
    }
  }

  private async runOne(agent: InvoluteAgent, request: InboxRequest, outcome: PollOutcome): Promise<void> {
    // Claimed before anything else, including before deciding to refuse: holding the claim
    // is what gives the right to answer at all (the ledger refuses an answer from a caller
    // that does not hold it), and a refusal is an answer.
    if (!(await this.claim(agent, request, outcome))) return;

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
    // Read the item with the agent's own credential before answering about it, and put
    // what was written down at the time beside it. An agent asked "why" with neither is
    // being invited to invent (INV-551).
    let work = "";
    try {
      work = describeWork(await agent.call("work_get_context", { id: request.work_identifier ?? request.work_id }));
    } catch (error) {
      this.deps.log(`involute: ${agent.handle} could not read ${request.work_identifier ?? request.work_id} (${message(error)})`);
    }
    const receipts = this.deps.receiptsFor?.(`inv:${request.work_identifier ?? request.work_id}`) ?? "";
    let said = "";
    try {
      said = (
        await this.deps.runTurn({
          agentId: agent.agentId,
          prompt: promptFor(request, agent.agentName, agent.handle, { work, receipts }),
          conversation,
        })
      ).trim();
    } catch (error) {
      await this.answer(agent, request, `I could not finish looking into this: ${message(error)}`, "failed");
      outcome.failed.push(request.id);
      return;
    }
    if (said === "") {
      await this.answer(agent, request, "I ran and produced nothing worth posting — ask me again with more to go on.", "failed");
      outcome.failed.push(request.id);
      return;
    }
    const askedBack = this.deps.askedBack?.({ agentId: agent.agentId, conversation }) === true;
    await this.answer(agent, request, said, askedBack ? "input-required" : "completed");
    (askedBack ? outcome.asked : outcome.answered).push(request.id);
    this.deps.log(`involute: ${agent.handle} answered ${request.work_identifier ?? request.work_id} (${request.id})`);
  }

  private async answer(agent: InvoluteAgent, request: InboxRequest, body: string, state: "completed" | "failed" | "input-required"): Promise<void> {
    try {
      await agent.call("agent_request_answer", { id: request.id, body, state });
    } catch (error) {
      // The request stays claimed until its lease lapses and then returns to the queue.
      // Not swallowed silently: an answer that never landed is exactly the failure the
      // ledger exists to make visible.
      this.deps.log(`involute: ${agent.handle} could not post its answer to ${request.id} — ${message(error)}`);
    }
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
