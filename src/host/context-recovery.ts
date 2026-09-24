/** Host-owned control action, never a request to the model to forget something. */
import type { AgentRegistry } from "../agents/registry.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import type { ContextMode } from "../agents/context-epoch.ts";

export function isContextCommand(text: string): boolean {
  return /^\/new(?:\s|$)/i.test(text.trim());
}

export interface NewContextInput {
  agentId: string;
  conversation: string;
  operationId: string;
  identity: string;
  /** Supplied only by a channel adapter that knows this is an independent private chat. */
  privateChat: boolean;
  mode?: ContextMode;
}

export interface ContextRecoveryDeps {
  registry: AgentRegistry;
  mayReset: (input: NewContextInput) => boolean;
  blockers: (input: NewContextInput) => string[];
}

export function newContext(
  deps: ContextRecoveryDeps,
  input: NewContextInput
): { status: "switched" | "replayed" | "refused"; text: string; epoch?: number } {
  if (!deps.mayReset(input)) return { status: "refused", text: "你没有切换这个 agent 会话的权限。" };
  if (
    !input.privateChat ||
    input.conversation === MAIN_CONVERSATION ||
    input.conversation.startsWith("fork/") ||
    !/^[a-zA-Z0-9_-]+$/.test(input.conversation)
  ) {
    return { status: "refused", text: "当前入口不支持安全切换。首版 /new 仅支持独立私聊，不支持群聊、团队主会话或后台任务。" };
  }
  if (!input.operationId) return { status: "refused", text: "缺少消息标识，无法保证重复命令不会再次切换；本次没有修改上下文。" };
  try {
    const store = deps.registry.contextStore(input.agentId, input.conversation);
    const previous = store.previousOperation(input.operationId);
    if (previous !== undefined) {
      return {
        status: "replayed",
        epoch: previous.epoch,
        text: `这条命令已切换到上下文 ${previous.epoch}，不会重复清空当前对话。`,
      };
    }
    const blockers = deps.blockers(input);
    if (blockers.length > 0) {
      return {
        status: "refused",
        text: `暂未切换上下文，还有未结束的工作：\n${blockers.map(item => `- ${item}`).join("\n")}\n请先处理这些工作；没有清队列或取消任务。`,
      };
    }
    // No await between the final custody check and durable commit. All callers share this service.
    const requestedMode = input.mode ?? "normal";
    const current = store.current();
    const next = store.advance(input.operationId, current.epoch, requestedMode);
    return {
      status: "switched",
      epoch: next.epoch,
      text: requestedMode === "clean"
        ? `已进入干净上下文（上下文 ${next.epoch}）。不会载入旧聊天、长期/共享记忆、技能、任务或其他会话，也不会提供工具或自动学习；当前消息仍会留在审计记录中，这不是无痕模式。`
        : `已开始新对话（上下文 ${next.epoch}）。旧聊天、摘要和计划不再自动带入，原记录仍保留；长期记忆仍按相关性使用。${current.mode === "clean" ? "已退出干净模式，长期记忆和工具会按正常权限重新启用。" : "这不是干净模式。"}`,
    };
  } catch {
    return { status: "refused", text: "上下文切换未确认，已停止此控制操作；请检查会话存储状态。不要据此重放原任务。" };
  }
}
