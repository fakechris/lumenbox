/**
 * How far the AI may take a task on its own (INV-1650): one number per task, from 1 to 5.
 *
 * Before this, "how far" was answered in four places that did not know each other: the policy
 * gate per tool, the mandate per task, the goal gate per claim, the project's autonomy level in
 * the work kernel. None of them said, for one task, where the agent should stop and hand back,
 * and the person could neither see nor change it. The levels:
 *
 *   L1  understand and tidy: extract what is asked, summarise the background; no action.
 *   L2  analyse and propose: a plan or recommendation, handed back; no action in the world.
 *   L3  do part of it: intermediate results a person finishes; nothing outside the box.
 *   L4  do most of it: every step that reaches outside — a send, a publish, a payment, a
 *       delete — stops for the person's confirmation, then goes on.
 *   L5  end to end: do it, verify it (the goal gate), deliver it.
 *
 * A level is inferred when the task is created, from what the words ask for and what the task
 * carries; every inference says why, and a person may set it by hand, which is recorded.
 */

export type Level = 1 | 2 | 3 | 4 | 5;

export const LEVEL_MEANING: Record<Level, string> = {
  1: "L1 — understand and tidy only: extract, summarise, organise; take no action",
  2: "L2 — analyse and propose: hand back a plan or recommendation; do not act on it",
  3: "L3 — do part of it: produce intermediate results inside the box for a person to finish; nothing reaches outside",
  4: "L4 — do most of it: any step that reaches outside the box (a send, a publish, a payment, a delete) waits for the person's confirmation, then continues; a message or a post to someone else is drafted with the Outbox tool and sent once approved",
  5: "L5 — end to end: do it, verify it, deliver it",
};

const OUTWARD = /\b(send|email|mail|publish|post|tweet|deploy|release|pay|purchase|buy|order|delete|remove|drop|merge|push|invite|cancel)\b|发送|发邮件|发布|推送|部署|上线|付款|支付|购买|下单|删除|删掉|合并|取消|邀请|群发/i;
const TIDY = /\b(summari[sz]e|summary|digest|collect|gather|list|catalog|transcribe|extract|organi[sz]e|tidy)\b|总结|摘要|整理|汇总|收集|归档|提取|列出/i;
const PLAN = /\b(analy[sz]e|analysis|assess|evaluate|compare|investigate|research|propose|proposal|plan|recommend|option|design|review|audit|diagnose|estimate)\b|分析|评估|对比|调研|研究|方案|建议|计划|设计|评审|审计|诊断|估算|选型/i;

export interface LevelInput {
  title: string;
  description?: string;
  /** A written acceptance makes the goal gate's verification possible, and so end-to-end delivery. */
  hasContract?: boolean;
  /** A goal pursuit: the verifier and the gate are on it by construction. */
  isPursuit?: boolean;
  /** The agent asked for this itself (a sub-task of its own work): it may go as far as its parent did. */
  requesterIsAgent?: boolean;
  /** The assignee's tool allowance, when restricted; null or absent means every tool. */
  assigneeTools?: readonly string[] | null;
}

export interface Inferred {
  level: Level;
  reasons: string[];
}

/** The level a new task starts at, and why. Read from the top: the words first, then what the task carries. */
export function inferLevel(input: LevelInput): Inferred {
  const words = `${input.title}\n${input.description ?? ""}`;
  const reasons: string[] = [];
  let level: Level;
  if (TIDY.test(words) && !PLAN.test(words) && !OUTWARD.test(words)) {
    level = 1; reasons.push("asks to collect or summarise, not to act");
  } else if (PLAN.test(words) && !OUTWARD.test(words) && !/\b(do|implement|build|write the code|fix|ship)\b|实现|修复|落地|开发|编写代码/i.test(words)) {
    level = 2; reasons.push("asks for analysis or a proposal, not for the work itself");
  } else if (input.isPursuit === true || input.hasContract === true) {
    level = 5; reasons.push(input.isPursuit === true ? "a goal with its own gate: verified before it is called done" : "has a written acceptance the gate can verify");
  } else {
    level = 4; reasons.push("ordinary work: done by the agent, outward steps confirmed");
  }
  if (OUTWARD.test(words)) {
    if (level > 4) level = 4;
    reasons.push("names a step that reaches outside (a send, a publish, a payment, a delete): that step waits for confirmation");
  }
  if (input.assigneeTools !== undefined && input.assigneeTools !== null && level >= 3 && !input.assigneeTools.some(tool => tool === "bash" || tool === "write_file" || tool === "edit_file")) {
    level = level > 2 ? 2 : level; reasons.push("the assignee has no tool that changes anything, so it can only read and propose");
  }
  return { level, reasons };
}

/** What a level permits a tool call to do, by the call's side-effect tier (side-effects.ts). */
export function levelAllows(level: Level, tier: string): "allow" | "ask" | "deny" {
  const outward = tier === "reach" || tier === "spend" || tier === "credential" || tier === "irreversible";
  if (!outward) return level >= 3 ? "allow" : tier === "observe" ? "allow" : "deny";
  return level >= 5 ? "allow" : level >= 3 ? "ask" : "deny";
}

export function parseLevel(raw: unknown): Level | undefined {
  const n = typeof raw === "string" ? Number(raw.replace(/^L/i, "")) : raw;
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 ? n : undefined;
}

/** The task an agent is doing in this conversation: the policy gate's level (below) and the config version a turn records against (INV-1669), and the fork record (INV-1667). */
export function currentTaskOf<T extends { id?: string; status: string; conversation?: string }>(context: { agent: { id: string }; conversation?: string; taskBinding?: { taskId: string }; tasks?: { forAgent: (agentId: string) => readonly T[] } }): T | undefined {
  const here = context.conversation ?? "main";
  if (context.taskBinding) return context.tasks?.forAgent(context.agent.id).find(task => task.id === context.taskBinding!.taskId);
  return context.tasks?.forAgent(context.agent.id).find(task => task.status === "doing" && (task.conversation ?? "main") === here);
}

/** The level of the task an agent is doing in this conversation, for the policy gate; none when it has no task in hand. */
export function levelOfCurrentTask(context: { agent: { id: string }; conversation?: string; taskBinding?: { taskId: string }; tasks?: { forAgent: (agentId: string) => readonly { id?: string; status: string; conversation?: string; level?: Level }[] } }): Level | undefined {
  return currentTaskOf(context)?.level;
}
