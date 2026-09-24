/** Rebuild one existing task from durable source records, never from its old narrative. */
import type { MessageRecord } from "../channels/messages.ts";
import { conversationIdFor, MAIN_CONVERSATION, type AgentRegistry } from "../agents/registry.ts";
import type { Task, TaskRecovery, TaskStore } from "./tasks.ts";

export interface RecoverTaskInput {
  agentId: string;
  conversation: string;
  operationId: string;
  principal: string;
  privateChat: boolean;
  taskId: string;
}

export function isRecoveryCommand(text: string): boolean {
  return /^\/recover(?:\s|$)/i.test(text.trim());
}

export function parseRecoveryCommand(text: string): string | undefined {
  return /^\/recover\s+(t\d+)$/i.exec(text.trim())?.[1]?.toLowerCase();
}

export interface RecoverTaskDeps {
  registry: AgentRegistry;
  tasks: TaskStore;
  message: (id: string) => MessageRecord | undefined;
  mayRecover: (task: Task, input: RecoverTaskInput) => boolean;
  blockers: (task: Task, input: RecoverTaskInput) => string[];
}

export type RecoverTaskResult =
  | { status: "ready"; text: string; prompt: string; taskId: string; title: string; operationId: string; attempt: number; epoch: number }
  | { status: "replayed" | "refused"; text: string };

function validPrivateConversation(input: RecoverTaskInput): boolean {
  return input.privateChat && input.conversation !== MAIN_CONVERSATION &&
    !input.conversation.startsWith("fork/") && /^[a-zA-Z0-9_-]+$/.test(input.conversation);
}

function originalRequest(deps: RecoverTaskDeps, task: Task): { text: string; label: string } | undefined {
  if (task.sourceMessageId !== undefined) {
    const source = deps.message(task.sourceMessageId);
    if (source === undefined || conversationIdFor(source.conversationKey) !== task.conversation) return undefined;
    return { text: source.text, label: "verbatim durable message" };
  }
  if (task.description !== undefined && !task.description.includes("[截断:原文")) {
    return { text: task.description, label: "complete legacy task request snapshot (no message link was recorded)" };
  }
  return undefined;
}

function packet(task: Task, recovery: TaskRecovery, original: { text: string; label: string }): string {
  const evidence = task.history.flatMap(change => [...(change.evidence ?? []), ...(change.checked ?? [])]);
  return [
    `[host recovery packet: ${task.id}, attempt ${recovery.attempt}, context ${recovery.epoch}]`,
    "This is a revision attempt for the same task, not a new task. Answer the original request below directly.",
    "Do not inherit the previous assistant's framing, plan, claimed completion, or conclusions. No previous answer is included or vouched for.",
    "No tools are available in this first recovery slice. Do not claim to have rechecked anything outside this packet. If one part cannot be answered from the request itself, mark only that part unknown and complete the rest.",
    "",
    `## Original user request (${original.label})`,
    original.text,
    "",
    "## Mechanically known task state before this attempt",
    `- task id: ${task.id}`,
    `- recorded status: ${task.status}`,
    `- requested at: ${task.createdAt}`,
    ...(evidence.length > 0
      ? ["- recorded evidence pointers (pointers only; do not treat their claims as verified without reading them):", ...evidence.map(item => `  - ${item}`)]
      : ["- recorded evidence pointers: none"]),
    "",
    "Write a self-contained revised answer for the user. Do not discuss this packet unless a missing source materially limits the answer.",
  ].join("\n");
}

export function recoverTask(deps: RecoverTaskDeps, input: RecoverTaskInput): RecoverTaskResult {
  if (!input.operationId) return { status: "refused", text: "缺少消息标识，无法保证恢复命令不被重复执行；本次没有修改任务。" };
  if (!validPrivateConversation(input)) return { status: "refused", text: "当前入口不支持安全恢复。首版 /recover 仅支持独立私聊。" };
  const task = deps.tasks.get(input.taskId);
  if (task === undefined || !deps.mayRecover(task, input)) return { status: "refused", text: "找不到你可以恢复的这个任务；任务和上下文均未修改。" };
  if (task.conversation !== input.conversation || task.assigneeId !== input.agentId) {
    return { status: "refused", text: "这个任务不属于当前 agent 和私聊；任务和上下文均未修改。" };
  }
  if (task.proposedBy !== undefined) return { status: "refused", text: "这个任务仍是未承诺的提案，不能作为已执行任务恢复。" };
  const original = originalRequest(deps, task);
  if (original === undefined || original.text.trim() === "") {
    return { status: "refused", text: "找不到完整的原始请求，不能用截断描述或旧助手总结冒充来源；本次没有恢复。" };
  }

  const priorRecovery = task.recoveries?.find(item => item.operationId === input.operationId);
  const priorContext = deps.registry.contextStore(input.agentId, input.conversation).previousOperation(input.operationId);
  if (priorRecovery !== undefined && priorRecovery.status !== "prepared") {
    return { status: "replayed", text: `这条命令已经启动过 ${task.id} 的恢复 attempt ${priorRecovery.attempt}，不会重复执行。` };
  }
  const blockers = deps.blockers(task, input);
  if (blockers.length > 0) {
    return { status: "refused", text: `暂未恢复，当前仍有未结束的责任：\n${blockers.map(item => `- ${item}`).join("\n")}\n没有取消、重放或改写任何工作。` };
  }

  try {
    const store = deps.registry.contextStore(input.agentId, input.conversation);
    const next = priorContext ?? store.advance(input.operationId, store.current().epoch, "recover");
    if (next.mode !== "recover") throw new Error("operation mode mismatch");
    const recovery = priorRecovery ?? deps.tasks.prepareRecovery(task.id, input.operationId, next.epoch, input.principal);
    if (recovery === undefined) throw new Error("task disappeared");
    return {
      status: "ready",
      text: `已为 ${task.id} 建立恢复 attempt ${recovery.attempt}（上下文 ${next.epoch}）。将只按原始请求重做；旧答案、旧计划和长期记忆不作为依据。`,
      prompt: packet(task, recovery, original),
      taskId: task.id,
      title: task.title,
      operationId: input.operationId,
      attempt: recovery.attempt,
      epoch: next.epoch,
    };
  } catch {
    return { status: "refused", text: "恢复切换未确认，已停止；不会据此重放原任务或外部操作。" };
  }
}
