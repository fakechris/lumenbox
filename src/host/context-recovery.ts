/** Host-owned control action, never a request to the model to forget something. */
import type { AgentRegistry } from "../agents/registry.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { OpeningStagingError, type ContextMode, type OpeningOutcome } from "../agents/context-epoch.ts";
import type { DraftLookup } from "./handoff-draft.ts";
import type { Task } from "./tasks.ts";
import { pursuitBlockers } from "./goal-mode.ts";

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
  /**
   * The handoff prepared for the context being left (INV-1190), read synchronously after the
   * other checks. Absent: no handoff feature, every /new is plain.
   */
  handoffDraft?: (input: NewContextInput) => DraftLookup | undefined;
  registry: AgentRegistry;
  mayReset: (input: NewContextInput) => boolean;
  blockers: (input: NewContextInput) => string[];
}

/**
 * Work that still owns execution custody blocks a context switch. Review does not: the
 * agent has finished, the durable board retains the item, and only the person's verdict
 * remains. Treating review as running made completed work permanently trap a private chat.
 */
export function contextTaskBlockers(
  tasks: readonly Pick<Task, "id" | "status" | "conversation" | "pursuit">[],
  conversation: string,
  excludeTaskId?: string
): string[] {
  const inScope = tasks
    .filter(task => task.id !== excludeTaskId)
    .filter(task => (task.conversation ?? MAIN_CONVERSATION) === conversation);
  // A goal the agent is pursuing holds the conversation while it runs, and says how to let
  // go; paused, it holds nothing — the board keeps it and `/goal resume` brings it back
  // (docs/74 §7 R7).
  return [
    ...pursuitBlockers(inScope, conversation),
    ...inScope
      .filter(task => task.pursuit === undefined)
      .filter(task => task.status === "open" || task.status === "doing" || task.status === "blocked")
      .map(task => `任务 ${task.id}：${task.status}`),
  ];
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
        text: `这条命令已切换到上下文 ${previous.epoch}，不会重复清空当前对话。${openingLine(previous.opening)}`,
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
    // A prepared handoff rides only a normal switch out of a normal context: `/new --clean`
    // means nothing of the old context comes along, and that includes a note about it.
    const draft = requestedMode === "normal" && current.mode === "normal" ? deps.handoffDraft?.(input) : undefined;
    let next: ReturnType<typeof store.advance>;
    let unavailable = draft?.status === "stale" ? `之前备好的交接笔记没有带入：${staleReason(draft.reason)}。` : "";
    if (draft?.status === "valid") {
      try {
        next = store.advance(input.operationId, current.epoch, "normal", { opening: draft.opening });
      } catch (error) {
        // Thrown before anything durable: switch without it, and say so.
        if (!(error instanceof OpeningStagingError)) throw error;
        next = store.advance(input.operationId, current.epoch, requestedMode);
        unavailable = "之前备好的交接笔记没能写入，本次没有带入。";
      }
    } else {
      next = store.advance(input.operationId, current.epoch, requestedMode);
    }
    return {
      status: "switched",
      epoch: next.epoch,
      text: requestedMode === "clean"
        ? `已进入干净上下文（上下文 ${next.epoch}）。不会载入旧聊天、长期/共享记忆、技能、任务或其他会话，也不会提供工具或自动学习；当前消息仍会留在审计记录中，这不是无痕模式。`
        : `已开始新对话（上下文 ${next.epoch}）。${next.opening === undefined ? "旧聊天、摘要和计划不再自动带入，" : ""}原记录仍保留；长期记忆仍按相关性使用。${openingLine(next.opening)}${unavailable}${current.mode !== "normal" ? "已退出隔离模式，长期记忆和工具会按正常权限重新启用。" : "这不是干净模式。"}`,
    };
  } catch {
    return { status: "refused", text: "上下文切换未确认，已停止此控制操作；请检查会话存储状态。不要据此重放原任务。" };
  }
}

/** What the reply says about the handoff, from what was actually installed (INV-1190). */
function openingLine(opening: OpeningOutcome | undefined): string {
  if (opening === "handoff") return "已带入上一段对话的交接笔记（目标、进度、未结事项和你的原话）。";
  if (opening === "placeholder") return "交接笔记在切换中丢失，没有带入；需要时我会用 ReadHistory 查原记录。";
  return "";
}

function staleReason(reason: string): string {
  if (/moved to another context/.test(reason)) return "对话已经切换过";
  if (/went on/.test(reason)) return "写好之后对话又继续了";
  if (/plan or todos/.test(reason)) return "写好之后计划或待办有变化";
  if (/mode/.test(reason)) return "上下文模式变了";
  return "它已不可用";
}
