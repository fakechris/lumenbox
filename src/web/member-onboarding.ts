/**
 * What happens when a member's personal box comes up (INV-2220, docs/109 §3), wired once here so
 * the server holds a line or two of it:
 *
 * - the box is reconnected, and in the box the installation made for the member their one agent is
 *   made if they have none (`member-agent.ts`) — from the organisation's member template, else the
 *   built-in assistant named in their language;
 * - when the box was made because an Admin activated them, that agent tells them it is ready
 *   (`assistant-ready.ts`), and the Admins' page is told to read the progress again.
 *
 * `attach` is the second half, given what exists only later in the server's start (the activations
 * ledger, the path to a person): until it is called, a box that comes up is reconnected and its
 * agent made, and nobody is told.
 */

import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import { tr } from "../i18n/messages.ts";
import type { Locale } from "../i18n/locale.ts";
import type { Activations } from "../host/activations.ts";
import { AssistantReady } from "../host/assistant-ready.ts";
import { AUTO_REQUEST } from "../host/auto-personal-box.ts";
import type { DirectorySource } from "../host/directory.ts";
import { ensureHomeAgent } from "../host/member-agent.ts";
import { STARTER_TEAM } from "../host/orchestrator.ts";
import type { PersonalBoxes } from "../host/personal-boxes.ts";
import type { Principals } from "../host/principals.ts";
import type { PersonReach } from "../host/reach-person.ts";
import type { BotTemplate } from "../host/template.ts";
import type { OnboardingDeps } from "./activation-progress.ts";

interface Deps {
  registry: Pick<AgentRegistry, "boxById" | "agentsIn" | "create" | "tryGet">;
  principals: Principals;
  boxes: PersonalBoxes;
  reconnectBox(entry: BoxEntry): Promise<unknown>;
  memberTemplate(): string | undefined;
  importTemplate(template: BotTemplate, boxId: string, owner: string): AgentRecord;
  locale(principalId: string): Locale;
  /** The Admins' page reads the progress again. */
  changed(): void;
  log(line: string): void;
}

export class MemberOnboarding {
  private ready?: AssistantReady;
  constructor(private readonly deps: Deps) {}

  /** A personal box came up: reconnected, and the member's agent made in the box the installation made for them. */
  async reconnect(id: string): Promise<void> {
    const { deps } = this;
    try { const entry = deps.registry.boxById(id); if (entry) await deps.reconnectBox(entry); }
    finally {
      try {
        if (deps.boxes.requestOf(id) === AUTO_REQUEST) ensureHomeAgent(id, { registry: deps.registry, principals: deps.principals, log: deps.log, templatePath: deps.memberTemplate,
          assistant: owner => ({ ...STARTER_TEAM[0]!, name: tr("ui.personal.assistant", deps.locale(owner)) }), importTemplate: deps.importTemplate });
      } catch (error) { deps.log(`home agent in ${id}: not made (${error instanceof Error ? error.message : String(error)})`); }
    }
  }

  /** A box made for a member is up (auto-personal-box.ts): as above, and when it came of an activation, its person is told. */
  async boxReady(id: string, atActivation: boolean): Promise<void> {
    try { await this.reconnect(id); }
    finally {
      const owner = this.deps.registry.boxById(id)?.members;
      if (atActivation && this.ready !== undefined && Array.isArray(owner) && owner.length === 1) { await this.ready.tell(owner[0]!); this.deps.changed(); }
    }
  }

  /** The rest, once the ledger and the path to a person exist: what the activation routes' estimate, progress and telling-again use. */
  attach(more: {
    activations: Activations; reach: Pick<PersonReach, "tellOwner">; autoBoxes: OnboardingDeps["autoBoxes"]; publicUrl(): string | undefined;
    sourceOf(channelId: string): DirectorySource | undefined; quotaOf(identity: string): number | undefined;
  }): OnboardingDeps {
    this.ready = new AssistantReady({ activations: more.activations, principals: this.deps.principals, registry: this.deps.registry, reach: more.reach, publicUrl: more.publicUrl,
      locale: this.deps.locale, log: this.deps.log, sourceOf: more.sourceOf });
    return { autoBoxes: more.autoBoxes, boxes: this.deps.boxes, ready: this.ready, quotaOf: more.quotaOf,
      boxName: person => tr("ui.personal.defaultName", this.deps.locale(person.id), { name: person.name }) };
  }
}

