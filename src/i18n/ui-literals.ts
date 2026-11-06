/**
 * Finds the words a person would read that the web UI still writes into its source (INV-1684).
 *
 * The page is one template literal of markup and inline script (`web/app-html.ts`), and each
 * section beside it is a template of script (`web/*-ui.ts`). Their words go through the bundle:
 * `{{ui.key}}` in the template, filled per language when the page is served (`web/page-locale.ts`),
 * or `t("ui.key", vars)` in the script when a sentence has blanks. What this file finds is
 * everything else: a text node, a `title`/`placeholder`/`aria-label`, or a string literal in the
 * script that reads as prose rather than as a class name, an id, an event or a comparison.
 *
 * It is a heuristic and says so. It reads tokens, not a syntax tree, and decides "prose" from the
 * shape of the string and from where it sits: compared, used as a key, passed to `$()` or
 * `fetch()`, or assigned to `className` is code; shown by `textContent`, `toast()`, `confirm()`
 * or `new Error()` is prose whatever it looks like. A false alarm is fixed by putting the string
 * in the bundle, which is where it belonged if a person can see it; a word that is the same in
 * both languages (a product name) is in `SAME_IN_BOTH`.
 *
 * `architecture-guard.test.ts` runs it over every UI source and fails on any finding.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A template literal in a source file: where its raw text starts, and what it is. */
export interface UiTemplate {
  name: string;
  /** Offset of the first character after the opening backtick. */
  start: number;
  raw: string;
  /** `String.raw` ships the raw text; a plain template ships it cooked (`\\` → `\`). */
  rawTag: boolean;
  /** A page has markup with `<script>` regions; a script is JavaScript throughout. */
  kind: "page" | "script";
}

export interface UiLiteral {
  /** Offsets into the source file, for a report and for a rewrite. */
  start: number;
  end: number;
  /** What a person reads: entities and escapes decoded, outer whitespace trimmed. */
  text: string;
  where: "text" | "attr" | "script";
  /** Inside a script string that also carries markup, so the bundle's words land in HTML. */
  html: boolean;
}

/** Names and marks that read the same in Chinese and in English. */
export const SAME_IN_BOTH = new Set([
  "LumenBox", "Docker", "Docker Desktop", "OrbStack", "Telegram", "MCP", "API", "URL", "JSON", "Markdown", "SSH",
  "VNC", "noVNC", "CPU", "GPU", "RAM", "GB", "MB", "KB", "TB", "ms", "px", "GitHub", "Kubernetes", "Linux", "macOS",
  "Windows", "Chrome", "Electron", "Keenable", "Brave", "Tavily", "Anthropic", "OpenAI", "Claude", "Codex", "Grok", "xAI",
  "DeepSeek", "MiniMax", "Kimi", "Moonshot", "Qwen", "GLM", "Zhipu", "OpenRouter", "Ollama", "Gemini", "Google", "Jev",
  "Tailscale", "WebSearch", "ID", "IDs", "PR", "CLI", "HTTP", "HTTPS", "OAuth", "SSO", "Esc", "Ctrl", "Cmd", "Shift", "Alt",
  "Enter", "Tab", "git", "pi", "claude", "AM", "PM", "MiB", "KiB", "GiB", "UTC", "LLM", "LumenOpen", "Involute", "cron", "md", "txt", "csv", "pdf", "png", "zip",
  "agentbox", "lumenbox", "localhost", "agentbox-box", "skill", "skills", "box", "boxes", "agent", "agents", "A2UI", "OK",
]);

/** Calls whose string arguments are code: selectors, routes, events, storage keys, patterns. */
const CODE_CALLS = new Set([
  "$", "querySelector", "querySelectorAll", "getElementById", "getElementsByClassName", "getElementsByTagName",
  "addEventListener", "removeEventListener", "fetch", "api", "getItem", "setItem", "removeItem", "add", "remove",
  "toggle", "contains", "getAttribute", "removeAttribute", "hasAttribute", "createElement", "closest", "matches",
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf", "split", "join", "replace", "replaceAll", "test",
  "match", "RegExp", "postMessage", "dispatchEvent", "Event", "CustomEvent", "parse", "localeCompare",
  "encodeURIComponent", "decodeURIComponent", "send", "hasOwnProperty", "insertAdjacentHTML", "padStart", "padEnd",
  "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "Intl", "DateTimeFormat", "NumberFormat",
  "execCommand", "focus", "scrollIntoView", "get", "has", "delete", "set", "postJson", "getJson", "post", "put", "del",
  "WebSocket", "EventSource", "URL", "URLSearchParams", "append", "open", "importScripts", "require", "assign",
  "setProperty", "getPropertyValue", "trace", "log", "warn", "error", "debug", "info", "keys", "escape", "Blob",
  "createObjectURL", "download", "attr", "data", "on", "off", "once", "emit", "subscribe", "watch", "load", "listen",
  "svg", "icon", "dot", "kind", "badge", "t", "tr", "matchMedia", "showTab", "openSettings", "savePreference", "openTaskCard",
]);

/** Calls with some arguments that are ids or classes and others that may be prose: which are code. */
const CODE_ARGS: Record<string, number[]> = { showCard: [0], settleCard: [0], dropCard: [0], feed: [1, 2], askInline: [0, 2, 3], shelfCard: [2] };

/** Calls whose string arguments are what somebody reads. */
const PROSE_CALLS = new Set(["plural", "toast", "alert", "confirm", "prompt", "Error", "flashButton", "notice", "say", "setStatus", "status", "hint", "note", "tip"]);

/** Properties that hold code when assigned or written as an object key. */
const CODE_PROPS = new Set([
  "className", "id", "type", "href", "src", "cssText", "display", "method", "name", "key", "hash", "search", "pathname",
  "cursor", "background", "color", "width", "height", "overflow", "mode", "accept", "autocomplete", "rel", "target",
  "htmlFor", "role", "tabIndex", "dir", "lang", "theme", "kind", "state", "status", "tier", "headers", "credentials",
  "cache", "redirect", "body", "action", "event", "tag", "icon", "slug", "ref", "value", "level", "phase", "scope",
  "provider", "model", "path", "file", "url", "route", "format", "align", "position", "size", "rows", "cols", "step",
  "min", "max", "pattern", "cls", "class", "style", "for", "data", "inputMode", "spellcheck", "wrap", "sort", "order", "field", "point", "tone", "variant",
]);

/** Properties whose value somebody reads. */
const PROSE_PROPS = new Set(["textContent", "innerText", "title", "placeholder", "innerHTML", "outerHTML", "label", "text", "hint", "help", "about", "summary", "message", "ariaLabel", "alt", "head", "sub", "act", "caption", "heading", "description", "detail", "note", "tip", "word", "words", "say", "prompt", "question", "empty", "noun"]);

/** Attributes whose value somebody reads. */
const PROSE_ATTRS = /\b(title|placeholder|aria-label|alt)\s*=\s*"([^"]*)("?)/g;

const HAS_LETTERS = /[A-Za-z]{2,}|[㐀-鿿]/;
const CJK = /[㐀-鿿]/;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  middot: "·", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓", bull: "•",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", deg: "°", check: "✓",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The escapes of a JavaScript string body, decoded. */
export function decodeJs(body: string): string {
  return body.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|[\s\S])/gi, (_whole, esc: string) => {
    if (esc[0] === "u" && esc[1] === "{") return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
    if ((esc[0] === "u" || esc[0] === "x") && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[esc] ?? esc;
  });
}

/** Every exported template literal in a source file. */
export function templatesIn(source: string): UiTemplate[] {
  const out: UiTemplate[] = [];
  const head = /export const (\w+)\s*=\s*(String\.raw)?`/g;
  for (let match = head.exec(source); match; match = head.exec(source)) {
    const start = match.index + match[0].length;
    const end = closingBacktick(source, start);
    const name = match[1]!;
    out.push({ name, start, raw: source.slice(start, end), rawTag: match[2] !== undefined, kind: /HTML$/.test(name) ? "page" : "script" });
    head.lastIndex = end + 1;
  }
  return out;
}

function closingBacktick(source: string, from: number): number {
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") return i;
    if (c === "$" && source[i + 1] === "{") i = closingBrace(source, i + 2);
  }
  throw new Error("an unterminated template literal");
}

function closingBrace(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === "`") i = closingBacktick(source, i + 1);
    else if (c === "'" || c === '"') { for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++; }
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error("an unterminated template interpolation");
}

/**
 * What the browser receives, with a map back to the raw text: `${...}` becomes underscores (not
 * prose, not a token boundary) and a plain template's escapes are cooked.
 */
function shipped(template: UiTemplate): { text: string; at: number[] } {
  const { raw } = template;
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      const end = closingBrace(raw, i + 2);
      for (let j = i; j <= end; j++) { text += "_"; at.push(j); }
      i = end;
      continue;
    }
    if (!template.rawTag && raw[i] === "\\") {
      const next = raw[i + 1] ?? "";
      const unicode = /^u[0-9a-fA-F]{4}/.exec(raw.slice(i + 1, i + 6));
      if (unicode) { text += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)); at.push(i); i += 5; continue; }
      text += next === "n" ? "\n" : next === "t" ? "\t" : next;
      at.push(i);
      i++;
      continue;
    }
    text += raw[i];
    at.push(i);
  }
  at.push(raw.length);
  return { text, at };
}

/** The literals in one template, as offsets into the source file. */
export function literalsIn(template: UiTemplate, cssClasses: ReadonlySet<string> = new Set()): UiLiteral[] {
  const { text, at } = shipped(template);
  const toSource = (i: number) => template.start + at[i]!;
  const found: { start: number; end: number; text: string; where: UiLiteral["where"]; html: boolean }[] = [];
  const add: Add = (start, end, decode, where, html) => {
    const slice = text.slice(start, end);
    const trimmed = slice.trim();
    if (trimmed === "") return;
    const lead = slice.length - slice.trimStart().length;
    found.push({ start: start + lead, end: start + lead + trimmed.length, text: decode(trimmed), where, html });
  };
  const regions = template.kind === "script" ? [{ from: 0, to: text.length, script: true }] : pageRegions(text);
  for (const region of regions) {
    if (region.script) scanScript(text, region.from, region.to, cssClasses, add);
    else scanMarkup(text, region.from, region.to, add);
  }
  return found
    .filter(item => isProse(item.text))
    .map(item => ({ ...item, start: toSource(item.start), end: toSource(item.end) }));
}

function isProse(raw: string): boolean {
  const text = raw.replace(/\{\{[^}]*\}\}/g, " ").replace(/_{3,}/g, " ");
  if (!HAS_LETTERS.test(text)) return false;
  if (CJK.test(text)) return true;
  const words = text.match(/[A-Za-z][A-Za-z'’.-]*[A-Za-z]|[A-Za-z]{2,}/g) ?? [];
  const rest = words.filter(word => !SAME_IN_BOTH.has(word) && !SAME_IN_BOTH.has(word.replace(/[.'’]+$/, "")) && !/^[A-Z0-9_]+$|_|^\w+\.(md|json|ts|js|txt|sh)$/.test(word));
  if (SAME_IN_BOTH.has(text.trim()) || text.trim() === "use strict") return false;
  return rest.length > 0;
}

/** Markup between scripts and styles; `<script>` bodies are scanned as script. */
function pageRegions(text: string): { from: number; to: number; script: boolean }[] {
  const out: { from: number; to: number; script: boolean }[] = [];
  const tag = /<(script|style)\b[^>]*>|<!--/gi;
  let from = 0;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    out.push({ from, to: match.index, script: false });
    const open = match.index + match[0].length;
    if (match[0] === "<!--") {
      const close = text.indexOf("-->", open);
      from = close < 0 ? text.length : close + 3;
    } else {
      const closer = new RegExp(`</${match[1]}>`, "i");
      const rel = text.slice(open).search(closer);
      const close = rel < 0 ? text.length : open + rel;
      if (match[1]!.toLowerCase() === "script" && !/\bsrc=/.test(match[0])) out.push({ from: open, to: close, script: true });
      from = close;
    }
    tag.lastIndex = from;
  }
  out.push({ from, to: text.length, script: false });
  return out;
}

type Add = (start: number, end: number, decode: (raw: string) => string, where: UiLiteral["where"], html: boolean) => void;
const fromScript = (raw: string) => decodeEntities(decodeJs(raw));

function scanMarkup(text: string, from: number, to: number, add: Add): void {
  const piece = /<[^>]*>|[^<]+/g;
  const body = text.slice(from, to);
  for (let match = piece.exec(body); match; match = piece.exec(body)) {
    const at = from + match.index;
    if (match[0][0] === "<") {
      for (const attr of match[0].matchAll(PROSE_ATTRS)) {
        const valueAt = at + attr.index! + attr[0].length - attr[2]!.length - attr[3]!.length;
        add(valueAt, valueAt + attr[2]!.length, decodeEntities, "attr", true);
      }
    } else {
      add(at, at + match[0].length, decodeEntities, "text", true);
    }
  }
}

interface Token { kind: "string" | "word" | "punct" | "number" | "regex"; text: string; start: number; end: number }

/** JavaScript tokens: enough to find string literals and what sits around them. */
export function tokenize(text: string, from = 0, to = text.length): Token[] {
  const tokens: Token[] = [];
  const regexMayFollow = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === "word") return /^(return|typeof|case|in|of|new|delete|void|throw|instanceof|do|else)$/.test(last.text);
    if (last.kind === "punct") return !/^[)\]}]$/.test(last.text);
    return false;
  };
  for (let i = from; i < to; ) {
    const c = text[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < to && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? to : end + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < to && text[j] !== c) { if (text[j] === "\\") j++; j++; }
      tokens.push({ kind: "string", text: text.slice(i, j + 1), start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === "/" && regexMayFollow()) {
      let j = i + 1;
      let inClass = false;
      while (j < to && (text[j] !== "/" || inClass) && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j++;
      }
      j++;
      while (j < to && /[a-z]/i.test(text[j]!)) j++;
      tokens.push({ kind: "regex", text: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i, i + 200));
    if (word) { tokens.push({ kind: "word", text: word[0], start: i, end: i + word[0].length }); i += word[0].length; continue; }
    const number = /^\d[\w.]*/.exec(text.slice(i, i + 50));
    if (number) { tokens.push({ kind: "number", text: number[0], start: i, end: i + number[0].length }); i += number[0].length; continue; }
    const punct = /^(===|!==|\.\.\.|=>|==|!=|<=|>=|&&|\|\||\?\?|\+=|-=|\*=|\/=|\+\+|--|\?\.|[^\s\w])/.exec(text.slice(i, i + 3))!;
    tokens.push({ kind: "punct", text: punct[0], start: i, end: i + punct[0].length });
    i += punct[0].length;
  }
  return tokens;
}

const COMPARE = new Set(["===", "!==", "==", "!=", "in", "instanceof", "<", ">", "<=", ">="]);
const TRANSPARENT = new Set(["+", "?", ":", "&&", "||", "??", "!", ","]);

/** Where a string literal sits: code it feeds, prose somebody reads, or neither. */
export function contextOf(tokens: Token[], index: number): "code" | "prose" | "plain" {
  const next = tokens[index + 1];
  const prev = tokens[index - 1];
  if (next && COMPARE.has(next.text)) return "code";
  if (prev && (COMPARE.has(prev.text) || prev.text === "case")) return "code";
  if (next?.text === ":" && (prev?.text === "{" || prev?.text === ",")) return "code";
  if (prev?.text === "[" && next?.text === "]" && /^[\w$)\]]/.test(tokens[index - 2]?.text ?? "")) return "code";
  let depth = 0;
  let key: string | undefined;
  let argument = 0;
  let inBranch = false;
  let sawComma = false;
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    const t = token.text;
    if (token.kind === "punct" && (t === ")" || t === "]" || t === "}")) { depth++; continue; }
    if (token.kind === "punct" && (t === "(" || t === "[" || t === "{")) {
      if (depth > 0) { depth--; continue; }
      if (t === "{") {
        if (key === undefined) return "plain";
        if (PROSE_PROPS.has(key)) return "prose";
        return CODE_PROPS.has(key) || /^data-|^on[A-Z]|Class$|Id$|Key$|Url$|Type$/.test(key) ? "code" : "plain";
      }
      if (t === "[") {
        if (/^[\w$)\]]/.test(tokens[i - 1]?.text ?? "") && tokens[i - 1]?.kind !== "punct" || /^[)\]]$/.test(tokens[i - 1]?.text ?? "")) return "code";
        key = undefined;
        continue;
      }
      const callee = tokens[i - 1];
      if (callee?.kind === "word" && !/^(if|while|for|switch|return|function|catch|with|typeof)$/.test(callee.text)) {
        if (callee.text === "setAttribute") {
          if (argument === 0) return "code";
          const name = tokens[i + 1]?.kind === "string" ? decodeJs(tokens[i + 1]!.text.slice(1, -1)) : "";
          return /^(title|placeholder|aria-label|alt)$/.test(name) ? "prose" : "code";
        }
        if (Object.hasOwn(CODE_ARGS, callee.text) && CODE_ARGS[callee.text]!.includes(argument)) return "code";
        if (callee.text === "el" || callee.text === "h") return argument === 0 ? "code" : argument >= 2 ? "prose" : "plain";
        if (PROSE_CALLS.has(callee.text)) return "prose";
        if (CODE_CALLS.has(callee.text)) return "code";
        return "plain";
      }
      if (callee && (callee.text === "if" || callee.text === "while" || callee.text === "switch")) return "code";
      key = undefined;
      continue;
    }
    if (depth > 0) continue;
    if (token.kind === "punct" && t === ",") {
      argument++;
      sawComma = true;
      continue;
    }
    if (token.kind === "punct" && t === ":") {
      // The first colon is this value's own: its key, or a ternary's (which a "?" further back clears).
      const before = tokens[i - 1];
      if (key === undefined && !sawComma && before && (before.kind === "word" || before.kind === "string")) key = before.kind === "string" ? decodeJs(before.text.slice(1, -1)) : before.text;
      continue;
    }
    if (token.kind === "punct" && (t === "=" || t === "+=")) {
      const target = tokens[i - 1];
      const owner = tokens[i - 3];
      if (owner?.text === "style" || owner?.text === "dataset") return "code";
      if (target?.kind !== "word") return "plain";
      if (PROSE_PROPS.has(target.text)) return "prose";
      if (CODE_PROPS.has(target.text) || /Class$|Id$|Key$|Url$|Selector$/.test(target.text)) return "code";
      return "plain";
    }
    if (token.kind === "punct" && t === "?") { inBranch = true; if (!sawComma) key = undefined; continue; }
    if (token.kind === "punct" && TRANSPARENT.has(t)) continue;
    if (token.kind === "punct" && COMPARE.has(t)) { if (inBranch) continue; return "code"; }
    if (token.kind === "punct" && (t === ";" || t === "=>")) return "plain";
    if (token.kind === "word" && /^(return|case|throw|var|let|const|else|do)$/.test(t)) return t === "case" ? "code" : "plain";
  }
  return "plain";
}

function scanScript(text: string, from: number, to: number, cssClasses: ReadonlySet<string>, add: Add): void {
  const tokens = tokenize(text, from, to);
  tokens.forEach((token, index) => {
    if (token.kind !== "string") return;
    const context = contextOf(tokens, index);
    if (context === "code") return;
    const bodyStart = token.start + 1;
    const body = text.slice(bodyStart, token.end - 1);
    const hasMarkup = /<\/?[a-zA-Z!]|^[^<]*>/.test(body);
    if (!hasMarkup) {
      if (/="?\s*$|^\s*"?\s*[\w-]+="|^"\s*$/.test(decodeJs(body))) return;
      if (context === "plain" && looksLikeCode(decodeJs(body), cssClasses)) return;
      add(bodyStart, bodyStart + body.length, fromScript, "script", false);
      return;
    }
    for (const part of markupParts(body)) {
      add(bodyStart + part.start, bodyStart + part.end, fromScript, "script", true);
    }
  });
}

/** The visible stretches of a string that carries markup: text between tags, prose attributes. */
function markupParts(body: string): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  const firstOpen = body.indexOf("<");
  const firstClose = body.indexOf(">");
  let i = 0;
  let inTag = firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen);
  let tagStart = 0;
  let textStart = 0;
  const tagParts = (start: number, end: number) => {
    const tag = body.slice(start, end);
    for (const attr of tag.matchAll(PROSE_ATTRS)) {
      const valueAt = start + attr.index! + attr[0].length - attr[2]!.length - attr[3]!.length;
      parts.push({ start: valueAt, end: valueAt + attr[2]!.length });
    }
  };
  for (; i < body.length; i++) {
    const c = body[i];
    if (!inTag && c === "<" && /[a-zA-Z/!]/.test(body[i + 1] ?? "")) {
      if (i > textStart) parts.push({ start: textStart, end: i });
      inTag = true;
      tagStart = i;
    } else if (inTag && c === ">") {
      tagParts(tagStart, i);
      inTag = false;
      textStart = i + 1;
    }
  }
  if (inTag) tagParts(tagStart, body.length);
  else if (body.length > textStart) parts.push({ start: textStart, end: body.length });
  return parts.filter(part => {
    const value = body.slice(part.start, part.end);
    return !/^\s*[\w-]+="?\s*$/.test(value) && !/^[^\s]*="?$/.test(value.trim()) && !/[{;]/.test(value);
  });
}

/** A string with no markup that is still code: a class list, a route, a style, an identifier. */
function looksLikeCode(value: string, cssClasses: ReadonlySet<string>): boolean {
  const text = value.trim();
  if (CJK.test(text)) return false;
  if (/[{};=<>\\]|^[#./@[]|:\/\/|^\w+:\w|\b\d+px\b|^[\w-]+\(|\$\{/.test(text)) return true;
  if (/^[a-z-]+:$/.test(text) || /^(selected|disabled|checked|open|hidden|readonly|multiple|required|autofocus)$/.test(text)) return true;
  if (/^[a-z0-9_$-]+$/.test(text)) return !(value !== text && /^[a-z]{2,}$/.test(text) && !cssClasses.has(text));
  if (/^[a-z]+\/[\w.+-]+$/.test(text)) return true;
  if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(text)) return true;
  if (/^[A-Z0-9_]+$/.test(text)) return true;
  if (/^[\w.-]+\.[a-z]{2,4}$/.test(text)) return true;
  const words = text.split(/\s+/);
  if (words.every(word => cssClasses.has(word) || /^[a-z]+-[a-z-]+$/.test(word))) return true;
  if (/^(?:[a-z-]+:\s*[^;]+;?\s*)+$/.test(text)) return true;
  return false;
}

/** Every class name a stylesheet in the page defines, so a class list is not mistaken for words. */
export function cssClassesIn(...sheets: string[]): Set<string> {
  const out = new Set<string>();
  for (const sheet of sheets) for (const match of sheet.matchAll(/\.([a-zA-Z][\w-]*)/g)) out.add(match[1]!);
  return out;
}

/** Every source file of the web UI the guard reads: the page, the Settings dialog, the sections beside it. */
export function uiSources(webDir = join(import.meta.dirname, "..", "web")): { path: string; text: string }[] {
  return readdirSync(webDir)
    .filter(name => /^(app-html|settings-dialog-html|supervision-wizard|jev-settings|inline-ask)\.ts$|-ui\.ts$/.test(name))
    .sort()
    .map(name => ({ path: `src/web/${name}`, text: readFileSync(join(webDir, name), "utf8") }));
}

/** The class names the page's stylesheets define, so a class list is not taken for words. */
export function uiCssClasses(webDir = join(import.meta.dirname, "..", "web")): Set<string> {
  const sheets = (text: string) => [...text.matchAll(/<style>([\s\S]*?)<\/style>|export const UI_CSS = `([\s\S]*?)`;/g)].map(match => match[1] ?? match[2] ?? "");
  return cssClassesIn(...sheets(readFileSync(join(webDir, "app-html.ts"), "utf8")), ...sheets(readFileSync(join(webDir, "ui-style.ts"), "utf8")));
}

/** The literals in one source file, with their line numbers, for a report. */
export function uiLiteralsOf(path: string, source: string, cssClasses?: ReadonlySet<string>): (UiLiteral & { path: string; line: number })[] {
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  return templatesIn(source)
    .filter(template => !/CSS$/.test(template.name))
    .flatMap(template => literalsIn(template, cssClasses))
    .map(literal => ({ ...literal, path, line: lineOf(literal.start) }));
}
