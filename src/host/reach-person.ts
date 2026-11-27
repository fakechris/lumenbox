/**
 * An agent reaches its person (INV-2221, docs/109 §4): the route is the person, not the last chat.
 *
 * Until now an agent knew where to write only after it had been written to: the chat that asked is
 * what a question, an approval or a task's notice went back to. A member's own agent, made for them
 * at activation, had nowhere to say anything until its person happened to write first.
 *
 * **Whose an agent is.** The one person its box is for, when the box is one person's alone; else
 * the one person who made it their home agent, when exactly one did. Anything else — an agent in
 * a shared box that nobody, or several people, chose — is nobody's, and this file sends nothing
 * for it. There is no argument here that names a recipient for an agent: it is read off the
 * agent, so one member's agent cannot be pointed at another member.
 *
 * **Where a person is reached.** Through a door they hold an identity on now, whose bot may write
 * first: in the direct chat they last wrote in, when this process saw one, else by the person's own
 * key (`person-chat.ts`), which the vendor opens.
 *
 * **One sending path** (`tell`, and `tellOwner` for an agent): it is `push`, the chat doors' own
 * push, so the speaking right, the wait for a quiet conversation, the outbox receipt with its
 * bounded retries and its list of problems, and the record of what was sent all apply as they do
 * to any other notice; and the agent's daily allowance is asked first, as it is for a routine's
 * report. A vendor that will not let the bot write first is a failed receipt, once.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import { mayEnterBox } from "../box/membership.ts";
import { personChatKey } from "../channels/person-chat.ts";
import type { OutboundPurpose } from "./outbound.ts";
import type { Principal, Principals } from "./principals.ts";
import type { PushBudget } from "./push-budget.ts";

export interface Reached { delivered: boolean; why?: string }

export interface PersonReachDeps {
  registry: Pick<AgentRegistry, "tryGet" | "boxOf">;
  principals: Pick<Principals, "list" | "byId">;
  /** Whether this door's bot can write to a person who has not written to it: a connected DingTalk or Feishu door. */
  writesFirst(doorId: string): boolean;
  budget: Pick<PushBudget, "admit" | "perDayOf">;
  /** The chat doors' push (`ChannelManager.tryPushToChat`); undefined while no door is up. */
  push(chatKey: string, text: string, purpose: OutboundPurpose): Promise<Reached> | undefined;
  log(line: string): void;
}

function soleMember(box: Pick<BoxEntry, "members">): string | undefined {
  return Array.isArray(box.members) && box.members.length === 1 ? box.members[0] : undefined;
}

export class PersonReach {
  /** The direct chat each identity last wrote in, as this process saw it. */
  private readonly directChats = new Map<string, string>();

  constructor(private readonly deps: PersonReachDeps) {}

  /** A direct message arrived: that chat is where this identity is reached from now on. */
  noteDirect(identity: string, chatKey: string | undefined): void {
    if (chatKey !== undefined) this.directChats.set(identity, chatKey);
  }

  /** Whose this agent is; undefined when it is nobody's, or more than one person's. */
  ownerOf(agentId: string): Principal | undefined {
    const { registry, principals } = this.deps;
    if (registry.tryGet(agentId) === undefined) return undefined;
    const box = registry.boxOf(agentId), sole = soleMember(box);
    if (sole !== undefined) return principals.byId(sole);
    const homes = principals.list().filter(person => person.homeAgentId === agentId && mayEnterBox(box, person.id));
    return homes.length === 1 ? homes[0] : undefined;
  }

  /** Where this person is reached: the identity it goes through and the chat's key. Undefined when no door of theirs can write to them. */
  addressOf(principalId: string): { adapterName: string; identity: string; chatKey: string } | undefined {
    for (const identity of this.deps.principals.byId(principalId)?.identities ?? []) {
      const adapterName = identity.split(":")[0] ?? "", chatKey = this.directChats.get(identity) ?? personChatKey(identity);
      if (chatKey !== undefined && this.deps.writesFirst(adapterName)) return { adapterName, identity, chatKey };
    }
    return undefined;
  }

  /** Where an agent's person is reached; undefined when the agent is nobody's or they cannot be written to. */
  addressFor(agentId: string): { adapterName: string; identity: string; chatKey: string } | undefined {
    const owner = this.ownerOf(agentId);
    return owner === undefined ? undefined : this.addressOf(owner.id);
  }

  /**
   * One message to this person, through a door they hold. `from`: the agent whose message it is —
   * it is counted against that agent's daily allowance, and past it the message is held for the
   * chat's digest like any other. `exempt`: it needs the person (a decision, their agent being
   * ready) and is never held.
   */
  async tell(principalId: string, text: string, why: { about: string; from?: string; exempt?: boolean }): Promise<Reached> {
    const address = this.addressOf(principalId);
    if (address === undefined) return { delivered: false, why: `${principalId} holds no identity on a channel whose bot can write to them` };
    const { chatKey } = address;
    if (this.deps.budget.admit({ ...(why.from !== undefined ? { agentId: why.from } : {}), chatKey, text, exempt: why.exempt === true }) === "hold") {
      this.deps.log(`message from ${why.from} to ${principalId} held for today's digest: past its ${this.deps.budget.perDayOf(why.from!)}-a-day allowance`);
      return { delivered: true, why: "held for today's digest: past the agent's daily allowance" };
    }
    const sent = await (this.deps.push(chatKey, text, { kind: "notice", about: why.about, ...(why.exempt === true ? { urgent: true } : {}), ...(why.from !== undefined ? { from: why.from } : {}) })
      ?? Promise.resolve({ delivered: false, why: "no channels are configured" }));
    if (!sent.delivered) this.deps.log(`message to ${principalId} through ${address.adapterName} not delivered: ${sent.why ?? "no reason given"}`);
    return sent;
  }

  /** An agent tells its own person something. Nobody else can be named. */
  tellOwner(agentId: string, text: string, why: { about: string; exempt?: boolean }): Promise<Reached> {
    const owner = this.ownerOf(agentId);
    if (owner === undefined) return Promise.resolve({ delivered: false, why: `${agentId} is no one person's agent` });
    return this.tell(owner.id, text, { ...why, from: agentId });
  }
}
