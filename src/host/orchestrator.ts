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
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
import type { ResolutionConfig } from "../protocol/index.ts";
import { runTurn, TurnAborted, type TurnEvent } from "./turn.ts";

export interface OrchestratorOptions {
  registry?: AgentRegistry;
  client?: Anthropic;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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

  constructor(private readonly options: OrchestratorOptions = {}) {
    this.registry = options.registry ?? new AgentRegistry();
    this.client = options.client ?? new Anthropic();

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

  private executeTurn(
    agent: AgentRecord,
    inbound: readonly InboundMessage[],
    signal: AbortSignal
  ): Promise<void> {
    return runTurn(agent, inbound, signal, {
      client: this.client,
      registry: this.registry,
      bus: this.bus,
      box: this.box,
      resolution: this.resolution,
      model: this.options.model,
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
