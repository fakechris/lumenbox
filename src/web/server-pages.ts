/**
 * The pages the web server answers with itself, in the reader's language (INV-1686): the first
 * Admin's sign-in, a sign-in this installation does not know, a connector's return, and a
 * desktop frame before noVNC answers. Each is small enough to be one function; the words are
 * in `src/i18n/server-words.ts`, the language is the request's (`requestLocaleOf`).
 */

import type { Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const lang = (locale: Locale): string => (locale === "zh" ? "zh-CN" : "en");

export function signInRecoveryPage(
  reason: "sign-in-required" | "access-removed" | "session-expired" | "sign-in-expired" | "bootstrap-unavailable",
  locale: Locale,
  { setup = false, orgView = false } = {},
): string {
  const say = (key: string) => escapeHtml(tr(key, locale));
  const title = say(`page.recovery.${reason}`);
  const action = orgView ? say("page.recovery.desktop") : `<a href="/login">${say("page.recovery.login")}</a>`;
  return `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<body style="font:16px system-ui;max-width:600px;margin:80px auto;padding:20px"><h1>${title}</h1><p>${say("page.recovery.contact")}</p>` +
    `<p>${action}</p>${setup ? `<p><a href="/bootstrap">${say("page.bootstrap.title")}</a></p>` : ""}</body></html>`;
}

/** A channel that could sign the first Admin in once its app is in the server's environment. */
export interface DoorToSet { id: string; type: "feishu" | "dingtalk"; keys: { id: string; secret: string }; callback?: string }

/**
 * GET /bootstrap: the one-use code, and one button per channel that can sign in now, named by its
 * type. Off the local level the operator cannot open a page with the installation token (R2,
 * docs/106 §5), so nothing here sends them to one: a channel's app comes from the server's
 * environment (docs/109 §2 step o), and with none set the page says which variables, and which
 * callback address to register with the vendor. At the local level the token still opens the
 * settings, and the steps say so as they always have.
 */
export function bootstrapPage(page: {
  doors: readonly { id: string; name: string; type: "feishu" | "dingtalk" }[]; toSet: readonly DoorToSet[];
  local: boolean; locale: Locale; codePath: string; callbackTemplate?: string;
}): string {
  const { doors, locale } = page;
  const say = (key: string) => escapeHtml(tr(key, locale));
  const code = `<code>${escapeHtml(page.codePath)}</code>`;
  const label = (door: (typeof doors)[number]) =>
    say(`page.bootstrap.with-${door.type}`) + (doors.filter(other => other.type === door.type).length > 1 ? ` (${escapeHtml(door.name)})` : "");
  const buttons = doors.map(door => `<button name="door" value="${escapeHtml(door.id)}">${label(door)}</button>`).join(" ");
  const form = `<form id="bootstrap"><label>${say("page.bootstrap.code")} <input id="code" type="password" autocomplete="off" maxlength="128" required></label> ${buttons}</form>`;
  const toSet = page.toSet.map(door => `<li>${say(`page.bootstrap.set-${door.type}`)} <code>${escapeHtml(door.keys.id)}</code>, <code>${escapeHtml(door.keys.secret)}</code>` +
    `${say("page.bootstrap.set-callback")}<code>${escapeHtml(door.callback ?? "")}</code></li>`).join("");
  const steps = page.local
    ? `<ol><li><a href="/?ui=next&amp;once=1&amp;view=settings&amp;pane=doors">${say("page.bootstrap.operator")}</a> ${say("page.bootstrap.operator-how")}</li>
<li>${say("page.bootstrap.configure")}</li><li>${say("page.bootstrap.register")} ${page.callbackTemplate ? `<code>${escapeHtml(page.callbackTemplate)}</code>` : say("page.bootstrap.public-url")}</li>
<li>${say("page.bootstrap.scan")} ${code}.</li></ol>`
    : doors.length > 0
      ? `<p>${say("page.bootstrap.enter")} ${code}</p>`
      : `<p>${say("page.bootstrap.none")}</p><ul>${toSet}</ul><p>${say("page.bootstrap.then")} ${code}</p>`;
  const body = page.local || doors.length > 0
    ? `${steps}${form}<p id="status">${doors.length ? say("page.bootstrap.expires") : say("page.bootstrap.no-channel")}</p>`
    : steps;
  const script = doors.length === 0 ? "" : "<script>document.getElementById('bootstrap').onsubmit=async function(event){event.preventDefault();" +
    "var buttons=this.querySelectorAll('button'),door=(event.submitter||buttons[0]).value,status=document.getElementById('status');" +
    "buttons.forEach(function(b){b.disabled=true;});try{var response=await fetch('/auth/'+encodeURIComponent(door),{method:'POST'," +
    "headers:{'content-type':'application/json'},body:JSON.stringify({bootstrapCode:document.getElementById('code').value})});" +
    "var data=await response.json();if(!response.ok)throw new Error(data.error);document.getElementById('code').value='';location.assign(data.url);}" +
    "catch(error){status.textContent=error.message;buttons.forEach(function(b){b.disabled=false;});}};</script>";
  return `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${say("page.bootstrap.title")}</title>` +
    `<body style="font:16px/1.7 system-ui;max-width:680px;margin:80px auto;padding:20px"><h1>${say("page.bootstrap.title")}</h1>${body}${script}</body></html>`;
}

/** Signed in with the vendor, unknown here: the knock path, as a page a person can act on. */
export function notLinkedPage(identity: string, channel: string, locale: Locale): string {
  return (
    `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><body style="font:15px/1.7 sans-serif;max-width:560px;margin:80px auto;padding:0 20px">` +
    `<h3>${escapeHtml(tr("page.not-linked.title", locale, { channel }))}</h3>` +
    `<p>${escapeHtml(tr("page.not-linked.your-id", locale))}<code>${escapeHtml(identity)}</code></p>` +
    `<p>${escapeHtml(tr("page.not-linked.how", locale, { channel }))}</p></body></html>`
  );
}

/** Signed in with the vendor, not activated here: the request is with the Admins, and scanning again adds nothing (INV-2202). */
export function askedToJoinPage(name: string, channel: string, locale: Locale): string {
  const title = escapeHtml(tr("page.asked.title", locale));
  return (
    `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<body data-page="asked-to-join" style="font:16px/1.7 system-ui;max-width:600px;margin:80px auto;padding:20px"><h1 style="font-size:22px">${title}</h1>` +
    `<p>${escapeHtml(tr("page.asked.who", locale, { name, channel }))}</p><p>${escapeHtml(tr("page.asked.how", locale))}</p>` +
    `<p><a href="/login">${escapeHtml(tr("page.asked.again", locale))}</a></p></body></html>`
  );
}

/** Signed in with the vendor as somebody outside the organisation the door's app belongs to (INV-729). */
export function notMemberPage(channel: string, locale: Locale): string {
  return (
    `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><body style="font:15px/1.7 sans-serif;max-width:560px;margin:80px auto;padding:0 20px">` +
    `<h3>${escapeHtml(tr("page.not-member.title", locale, { channel }))}</h3>` +
    `<p>${escapeHtml(tr("page.not-member.how", locale))}</p></body></html>`
  );
}

/** Where a connector's authorization lands: connected, or why not. */
export function oauthResultPage(result: { provider: string } | { why: string }, locale: Locale): string {
  const [title, text] =
    "provider" in result
      ? [tr("page.oauth.connected", locale, { provider: result.provider }), tr("page.oauth.connected-how", locale)]
      : [tr("page.oauth.not-connected", locale), result.why];
  return `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;padding:2rem"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></body></html>`;
}

/**
 * The page a desktop iframe shows until noVNC answers: the desktop's own black, one
 * quiet line and a reload every two seconds during startup; a retry when it fails.
 */
export function desktopWaitingPage(reason: string, locale: Locale = "en", loading = reason === ""): string {
  return (
    `<!doctype html><html lang="${lang(locale)}" data-desktop-state="${loading ? "starting" : "failed"}"><head><meta charset="utf-8">` +
    (loading ? '<meta http-equiv="refresh" content="2">' : "") +
    `<title>${escapeHtml(tr("page.desktop.title", locale))}</title>` +
    "<style>html,body{margin:0;height:100%;background:#000;color:#ddd;" +
    "font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
    "body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}" +
    "small{display:block;margin:8px 0;color:#aaa;overflow-wrap:anywhere}a{display:inline-block;color:inherit;padding:6px}</style></head>" +
    `<body><div>${escapeHtml(tr(loading ? "page.desktop.starting" : "page.desktop.failed", locale))}` +
    (reason ? `<small>${escapeHtml(reason)}</small>` : "") +
    (loading ? "" : `<a href="">${escapeHtml(tr("page.desktop.retry", locale))}</a>`) +
    "</div></body></html>"
  );
}
