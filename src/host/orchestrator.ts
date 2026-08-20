/**
 * Wires the registry, the bus, the box, and the turn loop into one runtime.
 *
 * There is deliberately no router here: which agent handles what, and when to
 * involve a teammate, is decided by the models through the messaging tools. The
 * orchestration you see at runtime is emergent, not encoded.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { AgentBus, type BusEvent, type InboundMessage } from "../agents/bus.ts";
import { AgentRegistry, type AgentRecord } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { DisplayLease } from "../box/display-lease.ts";
import { resolveBoxProvisioner, type BoxProvisioner } from "../box/provisioner.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { runTurn, TurnAborted, type TurnEvent } from "./turn.ts";
import { PolicyGate } from "./policy.ts";
import { Rememberer, summariseExchange } from "./remember.ts";
import { SkillCache } from "./skills.ts";
import { UsageLog } from "./usage.ts";
import {
  createClient,
  resolveSummaryProvider,
  resolveProvider,
  type Effort,
  type ProviderProfile,
} from "./provider.ts";

export interface OrchestratorOptions {
  registry?: AgentRegistry;
  client?: Anthropic;
  /** Which endpoint to talk to. Defaults to whatever the environment selects. */
  provider?: ProviderProfile;
  effort?: Effort;
  /** Connect to a running box. When false, agents run without box tools. */
  useBox?: boolean;
  /**
   * Where the box comes from. Defaults to the environment's choice — a named URL if one
   * is set, Docker otherwise. Injectable so a deployment can supply its own, and so this
   * file no longer knows what Docker is.
   */
  boxProvisioner?: BoxProvisioner;
  onTurnEvent?: (event: TurnEvent) => void;
  onBusEvent?: (event: BusEvent) => void;
}

export class Orchestrator {
  readonly registry: AgentRegistry;
  readonly bus: AgentBus;
  private readonly client: Anthropic;
  private box: BoxClient | undefined;
  private resolution: ResolutionConfig | undefined;
  /**
   * One lease for the whole process, not one per conversation. The display is a
   * property of the box, so scoping this per agent or per turn would let two
   * agents each believe they held it.
   */
  private readonly display = new DisplayLease();
  /** Desktops already brought up, so each is started once per process. */
  private readonly readyDisplays = new Set<number>();
  /**
   * What every turn cost, appended as it happens.
   *
   * One per process rather than per turn: the sequence numbers a collector reads by have to be
   * monotonic across the whole file, and two logs would produce two sequences.
   */
  readonly usage = new UsageLog();

  /**
   * Decides whether a turn may spend, continue, or run a given action.
   *
   * One per process, like the usage log, and for a related reason: its record is append-only and a
   * second instance would interleave two views of the same state. Given the usage log as its
   * spend source, so the budget is measured against what was actually billed rather than an
   * estimate.
   */
  readonly policy = new PolicyGate({
    spentTokens: () => this.usage.totals().inputTokens + this.usage.totals().outputTokens,
    log: line => console.error(`[policy] ${line}`),
  });

  readonly provider: ProviderProfile;

  /**
   * Notices what a conversation taught, after the fact.
   *
   * Given the summariser's profile rather than the agent's: taking notes is the cheapest work in the
   * system and should be billed accordingly.
   */
  private readonly rememberer: Rememberer;

  /** Who last drove each agent, for attributing what it learns. */
  private readonly callers = new Map<string, { userId?: string }>();

  /**
   * Skills as they were last read from the box.
   *
   * Cached because a prompt is built once per turn and reading them is a listing plus a read per
   * skill; four agents waking at once should not produce four scans of the same directory.
   */
  readonly skills = new SkillCache(() => this.box);

  constructor(private readonly options: OrchestratorOptions = {}) {
    this.registry = options.registry ?? new AgentRegistry();
    this.provider = options.provider ?? resolveProvider();
    this.client = options.client ?? createClient(this.provider);
    this.rememberer = new Rememberer({
      registry: this.registry,
      client: this.client,
      provider: resolveSummaryProvider(this.provider),
      log: line => console.error(`[memory] ${line}`),
    });

    this.bus = new AgentBus(
      this.registry,
      (agent, inbound, signal) => this.executeTurn(agent, inbound, signal),
      options.onBusEvent
    );
  }

  /**
   * Attaches to a running box, if there is one.
   *
   * A missing box is not fatal: agents still reason and message each other, they
   * just lose the computer and shell tools, and the prompt says so.
   */
  async connectBox(): Promise<{ connected: boolean; detail: string }> {
    if (this.options.useBox === false) {
      return { connected: false, detail: "box disabled by --no-box" };
    }

    try {
      const provisioner = this.options.boxProvisioner ?? resolveBoxProvisioner();
      const client = await provisioner.connect();
      const health = await client.health();
      this.box = client;
      this.resolution = health.resolution;
      const size = health.resolution
        ? `${health.resolution.display.width}x${health.resolution.display.height}`
        : "no display";
      return { connected: true, detail: `box ready (${size}) via ${provisioner.label}` };
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The agent's own desktop, brought up if this is its first turn.
   *
   * Created on demand rather than at startup so a box with one active agent does
   * not pay for a desktop per registered agent. A failure is not fatal — the agent
   * keeps its shell and file tools — but it is reported, because silently falling
   * back to a shared display is how agents end up typing into each other's windows.
   */
  private async ensureDesktop(agent: AgentRecord): Promise<number | undefined> {
    if (!this.box) return undefined;

    const index = this.registry.displayIndexFor(agent.id);
    if (this.readyDisplays.has(index)) return index;

    try {
      // Claims the desktop as this agent's while creating it: from here on the box
      // refuses input for it that does not carry the same token.
      await this.box.ensureDisplay(index, this.registry.boxOwnerTokenFor(agent.id));
      this.readyDisplays.add(index);
      return index;
    } catch (error) {
      this.options.onBusEvent?.({
        type: "turn_failed",
        agentId: agent.id,
        error:
          `could not start desktop ${index} for ${agent.profile.name}: ` +
          (error instanceof Error ? error.message : String(error)),
      });
      return undefined;
    }
  }

  /** The box client, for callers that need the box directly (recording, downloads). */
  boxClient(): BoxClient | undefined {
    return this.box;
  }

  /**
   * Brings up every registered agent's desktop at once.
   *
   * On-demand creation is right for the CLI, but not for a person: they can open
   * any agent's desktop and work in it before that agent has ever taken a turn,
   * and a desktop that does not exist yet shows a proxy error instead of a screen.
   * Failures are collected rather than thrown — one agent's desktop failing must
   * not stop the others from being usable.
   */
  async ensureAllDesktops(): Promise<{ name: string; index: number | undefined }[]> {
    const agents = this.registry.list();
    return Promise.all(
      agents.map(async agent => ({
        name: agent.profile.name,
        index: await this.ensureDesktop(agent),
      }))
    );
  }

  private async executeTurn(
    agent: AgentRecord,
    inbound: readonly InboundMessage[],
    signal: AbortSignal
  ): Promise<void> {
    const displayIndex = await this.ensureDesktop(agent);
    // Refreshed before the prompt is built, and never allowed to fail the turn — a box with no
    // skills directory is the normal state of a fresh install.
    const { skills } = await this.skills.refresh();

    return runTurn(agent, inbound, signal, {
      displayIndex,
      boxOwner: this.registry.boxOwnerTokenFor(agent.id),
      usage: this.usage,
      policy: this.policy,
      caller: this.callers.get(agent.id),
      skills,
      client: this.client,
      registry: this.registry,
      bus: this.bus,
      box: this.box,
      display: this.display,
      resolution: this.resolution,
      provider: this.provider,
      effort: this.options.effort,
      onEvent: this.options.onTurnEvent,
    }).catch(error => {
      // An aborted turn is a normal outcome — a priority message superseded it,
      // and the bus will schedule the follow-up turn that handles that message.
      if (error instanceof TurnAborted) return;
      throw error;
    });
  }

  /** Sends a user message to an agent and runs its turn to completion. */
  async prompt(
    agentIdOrName: string,
    text: string,
    caller?: { userId?: string }
  ): Promise<void> {
    const agent = this.registry.resolve(agentIdOrName);
    // Remembered for the turn, so a memory kept during it records who it is about. Per agent because
    // two people can be driving two agents at once; overwritten on each prompt because the most
    // recent person to speak to *this* agent is the one its memories are about.
    if (caller?.userId !== undefined) this.callers.set(agent.id, caller);
    this.bus.sendFromUser(agent.id, text);
    const before = this.registry.readTranscript(agent.id).length;
    await this.bus.runExclusive(agent.id, { userDriven: true });

    // After the turn, and not awaited: a person waiting on an answer should not also wait on
    // bookkeeping. What the agent said is read back from the transcript rather than threaded through
    // the turn loop, which keeps the loop unaware that any of this exists.
    const said = this.replySince(agent.id, before);
    if (said !== "") {
      void this.rememberer
        .record({ agentId: agent.id, text: summariseExchange(text, said) })
        .catch(() => {
          // Already logged inside; a second report here would be noise on a path nobody is watching.
        });
    }
  }

  /** The agent's own prose from this turn, which is what an extractor should reason over. */
  private replySince(agentId: string, from: number): string {
    return (this.registry.readTranscript(agentId) as { role?: string; text?: string; kind?: string }[])
      .slice(from)
      .filter(entry => entry.role === "assistant" && entry.kind === undefined && entry.text)
      .map(entry => entry.text as string)
      .join("\n\n");
  }

  /** Waits for every agent woken as a side effect of the last prompt. */
  settle(timeoutMs?: number): Promise<void> {
    return this.bus.idle(timeoutMs);
  }

  /**
   * The starter team, created once when there are no agents at all.
   *
   * The alternative — ship a single blank agent and have it interview the user on its first turn —
   * was considered. That is the better shape when there is a template gallery
   * to choose from afterwards; without one it leaves a person on a blank page deciding what an agent
   * even is. So: a small team that shows the shape of the thing by existing.
   *
   * Four rules, three of them learned rather than invented:
   *
   * **A description is standing identity, never a briefing.** It is re-read into the system prompt on
   * every single turn, so a one-time instruction parked here — "the disk is full", "start by reading
   * the spec" — keeps asserting itself long after it stopped being true, and freezes the tool names
   * that existed the day it was written. What an agent should *do* belongs in a message.
   *
   * **The roster is a cost.** Every agent appears in every other agent's prompt, and a team is also a
   * set of desktops and a set of things a person has to read before doing anything. Four, not ten.
   *
   * **The divisions are real or they are decoration.** These four differ in what they touch and how
   * they fail — a browser and long documents, a shell and installed software, someone else's claims —
   * not in the adjectives describing them. Five flavours of "helpful assistant" would be worse than
   * one agent, because it would imply a structure that does not exist.
   *
   * **Only when empty.** A person who deletes one does not get it back on the next start, and an
   * upgrade does not repopulate a team someone has curated.
   *
   * Deliberately not done: a hidden first turn per agent so each introduces itself. It reads well and
   * it spends four model calls before the user has said anything, which is not a cost to impose by
   * default.
   */
  ensureDefaultAgent(): AgentRecord {
    const existing = this.registry.list();
    if (existing.length > 0) return existing[0]!;

    const created = STARTER_TEAM.map(profile => this.registry.create(profile));
    return created[0]!;
  }
}

/**
 * The team a fresh install starts with.
 *
 * Order matters: the first is the one a CLI and a fresh UI select, so it is the one that talks to
 * people. The rest are its colleagues.
 */
export const STARTER_TEAM: readonly {
  name: string;
  title: string;
  description: string;
}[] = [
  {
    name: "Ada",
    title: "coordinator",
    description:
      "You coordinate this user's team of agents. You are the one they talk to first. " +
      "When a request falls squarely inside a teammate's remit, hand it to them and say " +
      "you did; when the team is missing someone the work clearly needs, propose creating " +
      "them rather than creating them unasked. Do the work yourself when it is faster than " +
      "delegating — a single file read or a one-line shell command is not worth a handoff.",
  },
  {
    name: "Rex",
    title: "researcher",
    description:
      "You find things out. Your work is mostly the browser and the files you write from it: you " +
      "read sources, follow them to their origin rather than trusting a summary of them, and leave " +
      "what you found in a file under /home/box/work so it outlives the conversation. You are " +
      "explicit about what you could not confirm — an unmarked guess in a document you wrote is " +
      "worse than an admitted gap, because the next person cannot tell them apart.",
  },
  {
    name: "Ops",
    title: "operator",
    description:
      "You do the machine work: installing things, running builds and scripts, moving files, and " +
      "getting a stubborn tool to run at all. You work in the shell by preference because it says " +
      "what happened, and you read what a command actually printed rather than assuming it worked. " +
      "When something needs to survive a rebuild it goes under /home/box/work; when a change is " +
      "hard to undo you say so before making it.",
  },
  {
    name: "Vera",
    title: "reviewer",
    description:
      "You check whether work actually did what it claims. Given a teammate's result, you read " +
      "their transcript for what they ran and what came back, then reproduce the part that matters " +
      "yourself rather than taking their account of it — the failure you exist to catch is the one " +
      "where a step looked like it worked and did not. You report plainly: what you verified, what " +
      "you could not, and what you found wrong. You do not soften a real problem, and you do not " +
      "invent one to look useful.",
  },
];
