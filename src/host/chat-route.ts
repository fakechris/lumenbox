/**
 * Who a chat message reaches (INV-2221, docs/109 §4).
 *
 * An organisation shares one bot; behind it each member has an agent of their own, in a box only
 * they may enter. So the agent a message goes to depends on who wrote it, and this file is the one
 * place that says how. Three questions, each answered here and nowhere else:
 *
 * **Who answers when they name nobody** (`unnamed`), in this order:
 *  1. In a direct message: the person's home agent, when it still exists and they may enter its box.
 *  2. In a direct message: nobody yet, when their own box is queued or starting — they are told their
 *     assistant is being prepared. Before the door's default, because what somebody writes to the
 *     bot alone is meant for their own agent, and a shared box's agent is not that.
 *  3. The door's default agent. In a direct message only when they may enter its box; in a room as
 *     it always was (the turn's own membership check refuses there, by name).
 *  4. In a direct message: the one agent they may reach, when there is exactly one — it is the only
 *     one they could mean (docs/22 §2: "the box's only agent, an error when ambiguous").
 *  5. On a single-machine installation only: its first agent, as before — one person, every agent
 *     theirs, and doors there were set up with no default.
 *  6. Nobody. A direct message is told so, with what to do; a room is told once, then left alone.
 *
 * **Who `@Name` names** (`named`): an agent in a box the speaker may enter — one in a box that is
 * theirs alone before one in a box they share. Two members' agents of one name never meet. A name
 * (or an id) that exists only where the speaker may not enter is answered exactly as one that does
 * not exist.
 *
 * **Who a turn may be run for** (`asked`): the same two, asked again by the turn itself, so that
 * nothing arriving there by another path reaches an agent this file would not have given.
 *
 * What is returned is an agent id, never a name: a name is ambiguous the moment two boxes hold one.
 */

import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import { mayEnterBox, refusalToEnter } from "../box/membership.ts";
import { resolveLocale, type Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";
import type { Principals } from "./principals.ts";

export interface ChatRouteDeps {
  registry: Pick<AgentRegistry, "list" | "tryGet" | "boxOf" | "resolve">;
  principals: Pick<Principals, "resolve" | "installation" | "byId" | "setHomeAgent">;
  /** The door a message came through: its default agent as it was written (an id or a name), and its vendor, for the language. */
  door(adapterName: string): { defaultAgent?: string; type?: string } | undefined;
  /** This person's own box is queued or starting (INV-2220): their agent is made when it has come up. */
  preparing(principalId: string): boolean;
  /** A single-machine installation with no agent at all makes its first one, as it always has. */
  firstAgent(): AgentRecord;
  log(line: string): void;
}

/** Where a message came from: who wrote it, and whether to the bot alone. */
export interface ChatOrigin {
  identity: string;
  privateChat?: boolean;
  chatKey?: string;
}

/** An agent as the chat door carries it: the id everything below is given, and the name a person reads. */
export interface ChatAgent { id: string; name: string }

/** What the door is told about one message. */
export interface ChatAddress {
  /** The agent the message names. */
  agent?: ChatAgent;
  /** The answer when it names one this person cannot reach. */
  say?: string;
  /** Who answers when it names nobody. */
  fallback?: ChatAgent;
  /** What they are told when that is nobody; undefined is silence. Asked only when a turn would have run. */
  none?: () => string | undefined;
}

/** A box that is one person's alone. */
function soleMember(box: Pick<BoxEntry, "members">): string | undefined {
  return Array.isArray(box.members) && box.members.length === 1 ? box.members[0] : undefined;
}

const carried = (agent: AgentRecord): ChatAgent => ({ id: agent.id, name: agent.profile.name });

export class ChatRoute {
  /** Rooms already told that no agent answers there: said once per room, per process. */
  private readonly toldRooms = new Set<string>();

  constructor(private readonly deps: ChatRouteDeps) {}

  private locale(adapterName: string): Locale {
    return resolveLocale({ channelType: this.deps.door(adapterName)?.type });
  }

  /** The agents in boxes this person may enter: those in a box that is theirs alone first, then by id. */
  reachable(principalId: string): { agent: AgentRecord; box: BoxEntry; own: boolean }[] {
    const { registry } = this.deps;
    return registry.list()
      .map(agent => { const box = registry.boxOf(agent.id); return { agent, box, own: soleMember(box) === principalId }; })
      .filter(entry => mayEnterBox(entry.box, principalId))
      .sort((a, b) => Number(b.own) - Number(a.own) || a.agent.id.localeCompare(b.agent.id));
  }

  /** The agent `@name` names for this person, or what they are told. */
  private named(name: string, principalId: string, locale: Locale): { agent: AgentRecord } | { say: string } {
    const reach = this.reachable(principalId), needle = name.trim().toLowerCase();
    const byId = reach.find(entry => entry.agent.id === name);
    if (byId !== undefined) return { agent: byId.agent };
    const matches = reach.filter(entry => entry.agent.profile.name.toLowerCase() === needle);
    const own = matches.filter(entry => entry.own), tier = own.length > 0 ? own : matches;
    if (tier.length === 1) return { agent: tier[0]!.agent };
    if (tier.length > 1) {
      const list = tier.map(entry => tr("agent.ambiguousLine", locale, { name: entry.agent.profile.name, box: entry.box.name, id: entry.agent.id })).join("\n");
      return { say: tr("agent.ambiguous", locale, { asked: name, count: tier.length, list }) };
    }
    // Nobody by that name where they may enter. One in another person's box is not mentioned: the same words as for no such name.
    return { say: tr("agent.unknown", locale, { asked: name, roster: this.rosterOf(reach, locale) }) };
  }

  private rosterOf(reach: readonly { agent: AgentRecord }[], locale: Locale): string {
    const names = [...new Set(reach.filter(entry => entry.agent.profile.hidden !== true).map(entry => entry.agent.profile.name))].sort((a, b) => a.localeCompare(b));
    return names.length > 0 ? names.join("、") : tr("agent.none", locale);
  }

  /**
   * The door's default agent. Written as an id or a name; a name several agents carry means the
   * one that is not in somebody's own box, since a default lives in a shared one (docs/109 §4).
   */
  doorDefault(adapterName: string): AgentRecord | undefined {
    const { registry } = this.deps, written = this.deps.door(adapterName)?.defaultAgent;
    if (written === undefined || written === "") return undefined;
    const direct = registry.tryGet(written);
    if (direct !== undefined) return direct;
    const matches = registry.list().filter(agent => agent.profile.name.toLowerCase() === written.trim().toLowerCase());
    const shared = matches.length > 1 ? matches.filter(agent => soleMember(registry.boxOf(agent.id)) === undefined) : matches;
    if (shared.length === 1) return shared[0];
    this.deps.log(`chat route: ${adapterName}'s default agent "${written}" names ${matches.length === 0 ? "no agent" : `${matches.length} agents`}; nobody answers as the default`);
    return undefined;
  }

  /** The agent a guest's message is for: the door's default when it names nobody, else the name as the installation knows it — only an agent set to answer guests does. */
  forGuest(adapterName: string, name: string | undefined): AgentRecord | undefined {
    if (name === undefined || name === this.deps.door(adapterName)?.defaultAgent) return this.doorDefault(adapterName);
    try { return this.deps.registry.resolve(name); } catch { return undefined; }
  }

  /** Who answers this person here when they name nobody: the order at the top of this file. */
  unnamed(adapterName: string, origin: ChatOrigin): { agent: AgentRecord } | { none: () => string | undefined } {
    const { registry, principals } = this.deps, person = principals.resolve(origin.identity), direct = origin.privateChat === true;
    const locale = this.locale(adapterName);
    if (direct) {
      const home = person.homeAgentId === undefined ? undefined : registry.tryGet(person.homeAgentId);
      if (home !== undefined && mayEnterBox(registry.boxOf(home.id), person.id)) return { agent: home };
      if (this.deps.preparing(person.id)) return { none: () => tr("agent.preparing", locale) };
    }
    const byDoor = this.doorDefault(adapterName);
    if (byDoor !== undefined && (!direct || mayEnterBox(registry.boxOf(byDoor.id), person.id))) return { agent: byDoor };
    const reach = direct ? this.reachable(person.id).filter(entry => entry.agent.profile.hidden !== true) : [];
    if (reach.length === 1) return { agent: reach[0]!.agent };
    if (principals.installation().mode === "single-machine") return { agent: registry.list()[0] ?? this.deps.firstAgent() };
    if (direct) return { none: () => tr("agent.noneHere", locale) + (reach.length > 0 ? tr("agent.reachHint", locale, { roster: this.rosterOf(reach, locale) }) : "") };
    return { none: () => {
      const room = `${adapterName}\n${origin.chatKey ?? origin.identity}`;
      this.deps.log(`chat route: ${adapterName} has no default agent; nobody answers ${origin.chatKey ?? origin.identity}`);
      if (this.toldRooms.has(room)) return undefined;
      this.toldRooms.add(room);
      return tr("agent.noneForRooms", locale);
    } };
  }

  /** The agent a direct message from this person reaches now, when they have one they may still enter. What the page marks. */
  homeOf(principalId: string): AgentRecord | undefined {
    const { registry, principals } = this.deps, written = principals.byId(principalId)?.homeAgentId, home = written === undefined ? undefined : registry.tryGet(written);
    return home !== undefined && mayEnterBox(registry.boxOf(home.id), principalId) ? home : undefined;
  }

  /** A person chooses which agent answers their direct messages: only one they may reach. Undefined for any other id, existing or not. */
  chooseHome(principalId: string, agentId: string): AgentRecord | undefined {
    const chosen = this.reachable(principalId).find(entry => entry.agent.id === agentId)?.agent;
    if (chosen === undefined || !this.deps.principals.setHomeAgent(principalId, chosen.id)) return undefined;
    this.deps.log(`home agent for ${principalId}: ${chosen.profile.name} (${chosen.id}), chosen by them`);
    return chosen;
  }

  /** One message, for the door: the agent it names (or the answer), and who answers when it names nobody. */
  route(adapterName: string, origin: ChatOrigin, name: string | undefined): ChatAddress {
    const fallback = this.unnamed(adapterName, origin);
    const rest: ChatAddress = "agent" in fallback ? { fallback: carried(fallback.agent) } : { none: fallback.none };
    if (name === undefined) return rest;
    const found = this.named(name, this.deps.principals.resolve(origin.identity).id, this.locale(adapterName));
    return "agent" in found ? { ...rest, agent: carried(found.agent) } : { ...rest, say: found.say };
  }

  /**
   * The agent a turn runs for, or the answer instead of a turn. `token` is what the door carried:
   * an id (a name is read as `@Name` would be). With no token nobody is chosen here.
   *
   * This is the third entrance (INV-538): a message from a chat is somebody entering a box, and the
   * same members set answers here as on the page — otherwise membership is a property of which
   * door you used, which docs/22 §0 forbids. Nothing about the conversation is written before it.
   */
  asked(token: string | undefined, identity: string): AgentRecord | string {
    const { registry, principals } = this.deps, adapterName = identity.split(":")[0] ?? "", locale = this.locale(adapterName), person = principals.resolve(identity);
    if (token === undefined) return tr("agent.noneHere", locale);
    // A room's default is given to everybody who writes there; whoever may not enter its box is told so by name, as before.
    const byDoor = this.doorDefault(adapterName);
    if (byDoor !== undefined && byDoor.id === token) {
      const box = registry.boxOf(byDoor.id);
      if (mayEnterBox(box, person.id)) return byDoor;
      this.deps.log(`${identity} is not in ${box.name}; refused at the chat door`);
      return refusalToEnter(box.name, person.name);
    }
    const found = this.named(token, person.id, locale);
    return "agent" in found ? found.agent : found.say;
  }
}
