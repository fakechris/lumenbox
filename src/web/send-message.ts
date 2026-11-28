/**
 * A person's message to an agent, from the page (`POST /api/prompt`) or a phone (`POST /api/v1/conversations/{id}/messages`,
 * INV-2214): one path, so what a turn receives, what the chat it belongs to is told and what the record says are the same
 * whichever screen it came from. The caller has already said who is asking and that they may drive this agent's box (the
 * page's `refused`, the client API's reach); this is everything after that.
 *
 * A message to a conversation that belongs to an outside chat is repeated in that chat, marked as coming from the console,
 * and the agent's reply follows it there: context two readers see differently is the failure everything else avoids.
 */

import type { WorkStamp } from "../agents/work-attention.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { isContextCommand } from "../host/context-recovery.ts";
import { isGoalCommand } from "../host/goal-mode.ts";
import { isForkChild } from "../host/pending-work.ts";
import type { PromptOptions } from "../host/prompt-options.ts";
import { isRetryCommand } from "../host/retry-recovery.ts";
import { isRecoveryCommand } from "../host/task-recovery.ts";
import type { ErrorCode } from "../i18n/server-errors.ts";

export interface SendMessageDeps {
  has(agentId: string): boolean;
  modelReady(agentId: string): Promise<boolean>;
  /** A card press continues the work its card was drawn for (surface-action.ts), or is refused with why. */
  surfaceWork(input: { action: unknown; text: string; agentId: string; conversation: string }): { work?: WorkStamp; taskBinding: { taskId: string; role: "executor" } } | { error: string } | undefined;
  /** The outside chat a conversation belongs to, when it belongs to one. */
  chatKeyFor(conversation: string): string | undefined;
  pushToChat(chatKey: string, text: string, about: string): void;
  /** The orchestrator's turn for a person's message (`Orchestrator.prompt`). */
  turn(agentId: string, text: string, caller: { userId?: string }, options: PromptOptions): Promise<void>;
  transcriptLength(agentId: string, conversation: string): number;
  replySince(agentId: string, from: number, conversation: string): string;
  /** Teammates this turn woke finish before the page looks idle. */
  settle(): Promise<void>;
  /** Told once the message is in the agent's queue: the page's `prompt` event. */
  admitted(event: { agentId: string; messageId: string; text: string; conversation: string; userId?: string }): void;
  failed(agentId: string, message: string): void;
  log(line: string): void;
}

export interface SendMessage {
  agentId: string;
  text: string;
  conversation?: string;
  /** Who is asking: absent for the installation's own credential. */
  userId?: string;
  messageId: string;
  /** A press on a card the agent drew (show-ui.ts): `{ surface, name }`. */
  surfaceAction?: unknown;
  workRelation?: unknown;
}

export type SendResult =
  | { admitted: true; messageId: string; conversation: string }
  | { refused: ErrorCode; status: number; vars?: Record<string, string> }
  /** The queue would not take it (a stopped resource, a work root that cannot be written): nothing was admitted. */
  | { failed: string };

/** Sends a person's message; resolves once it is in the agent's queue, or with why it is not. The turn runs on after. */
export async function sendMessage(deps: SendMessageDeps, input: SendMessage): Promise<SendResult> {
  const { agentId } = input, text = input.text.trim();
  if (isContextCommand(text) || isRecoveryCommand(text) || isRetryCommand(text) || isGoalCommand(text)) return { refused: "console-context-command", status: 409 };
  if (!deps.has(agentId)) return { refused: "agent-unknown", status: 404, vars: { agent: agentId } };
  if (text === "") return { refused: "text-required", status: 400 };
  const conversation = input.conversation !== undefined && input.conversation !== "" ? input.conversation : MAIN_CONVERSATION;
  if (isForkChild(conversation)) return { refused: "fork-read-only", status: 409 }; // INV-1667
  if (!(await deps.modelReady(agentId))) return { refused: "model-not-configured", status: 409 };
  const surfaceWork = input.surfaceAction ? deps.surfaceWork({ action: input.surfaceAction, text, agentId, conversation }) : undefined;
  if (surfaceWork !== undefined && "error" in surfaceWork) return { refused: "surface-work-unavailable", status: 409, vars: { reason: surfaceWork.error } };
  const chatKey = conversation === MAIN_CONVERSATION ? undefined : deps.chatKeyFor(conversation);
  // A thread from before the directory existed is addressable again on its next inbound message; said, because a
  // message that quietly goes nowhere is the failure this codebase keeps finding.
  if (conversation !== MAIN_CONVERSATION && chatKey === undefined) deps.log(`console message to ${conversation} stays on the web: no chat recorded for it`);
  if (chatKey !== undefined) deps.pushToChat(chatKey, `〔控制台〕${text}`, "console");
  const before = deps.transcriptLength(agentId, conversation);
  const work = surfaceWork !== undefined
    ? { ...(surfaceWork.work ? { work: surfaceWork.work, workRelation: "continue" as const } : {}), taskBinding: surfaceWork.taskBinding, steerable: false }
    : input.workRelation === "new" || input.workRelation === "continue" ? { workRelation: input.workRelation as "new" | "continue" } : {};
  return new Promise<SendResult>(resolve => {
    let admitted = false;
    const onAdmitted = () => {
      admitted = true;
      deps.admitted({ agentId, messageId: input.messageId, text, conversation, ...(input.userId !== undefined ? { userId: input.userId } : {}) });
      resolve({ admitted: true, messageId: input.messageId, conversation });
    };
    void deps.turn(agentId, text, input.userId !== undefined ? { userId: input.userId } : {}, { conversation, messageId: input.messageId, ...work, onAdmitted })
      // The reply belongs to the same room the interjection went to: read back from the transcript, as the channel path does.
      .then(() => { if (chatKey !== undefined) { const said = deps.replySince(agentId, before, conversation); if (said !== "") deps.pushToChat(chatKey, said, "console reply"); } })
      .then(() => deps.settle())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`turn failed: ${message}`);
        deps.failed(agentId, message);
        if (!admitted) resolve({ failed: message });
      });
  });
}
