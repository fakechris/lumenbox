/**
 * What a tool call is doing, in a person's words (INV-783).
 *
 * The activity feed rendered `Ada → bash` and the task card `bash: python batch.py`. Both
 * are true and neither is what the person glancing at them wanted to know, which is
 * "what is it doing, roughly" — running a command, reading a file, opening a website.
 * `progress-file.ts` rightly refuses to turn tool calls into a progress number; this is
 * the other half: a phrase, not a number, and never a guess.
 *
 * Deterministic on purpose: a table from tool name to a template, plus one extractor
 * that picks the *safe* argument to show. Safe means: the program name of a command and
 * never the command (a command line carries tokens, paths and people's names); the
 * basename of a file and never its path; the hostname of a URL and never its path or
 * query (a query string is where the secrets and the search terms live). A tool this
 * table does not know — an MCP server's, an extension's — gets a generic phrase with the
 * tool's own display name, so a new integration is never rendered as nothing.
 *
 * Two languages, the same two as `i18n/locale.ts`. The caller says which; the page and
 * the card each already know the person's language, and the phrase does not second-guess
 * them.
 */

import { basename, posix } from "node:path";
import type { Locale } from "../i18n/locale.ts";
import { MCP_SEPARATOR } from "./mcp.ts";

/** One phrase in both languages. `{detail}` is where the safe argument goes, when there is one. */
interface Template {
  en: string;
  zh: string;
}

/** Longest detail shown; anything past it is not something a person reads at a glance. */
const DETAIL_MAX = 40;

/**
 * Every built-in tool, by the name `buildTools` offers it under. The guard test enumerates
 * the offered tools and fails when one is missing here, so a new tool cannot ship as
 * `Ada → NewTool`.
 */
const TEMPLATES: Record<string, Template> = {
  bash: { en: "running a command ({detail})", zh: "运行命令({detail})" },
  RunOnHost: { en: "running a command on the host ({detail})", zh: "在主机上运行命令({detail})" },
  read_file: { en: "reading {detail}", zh: "读取文件 {detail}" },
  write_file: { en: "writing {detail}", zh: "写入文件 {detail}" },
  edit_file: { en: "editing {detail}", zh: "编辑文件 {detail}" },
  list_dir: { en: "listing a folder ({detail})", zh: "查看目录({detail})" },
  computer: { en: "using the desktop ({detail})", zh: "操作桌面({detail})" },
  HandOverDesktop: { en: "handing the desktop over to you", zh: "把桌面交给你" },
  WaitForControl: { en: "waiting for the desktop back", zh: "等待桌面交还" },
  browser_open: { en: "opening {detail}", zh: "打开网站 {detail}" },
  browser_pages: { en: "switching browser tabs", zh: "切换浏览器标签页" },
  browser_snapshot: { en: "looking at the page", zh: "查看网页" },
  browser_read: { en: "reading the page", zh: "阅读网页" },
  browser_act: { en: "acting on the page ({detail})", zh: "操作网页({detail})" },
  browser_scroll: { en: "scrolling the page", zh: "滚动网页" },
  browser_wait_for: { en: "waiting for the page", zh: "等待网页加载" },
  browser_upload: { en: "uploading {detail} to the page", zh: "向网页上传 {detail}" },
  browser_fill_secret: { en: "filling in a credential on the page", zh: "在网页上填入凭据" },
  NoteSiteLearning: { en: "noting how a website works", zh: "记下网站的使用方法" },
  WebFetch: { en: "fetching {detail}", zh: "抓取网页 {detail}" },
  WebSearch: { en: "searching the web", zh: "搜索网络" },
  ReadFeishuDoc: { en: "reading a Feishu document", zh: "阅读飞书文档" },
  connector_request: { en: "calling {detail}", zh: "调用 {detail}" },
  Fork: { en: "sending out {detail} subtasks", zh: "派出 {detail} 个子任务" },
  Delegate: { en: "handing work to a specialist engine", zh: "把工作交给专用引擎" },
  Jobs: { en: "checking on background jobs", zh: "查看后台任务" },
  AskUser: { en: "asking you a question", zh: "向你提问" },
  AskSecret: { en: "asking you for a credential", zh: "向你请求凭据" },
  Teammates: { en: "looking up teammates", zh: "查看队友" },
  SendToAgent: { en: "messaging a teammate", zh: "给队友发消息" },
  CreateAgent: { en: "creating a teammate", zh: "创建队友" },
  UpdateAgent: { en: "updating a teammate", zh: "更新队友" },
  SetPlan: { en: "writing down the plan", zh: "写下计划" },
  Checkpoint: { en: "saving a checkpoint", zh: "保存进度点" },
  SetTodos: { en: "updating the to-do list ({detail})", zh: "更新待办清单({detail})" },
  ReadHistory: { en: "reading earlier conversation", zh: "回看之前的对话" },
  ReadKept: { en: "reading what it kept", zh: "查看保留的内容" },
  OtherThreads: { en: "checking other threads", zh: "查看其他会话" },
  Recall: { en: "recalling from memory", zh: "回忆记忆" },
  RememberFact: { en: "remembering a fact", zh: "记住一件事" },
  Forget: { en: "forgetting a memory", zh: "忘记一条记忆" },
  ClaimWork: { en: "taking a piece of work", zh: "领取一项工作" },
  Tasks: { en: "checking the task board", zh: "查看任务板" },
  PackTemplate: { en: "packing a template", zh: "打包模板" },
  NothingToSay: { en: "nothing to add", zh: "无需回复" },
};

const GENERIC: Template = { en: "using {detail}", zh: "使用 {detail}" };

/** The tools this table knows, for the guard that checks every offered tool is one of them. */
export function phrasedTools(): string[] {
  return Object.keys(TEMPLATES);
}

export function hasPhraseTemplate(tool: string): boolean {
  return Object.hasOwn(TEMPLATES, tool);
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function clamp(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/** The program a command line starts with — `python`, never `python batch.py --key …`. */
function programOf(command: string): string | undefined {
  // Skip leading `VAR=value` assignments and `sudo`/`env`, which are not the program.
  const tokens = command.trim().split(/\s+/);
  for (const token of tokens) {
    if (token === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token === "sudo" || token === "env") continue;
    const program = posix.basename(token.replace(/^["']|["']$/g, ""));
    return program === "" ? undefined : program;
  }
  return undefined;
}

/** The host of a URL and nothing else — no path, no query, no credentials, no port. */
function hostnameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "" ? undefined : parsed.hostname;
  } catch {
    return undefined;
  }
}

/**
 * The one argument of a call that is safe to show, or undefined when nothing is.
 *
 * Exported for the tests that pin what must *not* come out of here: a command line, a
 * directory, a URL's path or query.
 */
export function safeDetailOf(tool: string, input: unknown): string | undefined {
  const record = asRecord(input);
  switch (tool) {
    case "bash":
    case "RunOnHost": {
      const command = stringAt(record, "command");
      return command === undefined ? undefined : programOf(command);
    }
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_dir":
    case "browser_upload": {
      const path = stringAt(record, "path");
      if (path === undefined) return undefined;
      const name = basename(path);
      return name === "" ? undefined : clamp(name);
    }
    case "browser_open":
    case "WebFetch": {
      const url = stringAt(record, "url");
      return url === undefined ? undefined : hostnameOf(url);
    }
    case "browser_act": {
      const action = stringAt(record, "action");
      return action === undefined ? undefined : clamp(action);
    }
    case "computer": {
      const actions = Array.isArray(record.actions) ? record.actions : [];
      const kinds = actions
        .map(entry => stringAt(asRecord(entry), "action"))
        .filter((kind): kind is string => kind !== undefined);
      return kinds.length === 0 ? undefined : clamp([...new Set(kinds)].join(", "));
    }
    case "Fork": {
      const briefs = Array.isArray(record.briefs) ? record.briefs.length : 0;
      return String(Math.max(briefs, 1));
    }
    case "SetTodos": {
      const items = Array.isArray(record.items) ? record.items.length : undefined;
      return items === undefined ? undefined : String(items);
    }
    case "connector_request": {
      const connector = stringAt(record, "connector");
      const method = stringAt(record, "method");
      if (connector === undefined) return undefined;
      return clamp(method === undefined ? connector : `${connector} ${method.toUpperCase()}`);
    }
    default:
      return undefined;
  }
}

/** `linear__create_issue` reads as `create_issue on linear`; a plain unknown name is itself. */
function displayNameOf(tool: string, locale: Locale): string {
  const at = tool.indexOf(MCP_SEPARATOR);
  if (at > 0) {
    const server = tool.slice(0, at);
    const name = tool.slice(at + MCP_SEPARATOR.length);
    return locale === "zh" ? `${server} 的 ${name}` : `${name} on ${server}`;
  }
  return tool;
}

/** Drop the `({detail})` or ` {detail}` slot cleanly when there is nothing to put in it. */
function fill(template: string, detail: string | undefined): string {
  if (detail !== undefined) return template.replace("{detail}", detail);
  return template
    .replace(/\s*[（(]\{detail\}[)）]/, "")
    .replace(/\s*\{detail\}/, "")
    .trim();
}

/** The phrase for one tool call, in one language. */
export function activityPhrase(tool: string, input: unknown, locale: Locale): string {
  const template = TEMPLATES[tool];
  if (template === undefined) return fill(GENERIC[locale], displayNameOf(tool, locale));
  return fill(template[locale], safeDetailOf(tool, input));
}

/** Both languages at once, for an event that is stored before anyone's language is known. */
export function activityPhrases(tool: string, input: unknown): { en: string; zh: string } {
  return { en: activityPhrase(tool, input, "en"), zh: activityPhrase(tool, input, "zh") };
}
