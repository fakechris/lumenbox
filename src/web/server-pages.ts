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

/** GET /bootstrap: the one-use code and a Feishu channel to sign in through. */
export function bootstrapPage(doors: readonly { id: string; name: string }[], locale: Locale, codePath: string, callbackTemplate?: string): string {
  const say = (key: string) => escapeHtml(tr(key, locale));
  const steps = `<ol><li><a href="/?ui=next&amp;once=1&amp;view=settings&amp;pane=doors">${say("page.bootstrap.operator")}</a> ${say("page.bootstrap.operator-how")}</li>
<li>${say("page.bootstrap.configure")}</li><li>${say("page.bootstrap.register")} ${callbackTemplate ? `<code>${escapeHtml(callbackTemplate)}</code>` : say("page.bootstrap.public-url")}</li>
<li>${say("page.bootstrap.scan")} <code>${escapeHtml(codePath)}</code>.</li></ol>`;
  return `<!doctype html><html lang="${lang(locale)}"><meta charset="utf-8"><title>${say("page.bootstrap.title")}</title><body style="font:16px system-ui;max-width:680px;margin:80px auto;padding:20px"><h1>${say("page.bootstrap.title")}</h1>${steps}<form id="bootstrap"><label>${say("page.bootstrap.code")} <input id="code" type="password" autocomplete="off" maxlength="128" required></label><label> ${say("page.bootstrap.channel")} <select id="door">${doors.map(door => `<option value="${escapeHtml(door.id)}">${escapeHtml(door.name)}</option>`).join("")}</select></label><button ${doors.length ? "" : "disabled"}>${say("page.bootstrap.sign-in")}</button></form><p id="status">${doors.length ? say("page.bootstrap.expires") : say("page.bootstrap.no-channel")}</p><script>document.getElementById('bootstrap').onsubmit=async function(event){event.preventDefault();var button=this.querySelector('button');button.disabled=true;try{var response=await fetch('/auth/'+encodeURIComponent(document.getElementById('door').value),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bootstrapCode:document.getElementById('code').value})});var data=await response.json();if(!response.ok)throw new Error(data.error);document.getElementById('code').value='';location.assign(data.url);}catch(error){document.getElementById('status').textContent=error.message;button.disabled=false;}};</script></body></html>`;
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
