/**
 * The page in the language its reader reads (INV-1684).
 *
 * Every word of the web UI is a key in the bundle (`src/i18n/messages.ts`); the templates carry
 * `{{ui.key}}` where the word goes. They are filled here, once per language, when the page or a
 * section's script is served — so the browser receives finished text, the first paint is already
 * in the right language, and an English page is the page as it was written.
 *
 * Filling depends on where the key sits, which this file tells from the markup: in markup the
 * words are HTML-escaped; inside a `<script>` (or a section's script) they land inside a string
 * literal, so they are escaped for JavaScript. A string that the script then hands to `innerHTML`
 * is HTML again; the bundle test refuses `<`, `>` and `&` in the page's words, so both readings
 * agree.
 *
 * Three names are not words: `{{@lang}}` (the `lang` attribute), `{{@locale}}` (the bundle's
 * language, for the script) and `{{@messages}}` (the page's messages as JSON, for `t()`, which
 * fills a sentence with blanks at run time).
 *
 * Which language: what the person chose (the `lumen-lang` cookie, or `?lang=` for one load),
 * then what their browser asks for, then the installation's default — `resolveLocale`'s order.
 */

import type { IncomingMessage } from "node:http";
import { resolveLocale, type Locale } from "../i18n/locale.ts";
import { MESSAGES, tr } from "../i18n/messages.ts";
import { APP_HTML, LOGIN_HTML } from "./app-html.ts";
import { NEXT_HTML } from "./next-page-ui.ts";

const MARKER = /\{\{(@?[\w.-]+)\}\}/g;

export const LANG_COOKIE = "lumen-lang";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeJs(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\x22")
    .replace(/'/g, "\\x27")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/</g, "\\x3c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The page's messages, for `t()`: every `ui.*` key, as a JSON object safe inside a script. */
function pageMessages(locale: Locale): string {
  const out: Record<string, string> = {};
  for (const key of Object.keys(MESSAGES[locale])) if (key.startsWith("ui.")) out[key] = tr(key, locale);
  return JSON.stringify(out).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function fill(name: string, locale: Locale, inScript: boolean): string {
  if (name === "@lang") return locale === "zh" ? "zh-CN" : "en";
  if (name === "@locale") return locale;
  if (name === "@messages") return pageMessages(locale);
  if (!(name in MESSAGES[locale])) throw new Error(`the page names {{${name}}}, which the bundle does not have`);
  const text = tr(name, locale);
  return inScript ? escapeJs(text) : escapeHtml(text);
}

/** A page template, filled: markup escaped as HTML, inline scripts as JavaScript. */
export function localizePage(template: string, locale: Locale): string {
  const script = /(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi;
  let out = "";
  let from = 0;
  for (let match = script.exec(template); match; match = script.exec(template)) {
    out += template.slice(from, match.index).replace(MARKER, (_whole, name: string) => fill(name, locale, false));
    out += match[1] + localizeScript(match[2]!, locale) + match[3];
    from = match.index + match[0].length;
  }
  return out + template.slice(from).replace(MARKER, (_whole, name: string) => fill(name, locale, false));
}

/** A script template, filled: every key lands inside a string literal. */
export function localizeScript(template: string, locale: Locale): string {
  return template.replace(MARKER, (_whole, name: string) => fill(name, locale, true));
}

/** Every key a template names, for the test that each one is in the bundle. */
export function keysIn(template: string): string[] {
  return [...template.matchAll(MARKER)].map(match => match[1]!).filter(name => !name.startsWith("@"));
}

/**
 * One template, filled once per language and kept: the page is a few hundred kilobytes, and
 * filling it on every load would be work done twice for the same answer.
 */
export function localized(template: string, kind: "page" | "script"): (locale: Locale) => string {
  const cache = new Map<Locale, string>();
  return locale => {
    let text = cache.get(locale);
    if (text === undefined) {
      text = kind === "page" ? localizePage(template, locale) : localizeScript(template, locale);
      cache.set(locale, text);
    }
    return text;
  };
}

/** The workshop and the sign-in page, each filled once per language. */
export const APP_PAGE = localized(APP_HTML, "page");
/** The rebuilt page (INV-1825): the same data, reached with `?ui=next` until it is the default. */
export const NEXT_PAGE = localized(NEXT_HTML, "page");
export const LOGIN_PAGE = localized(LOGIN_HTML, "page");

/** The language of one request to the web server. */
export function localeOf(req: IncomingMessage, url: URL): Locale {
  const acceptLanguage = req.headers["accept-language"];
  return requestLocale({
    lang: url.searchParams.get("lang"),
    ...(typeof req.headers.cookie === "string" ? { cookie: req.headers.cookie } : {}),
    ...(typeof acceptLanguage === "string" ? { acceptLanguage } : {}),
  });
}

/** The language of a request whose URL is not parsed yet: a refusal or a page sent from deep in a route (INV-1686). */
export function requestLocaleOf(req: IncomingMessage | undefined): Locale {
  return req === undefined ? requestLocale({}) : localeOf(req, new URL(req.url ?? "/", "http://localhost"));
}

/** The language for one request: `?lang=`, then the `lumen-lang` cookie, then the browser, then the default. */
export function requestLocale(input: { lang?: string | null; cookie?: string; acceptLanguage?: string; installationDefault?: string }): Locale {
  const cookie = new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=(\\w+)`).exec(input.cookie ?? "")?.[1];
  const chosen = input.lang ?? cookie;
  return resolveLocale({
    ...(chosen ? { preference: chosen } : {}),
    ...(input.acceptLanguage ? { acceptLanguage: input.acceptLanguage } : {}),
    ...(input.installationDefault ? { installationDefault: input.installationDefault } : {}),
  });
}
