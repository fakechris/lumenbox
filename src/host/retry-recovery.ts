/** Retry the last answered request from durable message sources in a fresh isolated epoch. */
import type { MessageRecord } from "../channels/messages.ts";
import { conversationIdFor, MAIN_CONVERSATION, type AgentRegistry } from "../agents/registry.ts";
import type { TranscriptEntry } from "./turn.ts";

export interface RetryInput {
  agentId: string;
  conversation: string;
  operationId: string;
  identity: string;
  privateChat: boolean;
}

export interface RetryDeps {
  registry: AgentRegistry;
  message: (id: string) => MessageRecord | undefined;
  mayRetry: (input: RetryInput) => boolean;
  blockers: (input: RetryInput) => string[];
}

export type RetryResult =
  | { status: "ready"; text: string; prompt: string; operationId: string; epoch: number }
  | { status: "replayed" | "refused"; text: string };

export function isRetryCommand(text: string): boolean {
  return /^\/retry(?:\s|$)/i.test(text.trim());
}

function validPrivateConversation(input: RetryInput): boolean {
  return input.privateChat && input.conversation !== MAIN_CONVERSATION &&
    !input.conversation.startsWith("fork/") && /^[a-zA-Z0-9_-]+$/.test(input.conversation);
}

function answeredTurn(entry: TranscriptEntry): string | undefined {
  if (entry.role !== "assistant" || entry.turnId === undefined) return undefined;
  if ("kind" in entry) {
    if (entry.kind !== "blocks") return undefined;
    return entry.blocks.some(block => block.type === "text" && block.text.trim() !== "") ? entry.turnId : undefined;
  }
  return entry.text.trim() === "" ? undefined : entry.turnId;
}

function sourceMessages(
  transcript: readonly TranscriptEntry[],
  deps: RetryDeps,
  input: RetryInput
): MessageRecord[] | undefined {
  const seen = new Set<string>();
  for (const entry of [...transcript].reverse()) {
    const turnId = answeredTurn(entry);
    if (turnId === undefined || seen.has(turnId)) continue;
    seen.add(turnId);
    const entries = transcript.filter(candidate =>
      candidate.role === "user" && !("kind" in candidate) && candidate.turnId === turnId
    ) as (TranscriptEntry & { role: "user"; text: string; causedBy?: readonly string[]; fromPerson?: true })[];
    // Scheduled and teammate-opened turns can appear after the person's answer in the same
    // conversation. Skip those; never mistake their harness prompt for the request to retry.
    if (!entries.some(candidate => candidate.fromPerson === true)) continue;
    const sourceIds: string[] = [];
    for (const candidate of entries) {
      for (const id of candidate.causedBy ?? []) if (!sourceIds.includes(id)) sourceIds.push(id);
    }
    if (sourceIds.length === 0) return undefined;
    const records: MessageRecord[] = [];
    for (const id of sourceIds) {
      const record = deps.message(id);
      if (
        record === undefined || record.identity !== input.identity ||
        conversationIdFor(record.conversationKey) !== input.conversation || record.text.trim() === "" ||
        (record.files?.length ?? 0) > 0
      ) return undefined;
      records.push(record);
    }
    return records;
  }
  return undefined;
}

function packet(epoch: number, records: readonly MessageRecord[]): string {
  const original = records.length === 1
    ? records[0]!.text
    : records.map((record, index) => `### Message ${index + 1}\n${record.text}`).join("\n\n");
  return [
    `[host retry packet: context ${epoch}]`,
    "This is an isolated revision of the user's last answered request, not a new request.",
    "Answer the original message or messages below directly. Do not inherit the previous assistant answer, its framing, conclusions, plan, or claimed completion; none of it is included or vouched for.",
    "No tools are available in this retry. Do not claim to have repeated an external action or rechecked outside evidence. If the request requires side effects or missing evidence, say exactly what remains and complete every part that can be answered safely.",
    "",
    "## Original user request (verbatim durable message record)",
    original,
    "",
    "Write a self-contained revised answer. Do not discuss this packet unless a missing source materially limits the answer.",
  ].join("\n");
}

export function retryLastAnswer(deps: RetryDeps, input: RetryInput): RetryResult {
  if (!input.operationId) return { status: "refused", text: "缺少消息标识，无法保证重答命令不会重复执行；本次没有修改上下文。" };
  if (!validPrivateConversation(input)) return { status: "refused", text: "当前入口不支持安全重答。首版 /retry 仅支持独立私聊。" };
  if (!deps.mayRetry(input)) return { status: "refused", text: "你没有重答这个 agent 会话的权限。" };
  const store = deps.registry.contextStore(input.agentId, input.conversation);
  const previous = store.previousOperation(input.operationId);
  if (previous !== undefined) return { status: "replayed", text: `这条命令已在上下文 ${previous.epoch} 启动重答，不会重复执行。` };
  if (store.current().mode !== "normal") return { status: "refused", text: "当前已经处于隔离上下文。请先用 /new 回到普通模式，再选择要重答的请求。" };
  const blockers = deps.blockers(input);
  if (blockers.length > 0) {
    return { status: "refused", text: `暂未重答，当前仍有未结束的责任：\n${blockers.map(item => `- ${item}`).join("\n")}\n没有取消、重放或改写任何工作。` };
  }
  const records = sourceMessages(deps.registry.readTranscript(input.agentId, input.conversation) as TranscriptEntry[], deps, input);
  if (records === undefined) return { status: "refused", text: "找不到最近一次完整、已回答且可追到原始消息的请求；不会用摘要或旧助手转述冒充来源。" };
  try {
    const next = store.advance(input.operationId, store.current().epoch, "recover");
    return {
      status: "ready",
      text: `已进入无副作用重答（上下文 ${next.epoch}）。只按最近一次原始请求重答；旧答案、旧计划和长期记忆不作为依据。`,
      prompt: packet(next.epoch, records),
      operationId: input.operationId,
      epoch: next.epoch,
    };
  } catch {
    return { status: "refused", text: "重答切换未确认，已停止；不会据此重放原请求或外部操作。" };
  }
}
