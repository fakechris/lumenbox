/**
 * Wires the registry, the bus, the box, and the turn loop into one runtime.
 *
 * There is deliberately no router here: which agent handles what, and when to
 * involve a teammate, is decided by the models through the messaging tools. The
 * orchestration you see at runtime is emergent, not encoded.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AgentBus, type BusEvent, type InboundMessage } from "../agents/bus.ts";
import { AgentRegistry, type AgentRecord } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { DisplayLease } from "../box/display-lease.ts";
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { runTurn, TurnAborted, type TurnEvent } from "./turn.ts";
import {
  createClient,
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

  readonly provider: ProviderProfile;

  constructor(private readonly options: OrchestratorOptions = {}) {
    this.registry = options.registry ?? new AgentRegistry();
    this.provider = options.provider ?? resolveProvider();
    this.client = options.client ?? createClient(this.provider);

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
      const manager = new BoxManager(defaultBoxConfig());
      const client = await manager.connect();
      const health = await client.health();
      this.box = client;
      this.resolution = health.resolution;
      const size = health.resolution
        ? `${health.resolution.display.width}x${health.resolution.display.height}`
        : "no display";
      return { connected: true, detail: `box ready (${size})` };
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
      await this.box.ensureDisplay(index);
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

    return runTurn(agent, inbound, signal, {
      displayIndex,
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
  async prompt(agentIdOrName: string, text: string): Promise<void> {
    const agent = this.registry.resolve(agentIdOrName);
    this.bus.sendFromUser(agent.id, text);
    await this.bus.runExclusive(agent.id, { userDriven: true });
  }

  /** Waits for every agent woken as a side effect of the last prompt. */
  settle(timeoutMs?: number): Promise<void> {
    return this.bus.idle(timeoutMs);
  }

  /** Creates the first agent when the registry is empty, so the CLI is usable. */
  ensureDefaultAgent(): AgentRecord {
    const existing = this.registry.list();
    if (existing.length > 0) return existing[0]!;

    return this.registry.create({
      name: "Ada",
      title: "coordinator",
      description:
        "You coordinate this user's team of agents. You are the one they talk to first. " +
        "When a request falls squarely inside a teammate's remit, hand it to them and say " +
        "you did; when the team is missing someone the work clearly needs, propose creating " +
        "them rather than creating them unasked. Do the work yourself when it is faster than " +
        "delegating — a single file read or a one-line shell command is not worth a handoff.",
    });
  }
}
