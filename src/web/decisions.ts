/**
 * What waits on a person, read once for the page and the client API (INV-2214, docs/106 §4.2).
 *
 * The page's "waiting on you" (`GET /api/attention`) and `GET /api/v1/inbox` are one projection:
 * `attentionFor` (host/attention.ts) over the same records — approvals, Outbox drafts, questions,
 * the board's close proposals, reviews and requests, chains the bus paused, routines the host held,
 * failures handed to a person — each filtered by what the person may reach. This is where those
 * records are gathered and filtered, so the two surfaces cannot drift apart. What the page adds on
 * top for Admins (box updates, spend limits, providers at rest) stays the page's.
 */

import type { PausedChain } from "../agents/bus.ts";
import { type Attention, attentionFor } from "../host/attention.ts";
import type { ExceptionEntry } from "../host/exceptions.ts";
import type { Draft } from "../host/outbox-drafts.ts";
import type { PendingApproval } from "../host/policy.ts";
import type { WatchedQuestion } from "../host/question-expiry.ts";
import type { Task } from "../host/tasks.ts";

/** The records decisions are made from, as the server has them now. */
export interface DecisionWorld {
  tasks(): readonly Task[];
  questions(): readonly WatchedQuestion[];
  approvals(): readonly PendingApproval[];
  drafts(): readonly Draft[];
  paused(): readonly PausedChain[];
  exceptions(): readonly ExceptionEntry[];
  /** Routines the host stopped, with the box each runs in (undefined: the installation's own). */
  routinesHeld(): Promise<readonly { slug: string; name: string; at: string; by: string; code: string; reason: string; boxId?: string }[]>;
  undeliverable(): readonly { id: string; chatKey: string; purpose: string; attempts: number; lastError?: string }[];
  /** Questions put to an agent on outside work that nobody answered: the operator's alone. */
  unanswered(): readonly { work: string; agent: string; detail: string; deadline?: string }[];
  nameOf(id: string): string;
  personIds(): ReadonlySet<string>;
  agentIds(): ReadonlySet<string>;
  chatKeyOf(conversation: string): string | undefined;
  active(task: Task): boolean;
  checkPending(task: Task): boolean;
  workOf(agentId: string): string;
  /** The installation's own box, where a routine with no box runs. */
  defaultBoxId(): string;
}

/** Who is looking, and what they may reach (reach.ts). `all`: the installation's own credential, the operator. */
export interface Viewer {
  principalId: string;
  identities: readonly string[];
  all: boolean;
  sees: { agent(agentId: string): boolean; box(boxId: string): boolean; task(task: Task): boolean };
}

export async function decisionsFor(world: DecisionWorld, viewer: Viewer): Promise<Attention> {
  const { sees, all } = viewer;
  const agentOk = (agentId: string | undefined) => all || agentId === undefined || sees.agent(agentId);
  return attentionFor({
    principalId: viewer.principalId,
    identities: viewer.identities,
    tasks: world.tasks().filter(task => all || sees.task(task)),
    // A question is its agent's: nobody outside that agent's boxes is asked it.
    questions: world.questions().filter(question => agentOk(question.agentId)),
    nameOf: world.nameOf,
    unanswered: world.unanswered(),
    workOf: world.workOf,
    personIds: world.personIds(),
    // A chain is shown to whoever reaches either of its two agents: names and turns of agents nobody may see stay unseen.
    paused: world.paused().filter(chain => all || sees.agent(chain.fromId) || sees.agent(chain.toId)),
    agentIds: world.agentIds(),
    approvals: world.approvals().filter(item => agentOk(item.agentId)),
    outbox: world.drafts().filter(draft => agentOk(draft.agentId)),
    undeliverable: world.undeliverable(),
    exceptionsHanded: world.exceptions().filter(entry => entry.handedAt !== undefined && entry.resolvedAt === undefined && agentOk(entry.agent)),
    routinesHeld: (await world.routinesHeld()).filter(entry => sees.box(entry.boxId ?? world.defaultBoxId())).map(({ slug, name, at, by, code, reason }) => ({ slug, name, at, by, code, reason })),
    chatKeyOf: world.chatKeyOf,
    active: world.active,
    checkPending: world.checkPending,
    ...(all ? { all: true } : {}),
  });
}
