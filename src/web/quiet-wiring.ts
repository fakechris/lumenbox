/**
 * Wires the two things a member's unprompted words pass through on this host (INV-1928): the queue
 * where they wait for a conversation to be quiet (quiet-delivery.ts), and Tell (tell.ts). Here, and
 * not in server.ts, so the queue is given the same three facts wherever it is asked — when a person
 * last wrote in a conversation, whether a member is answering them there, and which chat it is.
 */

import type { HeardRecord } from "../agents/heard-record.ts";
import { conversationIdFor } from "../agents/registry.ts";
import type { AgentboxConfig } from "../config.ts";
import type { OutboundPurpose } from "../host/outbound.ts";
import type { PushBudget } from "../host/push-budget.ts";
import { answeringPerson, quietChatDoor, QuietQueue, quietSettings } from "../host/quiet-delivery.ts";
import { lastPersonMessage } from "../host/routine-idle.ts";
import { fileTold, Teller, type Told } from "../host/tell.ts";
import type { ToolContext } from "../host/tools.ts";
import type { TurnEvent } from "../host/turn-events.ts";

type Sent = { delivered: boolean; why?: string };

export interface QuietWiring {
  /** Where the queue is kept. */
  path: string;
  config: Pick<AgentboxConfig, "quiet" | "tellGapMinutes">;
  budget: Pick<PushBudget, "admit" | "counts">;
  redact: (text: string) => string;
  toPage: (event: TurnEvent) => void;
  /** Which chat a conversation came from. */
  chatOf: (conversation: string) => string | undefined;
  registry: { list(): readonly { id: string }[] };
  /** The orchestrator, once it exists: its bus has the heard record and the work a Tell is filed on, its ledger the turns that are open. */
  orchestrator: () => {
    bus: Pick<ToolContext["bus"], "workAttention"> & { heard?: HeardRecord };
    turns?: { interrupted(): readonly { agentId: string; conversation?: string; causedBy?: readonly string[] }[] };
  };
  /** The chat doors, once they are up. */
  chats: () => { tryPushToChat(chatKey: string, text: string, purpose: OutboundPurpose): Promise<Sent> } | undefined;
  log: (line: string) => void;
}

export function quietWiring(deps: QuietWiring) {
  const settings = quietSettings(deps.config.quiet);
  const heard = () => deps.orchestrator().bus.heard;
  const push = async (chatKey: string, text: string, purpose: OutboundPurpose): Promise<Sent> =>
    deps.chats()?.tryPushToChat(chatKey, text, purpose) ?? { delivered: false, why: "no channels are configured" };
  const queue = new QuietQueue({
    path: deps.path, windowMinutes: settings.windowMinutes, capMinutes: settings.capMinutes, log: deps.log,
    lastPersonAt: conversation => lastPersonMessage(heard(), deps.registry.list().map(agent => agent.id), conversation)?.getTime(),
    answering: conversation => answeringPerson(deps.orchestrator().turns?.interrupted() ?? [], heard(), conversation),
    // What was waiting when the process stopped is not swept into chat doors that are still starting.
    ready: message => deps.chats() !== undefined || (message.via === "tell" && deps.chatOf(message.conversation) === undefined),
  });
  const teller = new Teller({
    budget: deps.budget, quiet: queue, redact: deps.redact, toPage: deps.toPage, chatOf: deps.chatOf, log: deps.log,
    ...(deps.config.tellGapMinutes !== undefined ? { gapMinutes: deps.config.tellGapMinutes } : {}),
    // Tell has asked the queue already (admitTell), so its push is not asked a second time.
    toChat: (chatKey, text, about) => push(chatKey, text, { kind: "notice", about, urgent: true }),
    filed: (told: Told) => fileTold(deps.orchestrator().bus, told),
  });
  queue.start();
  return {
    queue,
    teller,
    /** The chat doors' sender, with the queue in front of it. */
    door: <Input extends { chatKey: string; text: string; purpose: OutboundPurpose }, Out extends Sent>(inner: { send(input: Input, after?: () => Promise<void>): Promise<Out> }) =>
      quietChatDoor(inner, queue, { conversationOf: conversationIdFor, push, approved: () => settings.urgent, log: deps.log }),
  };
}
