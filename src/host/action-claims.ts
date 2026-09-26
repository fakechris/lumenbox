/**
 * Completed-action claims, reconciled against the tools this turn actually called (INV-779).
 *
 * The incident class: the final reply says "已发送" / "I've sent the email" / "记住了" /
 * "已安排在周二", and nothing in the turn sent, saved or scheduled anything. The prompt asks
 * the model not to do this; a prompt is a request. What can be checked without a model is
 * the pairing: a claim of a kind, and whether a tool of the matching kind ran this turn.
 *
 * Deterministic on purpose. A small verb table, one category each, matched only in the
 * completed tense: "I sent / I've sent / sent it"; "已发送 / 发送成功 / 保存好了". A future or
 * conditional ("I'll send", "我会发", "如果需要我可以发") never matches — that is the
 * trailing-intent guard's ground, and treating an offer as a lie is how a guard gets switched
 * off. A claim about somebody else's action ("你已发送的邮件", "对方已回复") is excluded by a
 * short lookbehind. False positives cost more than misses here: the person is told the agent
 * lied, and if it did not, the guard is wrong twice.
 *
 * The tool side reuses the side-effect tiers (INV-691) where the tier is the right cut: a
 * `send` reaches past the box, so any `reach` call — a connector, an MCP mail tool, an upload —
 * satisfies it. Where the tier is not the cut (a save is `self`, like every edit), the tools
 * are named. UI actions (`computer`, `browser_act`) satisfy every acting category because a
 * click can be a send, a save or a calendar entry, and the box sees what it was, not us.
 */
import { sideEffectOf } from "./side-effects.ts";

export type ClaimCategory = "send" | "save" | "schedule" | "check";

/** Claim patterns by category. Completed tense only; first person or subjectless. */
const CLAIMS: Record<ClaimCategory, readonly RegExp[]> = {
  send: [
    // "I sent it", "I've already sent", "I have just replied", "I've posted it".
    /\bI(?:'ve| have)? (?:just |already |now )?(?:sent|replied|posted|forwarded|emailed|messaged)\b/i,
    // "The email has been sent." Not "was sent" — that narrates history as often as it claims.
    /\b(?:email|e-mail|mail|message|reply|invite|invitation)\s+has been (?:sent|posted|forwarded)\b/i,
    // "Done — sent." / "Sent." as a whole line.
    /^(?:done[,.!—–\- ]*)?(?:sent|posted|replied)[.!]?$/im,
    // 已发送 / 已经回复 / 已发给张三 / 已帮你发出 — not 你已发送, 对方已回复.
    /(?<![你您他她们方户])已(?:经)?(?:帮你|替你|给你|帮您|替您|给您)?(?:发送|发出|回复|发布|转发|发给|发过去)/u,
    // 发送成功 / 回复好了 / 发布完毕 / 成功发出.
    /(?:发送|发出|回复|发布|转发)(?:成功|好了|完毕|完成)|成功(?:发送|发出|发布|回复)/u,
  ],
  save: [
    /\bI(?:'ve| have)? (?:just |already |now )?(?:saved|remembered|noted|recorded|stored|written (?:it|that|this) down)\b/i,
    /^(?:done[,.!—–\- ]*)?(?:saved|noted|remembered)[.!]?$/im,
    /(?<![你您他她们方户])已(?:经)?(?:帮你|替你|给你|帮您|替您|给您)?(?:保存|记住|记下|存好|存下|记录)/u,
    /(?:保存|记住|记下|存|记录)(?:好了|完毕|成功)|记住了|记下了/u,
  ],
  schedule: [
    /\bI(?:'ve| have)? (?:just |already |now )?(?:scheduled|set (?:a |the |up a )?(?:reminder|alarm|timer)|added (?:it|this|that|a reminder|an event) to (?:your|the) calendar)\b/i,
    /\b(?:reminder|alarm|meeting|event) (?:is|has been) (?:set|scheduled)\b/i,
    /(?<![你您他她们方户])已(?:经)?(?:帮你|替你|给你|帮您|替您|给您)?(?:安排|定时|设(?:置|好|了)?(?:了)?提醒|加到日程|排在|加了日程)/u,
    /(?:提醒|定时|日程)(?:已)?(?:设好|设置好|安排好|设置成功|设定好)(?:了)?|安排好了|定时好了|设了提醒/u,
  ],
  check: [
    /\bI(?:'ve| have)? (?:just |already |now )?(?:checked|verified|confirmed|double[- ]checked|looked (?:it |that |this )?up)\b/i,
    /^(?:checked|verified|confirmed)[:：.]/im,
    /(?<![你您他她们方户])已(?:经)?(?:帮你|替你|帮您|替您)?(?:核对|核实|查证|验证|检查|查)(?:过|了)?(?![一下])/u,
    // 核对过 / 查过了 / 确认过 — not 没查过, 你查过吗.
    /(?<![没未有你您他她们方户])(?:核对|核实|确认|查证|验证|检查|查|看)过了?(?![。，,]?(?:吗|么|没有|\?|？))/u,
  ],
};

/** Every category the text claims to have completed, in table order. */
export function claimedActions(text: string): ClaimCategory[] {
  const out: ClaimCategory[] = [];
  for (const category of Object.keys(CLAIMS) as ClaimCategory[]) {
    if (CLAIMS[category].some(pattern => pattern.test(text))) out.push(category);
  }
  return out;
}

/** Tools whose call is a UI action: what it did is decided by the page, not the tool name. */
const UI_ACTION = new Set(["computer", "browser_act", "browser_open"]);
/** Tools that write the agent's own records or the box: what a save or a routine file is. */
const SAVE_TOOLS = new Set(["RememberFact", "write_file", "edit_file", "bash", "Checkpoint", "NoteSiteLearning", "Tasks", "SetTodos"]);
/** Routines are skills with a schedule on disk (write_file), tasks carry due dates, and a calendar is a connector. */
const SCHEDULE_TOOLS = new Set(["write_file", "edit_file", "bash", "Tasks"]);
const SCHEDULE_NAME = /schedul|cron|remind|calendar|event|routine|alarm/i;

function reaches(tool: string): boolean {
  const tier = sideEffectOf(tool).tier;
  return tier === "reach" || tier === "spend" || tier === "credential" || tier === "irreversible";
}

/** Whether one tool call counts as having done what the category claims. */
export function satisfies(category: ClaimCategory, tool: string): boolean {
  if (UI_ACTION.has(tool)) return true;
  switch (category) {
    case "send":
      return reaches(tool) || tool === "SendToAgent" || tool === "bash";
    case "save":
      return reaches(tool) || SAVE_TOOLS.has(tool);
    case "schedule":
      return reaches(tool) || SCHEDULE_TOOLS.has(tool) || SCHEDULE_NAME.test(tool);
    case "check":
      // Anything that looked or reached out: a read, a browser, a shell, a connector. Not
      // the bookkeeping tools (SetPlan, RememberFact, AskUser…), which check nothing.
      return sideEffectOf(tool).tier === "observe" || reaches(tool) || tool === "bash";
    default:
      return false;
  }
}

/** The first claimed category no tool call this turn backs, or undefined when every claim is covered. */
export function unmetClaim(text: string, toolsThisTurn: readonly string[]): ClaimCategory | undefined {
  return claimedActions(text).find(category => !toolsThisTurn.some(tool => satisfies(category, tool)));
}

/** The action as the nudge names it. */
export function describeClaim(category: ClaimCategory, chinese: boolean): string {
  switch (category) {
    case "send": return chinese ? "发送/回复/发布" : "sent, replied or posted something";
    case "save": return chinese ? "保存/记住" : "saved or remembered something";
    case "schedule": return chinese ? "安排/定时/设提醒" : "scheduled something or set a reminder";
    case "check": return chinese ? "核对/查证" : "checked or verified something";
    default: return category;
  }
}
