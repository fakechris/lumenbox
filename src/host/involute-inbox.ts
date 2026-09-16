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
 * - **One at a time per agent.** A person can @ one agent on twenty items in a morning.
 *   Until the budget work lands (INV-554), the queue is the inbox itself and this takes
 *   one request per agent per pass; the rest stay `submitted` and are claimed later.
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
  log: (line: string) => void;
  now?: () => Date;
}

export interface PollOutcome {
  answered: string[];
  asked: string[];
  failed: string[];
  skipped: string[];
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

  constructor(private readonly deps: ConsumerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One pass: at most one request per agent, claimed, answered, and recorded. */
  async poll(): Promise<PollOutcome> {
    const outcome: PollOutcome = { answered: [], asked: [], failed: [], skipped: [] };
    for (const agent of this.deps.agents()) {
      try {
        await this.pollOne(agent, outcome);
      } catch (error) {
        this.deps.log(`involute: ${agent.handle} inbox failed — ${message(error)}`);
      }
    }
    return outcome;
  }

  private async pollOne(agent: InvoluteAgent, outcome: PollOutcome): Promise<void> {
    const page = (await agent.call("agent_inbox", { first: 10 })) as { requests?: InboxRequest[] } | undefined;
    const requests = page?.requests ?? [];
    if (requests.length === 0) return;
    const now = this.now().getTime();
    for (const request of requests) {
      // Past its deadline: the server's own sweep owns it, and answering into a failed
      // request would be a second answer to a question that has already been closed.
      if (request.deadline_at !== undefined && Date.parse(request.deadline_at) <= now) {
        outcome.skipped.push(request.id);
        continue;
      }
      // Claimed before anything else, including before deciding to refuse: holding the
      // claim is what gives the right to answer at all (the ledger refuses an answer from
      // a caller that does not hold it), and a refusal is an answer. Losing the race to
      // the other consumer is the normal case, not an error.
      let claimed = false;
      try {
        await agent.call("agent_request_claim", { id: request.id });
        claimed = true;
      } catch (error) {
        this.deps.log(`involute: ${agent.handle} did not get ${request.id} (${message(error)})`);
        outcome.skipped.push(request.id);
      }
      if (!claimed) continue;

      const allowed = this.deps.mayAnswer({ agentId: agent.agentId, requestedByActorId: request.requested_by_actor_id });
      if (!allowed.ok) {
        // Said out loud rather than ignored: a person who asked and hears nothing assumes
        // the system is broken, which is worse than being told the rule.
        await this.answer(agent, request, `I cannot answer this one: ${allowed.why}`, "failed");
        outcome.failed.push(request.id);
        this.deps.log(`involute: ${agent.handle} refused ${request.id} — ${allowed.why}`);
        continue;
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
        continue;
      }
      if (said === "") {
        await this.answer(agent, request, "I ran and produced nothing worth posting — ask me again with more to go on.", "failed");
        outcome.failed.push(request.id);
        continue;
      }
      const askedBack = this.deps.askedBack?.({ agentId: agent.agentId, conversation }) === true;
      await this.answer(agent, request, said, askedBack ? "input-required" : "completed");
      (askedBack ? outcome.asked : outcome.answered).push(request.id);
      this.deps.log(`involute: ${agent.handle} answered ${request.work_identifier ?? request.work_id} (${request.id})`);
      // One per agent per pass: the next one is claimed on the next tick, which is the
      // whole of the concurrency rule until INV-554 gives it a real budget.
      return;
    }
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
