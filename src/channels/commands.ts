/**
 * What a person can say in a chat that is a command rather than work (INV-1660): one table, and
 * the parsers that read it.
 *
 * Before this file the verbs lived in three places — the manager's word lists, `verbs.ts`, the
 * host's `/new`, `/goal`, `/recover`, `/retry` matchers — and the only list of them a person could
 * read was whatever somebody had last written by hand. Now each command is one entry: what it is
 * written as (every alias, the Chinese verbs included), what it does in a sentence, where it works
 * and who may use it. The manager and the host dispatch through the parsers below, `/help` is
 * rendered from the table, `docs/reference-commands.md` is generated from it, and
 * architecture-guard fails a slash command or a word list that appears anywhere else.
 *
 * Every verb is whole-message: "停下来改用另一个文件夹" is an instruction that mentions stopping,
 * and reading it as a stop would throw away the half that says what to do instead. Each parser
 * keeps the normalisation it always had (which trailing punctuation it forgives) — the table owns
 * the words, not a new matching rule.
 *
 * A leaf module: nothing here imports the manager or the host, so either may import it.
 */

import { DEFAULT_LOCALE, type Locale } from "../i18n/locale.ts";

/** Who may use a command. */
export type CommandWho = "stranger" | "allowed" | "asked" | "owner" | "admin" | "mixed";

/** Where it works: every channel, or only an independent private chat (the context commands). */
export type CommandDoors = "every" | "private";

export interface CommandForm {
  /** As /help and the reference write it. */
  syntax: string;
  /** Whole messages that are this form, after the command's own normalisation (lower case). */
  words?: readonly string[];
  /** Or the shape of the whole message, for a form with arguments. */
  pattern?: RegExp;
  /** What this form does, when a command has several. */
  does?: Record<Locale, string>;
}

export interface ChatCommand {
  key: string;
  forms: readonly CommandForm[];
  /** One sentence, in each language a person is spoken to in. */
  summary: Record<Locale, string>;
  /**
   * The prefix that claims a message for this command even when its arguments are wrong, so a
   * malformed `/recover` gets its usage instead of going to the model as work.
   */
  claims?: RegExp;
  doors: CommandDoors;
  who: CommandWho;
  /** A condition the command only means something under, said in words. */
  when?: Record<Locale, string>;
  /** `wire`: answered by the host, no model turn. `turn`: starts or steers a model turn. */
  answered: "wire" | "turn";
  /** The usage line it answers a malformed message with, when it has one of its own. */
  usage?: string;
}

const GOAL_USAGE_TEXT =
  "用法：/goal <目标> [--budget <额度>] 创建；/goal 查看；/goal pause | resume | clear；/goal replace <目标>；/goal confirm <序号> 确认清单里的命令；/goal budget <额度> 给当前目标设预算（折算输入 token 数）。";

/** Every chat command, in the order the manager checks them. */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    key: "bind",
    forms: [{ syntax: "bind <code>", pattern: /^(?:bind|绑定)[\s::]+([a-z0-9-]{4,12})$/i }],
    summary: { zh: "用邀请码把自己加进来（绑定 <码> 也行）。", en: "Join with an invite code (also 绑定 <码>)." },
    doors: "every",
    who: "stranger",
    answered: "wire",
  },
  {
    key: "new",
    claims: /^\/new(?:\s|$)/i,
    forms: [
      { syntax: "/new", words: ["/new"], does: { zh: "开一个新上下文，带上交接摘要。", en: "a fresh context, with a handoff of the one being left" } },
      { syntax: "/new --clean", words: ["/new --clean"], does: { zh: "开一个隔离的干净上下文，只接受文字。", en: "an isolated clean context that takes text only" } },
    ],
    summary: { zh: "换一个新的对话上下文；不会让模型假装忘记。", en: "Start a new conversation context; the host switches it, the model is not asked to forget." },
    doors: "private",
    who: "allowed",
    when: { zh: "没有运行中、排队、待回答或待审批的事时。", en: "when nothing is running, queued, waiting for an answer or a consent." },
    answered: "wire",
  },
  {
    key: "goal",
    claims: /^\/goal(?:\s|$)/i,
    forms: [
      { syntax: "/goal <目标> [--budget <额度>]", does: { zh: "创建目标，先起草检查清单。", en: "create a goal; its first turn drafts the checklist" } },
      { syntax: "/goal", does: { zh: "查看当前目标。", en: "show the current goal" } },
      { syntax: "/goal pause | resume | clear", does: { zh: "暂停、继续或清除。", en: "pause, resume or clear it" } },
      { syntax: "/goal replace <目标>", does: { zh: "换一个目标。", en: "replace the objective" } },
      { syntax: "/goal confirm <序号>", does: { zh: "确认清单里的命令。", en: "confirm a command on the checklist" } },
      { syntax: "/goal budget <额度>", does: { zh: "设预算（折算输入 token 数）。", en: "set the budget, in input-token equivalents" } },
    ],
    summary: { zh: "目标模式：给一个目标，一直做到检查清单通过（docs/74）。", en: "Goal mode: pursue one objective until its checklist passes (docs/74)." },
    doors: "private",
    who: "allowed",
    answered: "turn",
    usage: GOAL_USAGE_TEXT,
  },
  {
    key: "recover",
    claims: /^\/recover(?:\s|$)/i,
    forms: [{ syntax: "/recover t<任务号>", pattern: /^\/recover\s+(t\d+)$/i }],
    summary: { zh: "从原始记录重建一个任务，再接着做。", en: "Rebuild a task from its source records and carry on." },
    doors: "private",
    who: "owner",
    answered: "turn",
    usage: "用法：/recover t任务号（例如 /recover t25）。本次没有修改任务。",
  },
  {
    key: "retry",
    claims: /^\/retry(?:\s|$)/i,
    forms: [{ syntax: "/retry", words: ["/retry"] }],
    summary: { zh: "把上一个回答重答一遍，不重复任何副作用。", en: "Answer the last request again, without repeating any side effect." },
    doors: "private",
    who: "allowed",
    answered: "turn",
    usage: "用法：/retry。本次没有修改上下文。",
  },
  {
    key: "approve",
    forms: [
      { syntax: "允许", words: ["allow", "approve", "yes", "ok", "y", "允许", "同意", "批准", "好"], does: { zh: "这一次允许。", en: "allow this once" } },
      { syntax: "一直允许", words: ["allow always", "always", "一直允许", "总是允许"], does: { zh: "以后同样的操作都允许。", en: "allow this exact action from now on" } },
      { syntax: "本次会话", words: ["allow session", "session", "本次会话"], does: { zh: "本次会话内允许。", en: "allow it for this session" } },
      { syntax: "拒绝", words: ["deny", "refuse", "reject", "no", "n", "拒绝", "不"], does: { zh: "拒绝。", en: "refuse" } },
    ],
    summary: { zh: "回答正在等你的同意请求。", en: "Answer the consent that is waiting for you." },
    doors: "every",
    who: "asked",
    when: { zh: "有一个同意请求在等你时。", en: "while a consent is waiting for you." },
    answered: "wire",
  },
  {
    key: "upgrade",
    forms: [{ syntax: "升级", words: ["upgrade", "/upgrade", "升级", "确认升级", "同意升级"] }],
    summary: { zh: "批准 box 正在请示的升级。", en: "Approve the upgrade the box has asked about." },
    doors: "every",
    who: "admin",
    when: { zh: "box 有升级在等批准时。", en: "while an upgrade is waiting for approval." },
    answered: "wire",
  },
  {
    key: "scope",
    forms: [
      { syntax: "scope", pattern: /^scope$/i, does: { zh: "看这个群绑定的范围。", en: "show this group chat's scope" } },
      { syntax: "scope off", pattern: /^scope\s+(?:off|解绑)$/i, does: { zh: "解绑（管理员）。", en: "unbind it (admin)" } },
      { syntax: "scope <名字>", pattern: /^scope\s+([\p{L}\p{N}._-]{1,60})$/iu, does: { zh: "绑定一个范围（管理员）。", en: "bind a scope (admin)" } },
    ],
    summary: { zh: "这个群里的任务能用哪些工具和凭据。", en: "Which tools and secrets every task in this group chat may use." },
    doors: "every",
    who: "mixed",
    answered: "wire",
  },
  {
    key: "board",
    forms: [{ syntax: "看板", words: ["看板", "任务", "任务列表", "board", "tasks", "/board", "/tasks"] }],
    summary: { zh: "看看手上有哪些任务。", en: "Show the board: what is on the plate right now." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "roster",
    forms: [{ syntax: "团队", words: ["team", "roster", "团队", "成员", "谁在", "/team", "/roster"] }],
    summary: { zh: "看看谁在这里干活。", en: "Show who works here." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "schedules",
    forms: [{ syntax: "定时", words: ["定时", "自动化", "定时任务", "schedules", "automations", "/schedules", "/auto"] }],
    summary: { zh: "看看哪些事会自己定时跑。", en: "Show what runs by itself." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "digest",
    forms: [
      { syntax: "早报", words: ["早报", "日报", "digest"], does: { zh: "现在读一份。", en: "read it now" } },
      { syntax: "早报 关", pattern: /^(?:早报|日报|digest)\s*(?:off|关|停止?)$/, does: { zh: "停掉。", en: "stop it" } },
      { syntax: "早报 8点", pattern: /^(?:早报|日报|digest)\s*(?:at\s*)?(\d{1,2})\s*[点时]?$/, does: { zh: "每天这个点发。", en: "send it daily at that hour" } },
    ],
    summary: { zh: "这个群的早报：现在读、定时发、或停掉。", en: "This group chat's digest: read it now, schedule it, or stop it." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "continue",
    claims: /^\/continue(?:\s|$)/u,
    forms: [{ syntax: "/continue <任务号> <内容>" }],
    summary: { zh: "给你正在进行的任务追加一句。", en: "Add an instruction to a task of yours that is running." },
    doors: "every",
    who: "owner",
    answered: "turn",
  },
  {
    key: "answer",
    claims: /^\/answer(?:\s|$)/u,
    forms: [{ syntax: "/answer <问题号> <答案>" }],
    summary: { zh: "回答 agent 问你的问题（按钮就是这句话）。", en: "Answer a question an agent asked you (what its buttons send)." },
    doors: "every",
    who: "asked",
    answered: "turn",
  },
  {
    key: "stop",
    forms: [{ syntax: "停", words: ["停", "停下", "停下来", "先停", "取消", "算了", "别做了", "stop", "cancel", "/stop"] }],
    summary: { zh: "停下正在做的事，并撤回这个任务。", en: "Stop what is running, and withdraw its task." },
    doors: "every",
    who: "owner",
    answered: "wire",
  },
  {
    key: "accept",
    forms: [{ syntax: "可以", words: ["可以", "好了", "好的", "好", "收到", "没问题", "通过", "验收通过", "就这样", "ok", "okay", "lgtm", "辛苦了"] }],
    summary: { zh: "验收等你确认的那个任务。", en: "Accept the task that is waiting on you." },
    doors: "every",
    who: "asked",
    when: { zh: "有任务在等你验收时；否则只是聊天。", en: "while a task waits on you; otherwise it is just chat." },
    answered: "wire",
  },
  {
    key: "help",
    forms: [{ syntax: "/help", words: ["/help"] }],
    summary: { zh: "列出这些命令。", en: "List these commands." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "desktop",
    forms: [{ syntax: "桌面", words: ["desktop", "vnc", "桌面", "开桌面", "看桌面", "/desktop", "/vnc"] }],
    summary: { zh: "给一个实时桌面的链接，可以接管。", en: "A link to the live desktop, to watch or take over." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "join",
    forms: [{ syntax: "入会 <会议号>", pattern: /^(?:\/join|入会|加入会议)\s*(\d{9})$/ }],
    summary: { zh: "让 agent 按会议号入会（/join 也行）。", en: "Have the agent join a meeting by its number (also /join)." },
    doors: "every",
    who: "allowed",
    when: { zh: "这个渠道能入会时。", en: "on a channel that can join meetings." },
    answered: "turn",
  },
  {
    key: "screen",
    forms: [{ syntax: "屏幕", words: ["screen", "screenshot", "屏幕", "看屏幕", "看看屏幕", "截图", "/screen"] }],
    summary: { zh: "截一张桌面现在的样子，不跑任何回合。", en: "A still of the desktop as it is; no turn runs." },
    doors: "every",
    who: "allowed",
    answered: "wire",
  },
  {
    key: "address",
    forms: [{ syntax: "@名字 <消息>", pattern: /^@([\p{L}\p{N}_-]+)\s+([\s\S]+)$/u }],
    summary: { zh: "开头 @ 一个 agent，就是交给它做。", en: "Open with @name to give the message to that agent." },
    doors: "every",
    who: "allowed",
    answered: "turn",
  },
];

const BY_KEY = new Map(CHAT_COMMANDS.map(command => [command.key, command]));

export function chatCommand(key: string): ChatCommand {
  const command = BY_KEY.get(key);
  if (command === undefined) throw new Error(`no chat command ${key}`);
  return command;
}

/** The words of one form of a command (the first, unless named by its syntax). */
function words(key: string, syntax?: string): readonly string[] {
  const forms = chatCommand(key).forms;
  const form = syntax === undefined ? forms[0] : forms.find(f => f.syntax === syntax);
  if (form?.words === undefined) throw new Error(`chat command ${key} has no words${syntax === undefined ? "" : ` for ${syntax}`}`);
  return form.words;
}

function pattern(key: string, syntax?: string): RegExp {
  const forms = chatCommand(key).forms;
  const form = syntax === undefined ? forms[0] : forms.find(f => f.syntax === syntax);
  if (form?.pattern === undefined) throw new Error(`chat command ${key} has no pattern${syntax === undefined ? "" : ` for ${syntax}`}`);
  return form.pattern;
}

const claims = (key: string, text: string): boolean => chatCommand(key).claims!.test(text.trim());

// ── the parsers the manager and the host dispatch through ─────────────────────────────

export function isContextCommand(text: string): boolean {
  return claims("new", text);
}
/** The `/new` forms that do something; anything else claimed by `/new` gets the refusal. */
export function contextMode(command: string): "normal" | "clean" | undefined {
  if (words("new", "/new").includes(command)) return "normal";
  if (words("new", "/new --clean").includes(command)) return "clean";
  return undefined;
}
export function isGoalCommand(text: string): boolean {
  return claims("goal", text);
}
export const GOAL_USAGE = GOAL_USAGE_TEXT;
export function isRecoveryCommand(text: string): boolean {
  return claims("recover", text);
}
export function parseRecoveryCommand(text: string): string | undefined {
  return pattern("recover").exec(text.trim())?.[1]?.toLowerCase();
}
export function isRetryCommand(text: string): boolean {
  return claims("retry", text);
}
export function isPlainRetry(text: string): boolean {
  return words("retry").includes(text.trim().toLowerCase());
}

/** How a one-word reply on a chat answers a pending approval. */
export type ApprovalReply = "once" | "always" | "session" | "deny";

/**
 * Reads a whole message as an approval answer, or nothing.
 *
 * The message must be *only* the verb — "allow" answers, "allow the download" does not,
 * because the second is a person talking about the request, not deciding it, and a
 * loose match would approve a dangerous action from an offhand sentence.
 */
export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (words("approve", "允许").includes(t)) return "once";
  if (words("approve", "一直允许").includes(t)) return "always";
  if (words("approve", "本次会话").includes(t)) return "session";
  if (words("approve", "拒绝").includes(t)) return "deny";
  return undefined;
}

/** A whole message of the shape `bind <code>` / `绑定 <码>`, or nothing. */
export function parseBind(text: string): string | undefined {
  const match = pattern("bind").exec(text.trim());
  return match === null ? undefined : match[1]!.toUpperCase();
}

export type ScopeRequest = { kind: "show" } | { kind: "bind"; name: string } | { kind: "off" };

/** A whole message about this chat's scope: `scope` shows, `scope <name>` binds, `scope off` unbinds. */
export function parseScopeRequest(text: string): ScopeRequest | undefined {
  const t = text.trim();
  if (pattern("scope", "scope").test(t)) return { kind: "show" };
  if (pattern("scope", "scope off").test(t)) return { kind: "off" };
  const bind = pattern("scope", "scope <名字>").exec(t);
  if (bind !== null) return { kind: "bind", name: bind[1]! };
  return undefined;
}

/**
 * A whole message approving the upgrade the box has asked about. This one authorises destroying
 * a box, so "upgrade the deploy script" must never be read as consent. The English word is the
 * one the notice itself prints (`UPGRADE_WORD`), and a test holds the two together.
 */
export function parseUpgradeApproval(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return words("upgrade").includes(t);
}

/** A whole message asking to see the board; a sentence *about* the board ("看板上加一条") is work. */
export function parseBoardRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return words("board").includes(t);
}

/** A whole message asking what runs by itself; "定时任务改成七点" is work for an agent. */
export function parseSchedulesRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?~]+$/, "");
  return words("schedules").includes(t);
}

/** 「团队」: who works here. "让团队看看这个" is work for the team, not a roster request. */
export function parseRosterRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return words("roster").includes(t);
}

export type DigestRequest = { kind: "now" } | { kind: "schedule"; hour: number } | { kind: "off" };

/** "早报" reads it now, "早报 8点" schedules it, "早报 关" stops it; a sentence *about* the digest is a task. */
export function parseDigestRequest(text: string): DigestRequest | undefined {
  const t = text.trim().toLowerCase();
  if (words("digest").includes(t)) return { kind: "now" };
  if (pattern("digest", "早报 关").test(t)) return { kind: "off" };
  const scheduled = pattern("digest", "早报 8点").exec(t);
  if (scheduled !== null) {
    const hour = Number(scheduled[1]);
    if (hour >= 0 && hour <= 23) return { kind: "schedule", hour };
  }
  return undefined;
}

/** Intent is not ownership. Only an explicit task/question reference can join work. */
export function parseContinuation(text: string): { kind: "continue" | "answer"; id: string; text: string } | undefined {
  const match = /^\/(continue|answer)\s+([A-Za-z0-9_-]+)\s+([\s\S]*\S)\s*$/u.exec(text.trim());
  if (match === null) return undefined;
  return { kind: match[1] as "continue" | "answer", id: match[2]!, text: match[3]! };
}

/** A `/continue` or `/answer` that is not a well-formed reference: answered with how to write one. */
export function claimsReference(text: string): boolean {
  return claims("continue", text) || claims("answer", text);
}

/** A whole message that means "stop what you are doing" — only the verb, never a sentence mentioning it. */
export function parseStopRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~]+$/, "");
  return words("stop").includes(t);
}

/**
 * A whole message that means "I accept this work". Whole-message only — "可以再快点吗" is a
 * question that contains an acceptance word, and accepting on it would close work the person was
 * pushing back on.
 */
export function parseAcceptance(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!。!~,,]+$/, "");
  return words("accept").includes(t);
}

/** 「屏幕」is a look, not a task; "看看屏幕上的报错" is a person talking about the screen. */
export function parseScreenRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return words("screen").includes(t);
}

/** 「桌面」asks for the live screen, as a link — where 「屏幕」 asks for a still. */
export function parseDesktopRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。!?]+$/, "");
  return words("desktop").includes(t);
}

/**
 * 「入会 123456789」 asks the agent to join a meeting by number — the trigger that does not depend
 * on the vendor's invite machinery (R37). Returns the meeting number, or undefined.
 */
export function parseMeetingJoinRequest(text: string): string | undefined {
  return pattern("join").exec(text.trim())?.[1];
}

/** `@Name rest of the message` addresses a specific agent; anything else is the default. */
export function parseAddress(text: string): { agentName?: string; text: string } {
  const match = pattern("address").exec(text.trim());
  if (match === null) return { text: text.trim() };
  return { agentName: match[1], text: match[2]!.trim() };
}

export function parseHelpRequest(text: string): boolean {
  return words("help").includes(text.trim().toLowerCase());
}

// ── /help ─────────────────────────────────────────────────────────────────────────────

const PRIVATE_NOTE: Record<Locale, string> = { zh: "（仅独立私聊）", en: " (private chats only)" };
const HELP_HEAD: Record<Locale, string> = {
  zh: "整条消息就是下面这句话时才算命令；其他话都会交给 agent 去做。",
  en: "A message is a command only when it is the whole message; anything else is work for an agent.",
};

/** What `/help` answers: every command in the table, one line each. */
export function renderHelp(locale: Locale = DEFAULT_LOCALE): string {
  const lines = CHAT_COMMANDS.map(command => {
    const syntax = command.forms.map(form => form.syntax).join(" · ");
    const when = command.when === undefined ? "" : ` ${command.when[locale]}`;
    return `· ${syntax} — ${command.summary[locale]}${when}${command.doors === "private" ? PRIVATE_NOTE[locale] : ""}`;
  });
  return [HELP_HEAD[locale], ...lines].join("\n");
}

/** Who may use it, as the reference says it. */
export const WHO_MEANS: Record<CommandWho, string> = {
  stranger: "someone not on the allow list yet",
  allowed: "anyone the channel admits",
  asked: "the person who was asked",
  owner: "the person whose task it is",
  admin: "an administrator",
  mixed: "anyone to read; an administrator to change",
};

/** Every slash word the table knows, for the guard: `/new`, `/goal`, `/stop`, … */
export function registeredSlashWords(): Set<string> {
  const out = new Set<string>();
  for (const command of CHAT_COMMANDS) {
    for (const form of command.forms) {
      for (const word of form.words ?? []) if (word.startsWith("/")) out.add(word.split(/\s/)[0]!);
      for (const token of form.syntax.match(/\/[a-z]+/g) ?? []) out.add(token);
      for (const token of form.pattern?.source.match(/\\\/[a-z]+/g) ?? []) out.add(token.slice(1));
    }
    for (const token of command.claims?.source.match(/\\\/[a-z]+/g) ?? []) out.add(token.slice(1));
  }
  return out;
}
