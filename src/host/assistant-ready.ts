/**
 * Telling a person their assistant is ready (INV-2220, docs/109 §3 "Telling them").
 *
 * When the box an Admin's activation asked for has come up and the person's agent is made in it,
 * that agent writes to its person once, through `PersonReach` — the one path that sends to a
 * person, with the speaking right, quiet hours, the outbox receipt and the sent ledger. The
 * message names the agent and the installation's address; never a token or a credential.
 *
 * Only for people an activation made and asked a box for: not for somebody home format 2 made
 * from an older activation (they get their box at their first use, and are on the page by then),
 * nor for a box made at a first page load. A door that will not carry it — the bot may not write
 * first, the person never opened a chat with it — is written down once with its reason, and the
 * Admin's page lists them as not told until an Admin asks again.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { tr } from "../i18n/messages.ts";
import type { Locale } from "../i18n/locale.ts";
import type { Activation, Activations } from "./activations.ts";
import type { DirectorySource } from "./directory.ts";
import type { Principals } from "./principals.ts";
import type { PersonReach, Reached } from "./reach-person.ts";

export interface AssistantReadyDeps {
  activations: Activations;
  principals: Pick<Principals, "reload" | "byId">;
  registry: Pick<AgentRegistry, "tryGet">;
  /** The door's directory source as it is now; undefined for a door with no app behind it. */
  sourceOf(channelId: string): DirectorySource | undefined;
  reach: Pick<PersonReach, "tellOwner">;
  /** The installation's address a person opens (`AGENTBOX_PUBLIC_URL`); undefined when none is set. */
  publicUrl(): string | undefined;
  locale(principalId: string): Locale;
  log(line: string): void;
}

/** A person told, or not, and the activation it was for. */
export interface Telling { source: DirectorySource; activation: Activation; reached: Reached }

export class AssistantReady {
  constructor(private readonly deps: AssistantReadyDeps) {}

  /** The standing activation that made this person and asked a box for them; undefined for anybody else. */
  private activationOf(principalId: string): { source: DirectorySource; activation: Activation } | undefined {
    for (const identity of this.deps.principals.byId(principalId)?.identities ?? []) {
      const colon = identity.indexOf(":"), source = colon > 0 ? this.deps.sourceOf(identity.slice(0, colon)) : undefined;
      const activation = source === undefined ? undefined : this.deps.activations.activation(source, identity.slice(colon + 1));
      if (source !== undefined && activation !== undefined && activation.principalId === principalId && activation.leftAt === undefined
        && activation.migrated !== true && activation.boxAskedAt !== undefined) return { source, activation };
    }
    return undefined;
  }

  /** The person's box came up after their activation: their agent tells them, once. Undefined when they are not somebody an activation made. */
  async tell(principalId: string, by = "activation"): Promise<Telling | undefined> {
    this.deps.principals.reload();
    const found = this.activationOf(principalId);
    if (found === undefined) return undefined;
    if (by === "activation" && found.activation.told !== undefined) return undefined; // a box started again after it was up says nothing twice
    const person = this.deps.principals.byId(principalId)!, agent = person.homeAgentId === undefined ? undefined : this.deps.registry.tryGet(person.homeAgentId);
    const url = this.deps.publicUrl(), locale = this.deps.locale(principalId);
    const reached: Reached = agent === undefined ? { delivered: false, why: "no agent has been made for them yet" }
      : await this.deps.reach.tellOwner(agent.id, url !== undefined && url !== ""
        ? tr("activation.ready", locale, { agent: agent.profile.name, url })
        : tr("activation.ready-here", locale, { agent: agent.profile.name }), {
          // A notice is one receipt per chat, words and day: an Admin's retry is a new one, or it would meet the refused receipt again.
          about: by === "activation" ? "assistant ready" : `assistant ready, asked again by ${by} at ${new Date().toISOString()}`, exempt: true,
        });
    this.deps.activations.told(found.source, by, { subject: found.activation.subject, principalId }, reached);
    this.deps.log(`assistant ready, ${principalId}: ${reached.delivered ? "told" : `not told (${reached.why ?? "no reason given"})`}`);
    return { ...found, reached };
  }

  /** Who an activation of this source asked a box for and has not been told, with the reason the door gave. */
  notTold(source: DirectorySource): Activation[] {
    return this.deps.activations.activations(source).filter(activation => activation.leftAt === undefined && activation.told !== undefined && !activation.told.delivered);
  }

  /** An Admin asks again: these people (or every one not told, when none are named) are written to once more. */
  async tellAgain(source: DirectorySource, subjects: readonly string[] | undefined, by: string): Promise<{ told: number; notTold: number }> {
    const wanted = this.notTold(source).filter(activation => subjects === undefined || subjects.includes(activation.subject));
    let told = 0;
    for (const activation of wanted) if ((await this.tell(activation.principalId!, by))?.reached.delivered) told += 1;
    return { told, notTold: wanted.length - told };
  }
}
