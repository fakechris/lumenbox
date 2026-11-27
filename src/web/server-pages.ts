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

const SERVER_PAGE_CSS = [
  ":root{color-scheme:light dark;--bg:#f7f6f2;--surface:#fffdfa;--rail:#efece5;--border:#e7e1d8;--strong:#cdc4b6;",
  "--text:#1f1a17;--soft:#443a32;--muted:#71675d;--accent:#9f4f24;--accent-soft:#f4dfd2;--accent-fg:#fff;",
  "--ok:#2f7d52;--ok-soft:#e4f0e8;--warn:#a85e10;--warn-soft:#fff3df;--bad:#b04545;--bad-soft:#fbe9e7;",
  "--shadow:0 12px 36px rgba(31,26,23,.06),0 1px 2px rgba(31,26,23,.04)}",
  "@media(prefers-color-scheme:dark){:root{--bg:#0f1218;--surface:#161b24;--rail:#11161f;--border:#232b38;--strong:#364357;",
  "--text:#e6edf5;--soft:#c2cfde;--muted:#8492a6;--accent:#e08a5b;--accent-soft:rgba(224,138,91,.16);--accent-fg:#0f1218;",
  "--ok:#4ecb86;--ok-soft:rgba(34,197,94,.15);--warn:#f0b34a;--warn-soft:rgba(245,158,11,.14);--bad:#f08a8a;--bad-soft:rgba(240,90,90,.14);",
  "--shadow:0 18px 44px rgba(0,0,0,.38),0 1px 2px rgba(0,0,0,.24)}}",
  "*{box-sizing:border-box}html,body{margin:0;min-height:100%}",
  "body{font:15px/1.6 'IBM Plex Sans','PingFang SC',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;",
  "background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;padding:32px 18px}",
  ".shell{width:min(var(--w,560px),100%)}.card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:28px 30px;box-shadow:var(--shadow)}",
  ".top{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}",
  ".logo{width:28px;height:28px;border-radius:8px;background:var(--text);color:var(--bg);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}",
  ".brand{font-weight:600;font-size:15px;letter-spacing:-.01em}.badge{font-size:12px;font-weight:500;padding:2px 9px;border-radius:999px;background:var(--rail);color:var(--soft);border:1px solid var(--border)}",
  ".langs{margin-left:auto;display:flex;gap:4px;font-size:12px}.langs a{color:var(--muted);text-decoration:none;padding:3px 7px;border-radius:6px}",
  ".langs a[aria-current='true']{background:var(--rail);color:var(--text);font-weight:600}",
  "h1{margin:0 0 6px;font-size:22px;font-weight:650;letter-spacing:-.015em;line-height:1.3}",
  ".sub{margin:0 0 18px;color:var(--muted);font-size:14px}p{margin:0 0 14px;color:var(--soft);font-size:14.5px}p:last-child{margin-bottom:0}",
  "code{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--rail);color:var(--text);padding:2px 6px;border-radius:6px;border:1px solid var(--border);overflow-wrap:anywhere}",
  ".callout{padding:13px 15px;border-radius:12px;margin:0 0 16px;font-size:13.5px;line-height:1.55;border:1px solid var(--border);background:var(--rail);color:var(--soft)}",
  ".callout-warn{background:var(--warn-soft);color:var(--warn);border-color:transparent}.callout-ok{background:var(--ok-soft);color:var(--ok);border-color:transparent}",
  ".callout-accent{background:var(--accent-soft);color:var(--text);border-color:transparent}.callout strong{display:block;font-weight:600;margin-bottom:3px;color:var(--text)}",
  ".checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin:0 0 18px}",
  ".check{padding:10px 12px;border-radius:11px;background:var(--rail);border:1px solid var(--border);display:flex;flex-direction:column;gap:3px}",
  ".check-k{font-size:11.5px;color:var(--muted);font-weight:500}.check-v{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}",
  ".dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted)}.dot-ok{background:var(--ok)}.dot-warn{background:var(--warn)}.dot-accent{background:var(--accent)}",
  ".panel{border:1px solid var(--border);border-radius:13px;padding:16px 18px;margin:0 0 14px;background:var(--bg)}",
  ".panel-h{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 10px}",
  "ul.doors,ol.steps{margin:0 0 14px;padding-left:20px;color:var(--soft);font-size:14px}ul.doors li,ol.steps li{margin:0 0 10px}ul.doors li:last-child,ol.steps li:last-child{margin-bottom:0}",
  "ul.provider-list{list-style:none;padding:0;margin:12px 0;display:grid;gap:10px}",
  "ul.provider-list li{border:1px solid var(--border);border-radius:12px;padding:13px 15px;background:var(--surface);font-size:13.5px;line-height:1.6;color:var(--soft)}",
  ".cmd{display:flex;align-items:center;gap:8px;background:var(--rail);border:1px solid var(--border);border-radius:9px;padding:8px 11px;margin:6px 0 12px}",
  ".cmd pre{margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;flex:1;user-select:all}",
  ".copy-link{flex:none;font-size:12px;font-weight:500;color:var(--accent);text-decoration:none;padding:3px 8px;border-radius:6px;border:1px solid var(--border);background:var(--surface);cursor:pointer;user-select:none}",
  "form#bootstrap,form#op-unlock{display:flex;flex-direction:column;gap:12px;margin-top:8px}",
  "form#bootstrap label,form#op-unlock label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:var(--soft)}",
  "form#bootstrap input,form#op-unlock input{width:100%;padding:10px 12px;font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:10px;border:1px solid var(--strong);background:var(--surface);color:var(--text)}",
  "form#bootstrap input:focus,form#op-unlock input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}",
  ".btn-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:2px}",
  "button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;font:600 14px/1.3 inherit;",
  "border-radius:10px;border:1px solid transparent;background:var(--accent);color:var(--accent-fg);text-decoration:none;cursor:pointer}",
  "button:hover,.btn:hover{filter:brightness(1.06)}button:disabled{opacity:.55;cursor:not-allowed}",
  ".btn-secondary{background:var(--surface);color:var(--text);border-color:var(--strong)}",
  ".acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;align-items:center}",
  "#status,#op-status{margin:10px 0 0;font-size:13px;color:var(--muted)}#status[data-err='1'],#op-status[data-err='1']{color:var(--bad);font-weight:500}",
  "@media(max-width:520px){body{padding:16px 12px}.card{padding:20px 18px}}",
].join("");

function pageShell(options: {
  locale: Locale; title: string; badge?: string; width?: number; bodyAttrs?: string;
  langLinks?: boolean; content: string; script?: string;
}): string {
  const { locale, title, badge, width = 540, bodyAttrs = "", langLinks = false, content, script = "" } = options;
  const switcher = langLinks
    ? `<nav class="langs" aria-label="Language"><a href="?lang=zh"${locale === "zh" ? ' aria-current="true"' : ""}>中文</a>` +
      `<a href="?lang=en"${locale === "en" ? ' aria-current="true"' : ""}>EN</a></nav>`
    : "";
  const badgeHtml = badge ? `<span class="badge">${escapeHtml(badge)}</span>` : "";
  return `<!doctype html><html lang="${lang(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)} — LumenBox</title><style>${SERVER_PAGE_CSS}</style></head>` +
    `<body${bodyAttrs ? ` ${bodyAttrs}` : ""}><main class="shell" style="--w:${width}px"><div class="card">` +
    `<header class="top"><span class="logo" aria-hidden="true">L</span><span class="brand">LumenBox</span>${badgeHtml}${switcher}</header>` +
    `${content}</div></main>${script}</body></html>`;
}

export interface OperatorUnlock {
  credPath: string;
  next: string;
}

function shellQuotePath(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

function operatorReadCmd(credPath: string): string {
  return credPath === "/state/ui-token"
    ? "kubectl -n agentbox exec deploy/agentbox-organisation -- cat /state/ui-token"
    : `cat ${shellQuotePath(credPath)}`;
}

function copyJsSnippet(copiedWord: string): string {
  return "document.querySelectorAll('[data-copy]').forEach(function(el){el.onclick=function(ev){ev.preventDefault();" +
    `if(navigator.clipboard){navigator.clipboard.writeText(el.getAttribute('data-copy')||'');var old=el.textContent;el.textContent='${copiedWord}';setTimeout(function(){el.textContent=old;},1500);}};});`;
}

function operatorUnlockJs(): string {
  return "var opForm=document.getElementById('op-unlock');if(opForm){opForm.onsubmit=async function(ev){ev.preventDefault();" +
    "var btn=this.querySelector('button'),err=document.getElementById('op-status'),inp=document.getElementById('op-cred');" +
    "err.textContent='';err.removeAttribute('data-err');btn.disabled=true;" +
    "try{var res=await fetch('/api/operator-session',{method:'POST',headers:{'content-type':'application/json'}," +
    "body:JSON.stringify({credential:inp.value,next:this.getAttribute('data-next')||'/'})});" +
    "var data=await res.json();if(!res.ok)throw new Error(data.error||'Denied');inp.value='';location.assign(data.redirect||'/');}" +
    "catch(e){err.setAttribute('data-err','1');err.textContent=e.message;btn.disabled=false;}};}";
}

export function signInRecoveryPage(
  reason: "sign-in-required" | "access-removed" | "session-expired" | "sign-in-expired" | "bootstrap-unavailable",
  locale: Locale,
  { setup = false, orgView = false, personal = false, operatorUnlock }: {
    setup?: boolean; orgView?: boolean; personal?: boolean; operatorUnlock?: OperatorUnlock;
  } = {},
): string {
  const say = (key: string) => escapeHtml(tr(key, locale));
  const titleText = tr(`page.recovery.${reason}`, locale);
  const title = escapeHtml(titleText);
  const copyWord = tr("page.bootstrap.copy", locale);
  const copiedWord = escapeHtml(tr("page.bootstrap.copied", locale));
  const setupCard = setup
    ? `<div class="callout callout-accent"><strong>${say("page.bootstrap.title")}</strong>${say("page.recovery.setup-pending")}` +
      `<div class="acts"><a class="btn" href="/bootstrap">${say("page.recovery.setup-cta")}</a></div></div>`
    : "";
  const operatorCard = operatorUnlock && !orgView
    ? `<div class="panel"><div class="panel-h">${say("page.recovery.operator-title")}</div>` +
      `<p>${say("page.recovery.operator-how")}</p>` +
      `${copyRow(operatorReadCmd(operatorUnlock.credPath), copyWord)}` +
      `<form id="op-unlock" data-next="${escapeHtml(operatorUnlock.next)}">` +
      `<label>${say("page.bootstrap.operator-label")} <input id="op-cred" type="password" autocomplete="off" placeholder="${say("page.bootstrap.operator-placeholder")}" required></label>` +
      `<div class="btn-row"><button type="submit" class="${setup ? "btn btn-secondary" : "btn"}">${say("page.recovery.operator-open")}</button></div>` +
      `</form><p id="op-status"></p></div>`
    : "";
  const unavailableNote = reason === "bootstrap-unavailable"
    ? personal
      ? `<div class="callout callout-warn"><strong>${say("page.recovery.personal-title")}</strong>${say("page.recovery.personal-how")}</div>`
      : `<div class="callout">${say("page.recovery.already-setup")}</div>`
    : "";
  const action = orgView
    ? `<p>${say("page.recovery.desktop")}</p>`
    : `<div class="acts"><a class="${setup || operatorCard ? "btn btn-secondary" : "btn"}" href="/login">${say("page.recovery.login")}</a></div>`;
  const contact = setup ? `<p class="sub">${say("page.recovery.contact")}</p>` : `<p>${say("page.recovery.contact")}</p>`;
  const script = operatorCard ? `<script>${copyJsSnippet(copiedWord)}${operatorUnlockJs()}</script>` : "";
  return pageShell({
    locale,
    title: titleText,
    width: operatorCard ? 580 : 520,
    content: `<h1>${title}</h1>${setupCard}${operatorCard}${unavailableNote}${contact}${action}`,
    script,
  });
}

/** A channel that could sign the first Admin in once its app is in the server's environment. */
export interface DoorToSet { id: string; type: "feishu" | "dingtalk"; keys: { id: string; secret: string }; callback?: string }

function copyRow(command: string, copyLabel: string): string {
  const escaped = escapeHtml(command);
  return `<div class="cmd"><pre>${escaped}</pre><a class="copy-link" href="#copy" role="link" data-copy="${escaped}">${escapeHtml(copyLabel)}</a></div>`;
}

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
  local: boolean; locale: Locale; codePath: string; callbackTemplate?: string; operatorUnlock?: OperatorUnlock;
}): string {
  const { doors, locale } = page;
  const say = (key: string) => escapeHtml(tr(key, locale));
  const code = `<code>${escapeHtml(page.codePath)}</code>`;
  const hasPlaceholderUrl = (page.callbackTemplate ?? "").includes("REPLACE_WITH_PUBLIC_HOST") ||
    page.toSet.some(door => (door.callback ?? "").includes("REPLACE_WITH_PUBLIC_HOST"));
  const hasPublicUrl = Boolean(page.callbackTemplate || page.toSet.some(door => Boolean(door.callback))) && !hasPlaceholderUrl;
  const channelReady = doors.length > 0;
  const copyWord = tr("page.bootstrap.copy", locale);
  const copiedWord = escapeHtml(tr("page.bootstrap.copied", locale));

  const checks = `<div class="checks">` +
    `<div class="check"><span class="check-k">${say("page.bootstrap.check-url")}</span>` +
    `<span class="check-v"><span class="dot ${hasPublicUrl ? "dot-ok" : "dot-warn"}"></span>${say(hasPublicUrl ? "page.bootstrap.state-ready" : "page.bootstrap.state-needed")}</span></div>` +
    `<div class="check"><span class="check-k">${say("page.bootstrap.check-channel")}</span>` +
    `<span class="check-v"><span class="dot ${channelReady ? "dot-ok" : "dot-warn"}"></span>` +
    `${channelReady ? escapeHtml(doors.map(d => tr(`page.bootstrap.vendor-${d.type}`, locale)).join(" · ")) : say("page.bootstrap.state-needed")}</span></div>` +
    `<div class="check"><span class="check-k">${say("page.bootstrap.check-code")}</span>` +
    `<span class="check-v"><span class="dot dot-accent"></span>${say("page.bootstrap.state-file")}</span></div>` +
    `</div>`;

  const urlAlert = hasPlaceholderUrl
    ? `<div class="callout callout-warn">${say("page.bootstrap.placeholder-warn")}</div>`
    : !hasPublicUrl && !page.local
      ? `<div class="callout callout-warn">${say("page.bootstrap.url-unset-warn")}</div>`
      : "";

  const label = (door: (typeof doors)[number]) =>
    say(`page.bootstrap.with-${door.type}`) + (doors.filter(other => other.type === door.type).length > 1 ? ` (${escapeHtml(door.name)})` : "");
  const buttons = doors.map(door => `<button name="door" value="${escapeHtml(door.id)}">${label(door)}</button>`).join(" ");
  const codeInput = `<input id="code" type="password" autocomplete="off" maxlength="128" placeholder="${say("page.bootstrap.code-placeholder")}" required>`;
  const form = `<form id="bootstrap"><label>${say("page.bootstrap.code")} ${codeInput}</label><div class="btn-row">${buttons}</div></form>`;
  const toSet = page.toSet.map(door =>
    `<li><div>${say(`page.bootstrap.set-${door.type}`)} <code>${escapeHtml(door.keys.id)}</code>, <code>${escapeHtml(door.keys.secret)}</code>` +
    `${say("page.bootstrap.set-callback")}<code>${escapeHtml(door.callback ?? "")}</code></div></li>`,
  ).join("");
  const readCmd = page.codePath === "/state/bootstrap-code"
    ? "kubectl -n agentbox exec deploy/agentbox-organisation -- cat /state/bootstrap-code"
    : `cat ${shellQuotePath(page.codePath)}`;

  const localUnlock = page.local && page.operatorUnlock
    ? `<div class="panel"><div class="panel-h">${say("page.bootstrap.operator-title")}</div>` +
      `<p>${say("page.bootstrap.operator-cmd")}</p>${copyRow(operatorReadCmd(page.operatorUnlock.credPath), copyWord)}` +
      `<form id="op-unlock" data-next="${escapeHtml(page.operatorUnlock.next)}">` +
      `<label>${say("page.bootstrap.operator-label")} <input id="op-cred" type="password" autocomplete="off" placeholder="${say("page.bootstrap.operator-placeholder")}" required></label>` +
      `<div class="btn-row"><button type="submit">${say("page.bootstrap.operator-open")}</button></div>` +
      `</form><p id="op-status"></p></div>`
    : "";

  const steps = page.local
    ? `${localUnlock}<div class="panel"><ol class="steps"><li><a href="/?ui=next&amp;once=1&amp;view=settings&amp;pane=doors">${say("page.bootstrap.operator")}</a> ${say("page.bootstrap.operator-how")}</li>
<li>${say("page.bootstrap.configure")}</li><li>${say("page.bootstrap.register")} ${page.callbackTemplate ? `<code>${escapeHtml(page.callbackTemplate)}</code>` : say("page.bootstrap.public-url")}</li>
<li>${say("page.bootstrap.scan")} ${code}.${copyRow(readCmd, copyWord)}</li></ol></div>`
    : doors.length > 0
      ? `<div class="panel"><div class="panel-h">${say("page.bootstrap.step-sign-title")}</div><p>${say("page.bootstrap.enter")} ${code}</p>` +
        `<p>${say("page.bootstrap.cmd-read-label")}</p>${copyRow(readCmd, copyWord)}</div>`
      : `<div class="panel"><div class="panel-h">${say("page.bootstrap.step-env-title")}</div><p>${say("page.bootstrap.none")}</p>` +
        `<ul class="provider-list">${toSet}</ul><p>${say("page.bootstrap.cmd-restart-label")}</p>` +
        `${copyRow("kubectl -n agentbox rollout restart deploy/agentbox-organisation", copyWord)}</div>` +
        `<div class="panel"><div class="panel-h">${say("page.bootstrap.step-code-title")}</div><p>${say("page.bootstrap.then")} ${code}</p>` +
        `${copyRow(readCmd, copyWord)}</div>`;

  const body = page.local || doors.length > 0
    ? `${checks}${urlAlert}${steps}<div class="panel">${form}<p id="status">${doors.length ? say("page.bootstrap.expires") : say("page.bootstrap.no-channel")}</p></div>`
    : `${checks}${urlAlert}${steps}`;

  const copyJs = copyJsSnippet(copiedWord);
  const unlockJs = page.local && page.operatorUnlock ? operatorUnlockJs() : "";
  const submitJs = doors.length === 0 ? "" : "document.getElementById('bootstrap').onsubmit=async function(event){event.preventDefault();" +
    "var buttons=this.querySelectorAll('button'),door=(event.submitter||buttons[0]).value,status=document.getElementById('status');" +
    "status.removeAttribute('data-err');buttons.forEach(function(b){b.disabled=true;});try{var response=await fetch('/auth/'+encodeURIComponent(door),{method:'POST'," +
    "headers:{'content-type':'application/json'},body:JSON.stringify({bootstrapCode:document.getElementById('code').value})});" +
    "var data=await response.json();if(!response.ok)throw new Error(data.error);document.getElementById('code').value='';location.assign(data.url);}" +
    "catch(error){status.setAttribute('data-err','1');status.textContent=error.message;buttons.forEach(function(b){b.disabled=false;});}};";

  return pageShell({
    locale,
    title: tr("page.bootstrap.title", locale),
    badge: tr("page.bootstrap.badge", locale),
    width: 660,
    langLinks: true,
    content: `<h1>${say("page.bootstrap.title")}</h1><p class="sub">${say("page.bootstrap.subtitle")}</p>${body}`,
    script: `<script>${copyJs}${unlockJs}${submitJs}</script>`,
  });
}
/** Signed in with the vendor, unknown here: the knock path, as a page a person can act on. */
export function notLinkedPage(identity: string, channel: string, locale: Locale): string {
  const titleText = tr("page.not-linked.title", locale, { channel });
  return pageShell({
    locale,
    title: titleText,
    width: 520,
    content: `<h1>${escapeHtml(titleText)}</h1>` +
      `<div class="callout">${escapeHtml(tr("page.not-linked.your-id", locale))}<code>${escapeHtml(identity)}</code></div>` +
      `<p>${escapeHtml(tr("page.not-linked.how", locale, { channel }))}</p>` +
      `<div class="acts"><a class="btn btn-secondary" href="/login">${escapeHtml(tr("page.recovery.login", locale))}</a></div>`,
  });
}

/** Signed in with the vendor, not activated here: the request is with the Admins, and scanning again adds nothing (INV-2202). */
export function askedToJoinPage(name: string, channel: string, locale: Locale): string {
  const titleText = tr("page.asked.title", locale);
  return pageShell({
    locale,
    title: titleText,
    width: 520,
    bodyAttrs: 'data-page="asked-to-join"',
    content: `<h1>${escapeHtml(titleText)}</h1>` +
      `<div class="callout callout-accent">${escapeHtml(tr("page.asked.who", locale, { name, channel }))}</div>` +
      `<p>${escapeHtml(tr("page.asked.how", locale))}</p>` +
      `<div class="acts"><a class="btn" href="/login">${escapeHtml(tr("page.asked.again", locale))}</a></div>`,
  });
}

/** Signed in with the vendor as somebody outside the organisation the door's app belongs to (INV-729). */
export function notMemberPage(channel: string, locale: Locale): string {
  const titleText = tr("page.not-member.title", locale, { channel });
  return pageShell({
    locale,
    title: titleText,
    width: 520,
    content: `<h1>${escapeHtml(titleText)}</h1>` +
      `<div class="callout callout-warn">${escapeHtml(tr("page.not-member.how", locale))}</div>` +
      `<div class="acts"><a class="btn btn-secondary" href="/login">${escapeHtml(tr("page.recovery.login", locale))}</a></div>`,
  });
}

/** Where a connector's authorization lands: connected, or why not. */
export function oauthResultPage(result: { provider: string } | { why: string }, locale: Locale): string {
  const ok = "provider" in result;
  const [titleText, text] = ok
    ? [tr("page.oauth.connected", locale, { provider: result.provider }), tr("page.oauth.connected-how", locale)]
    : [tr("page.oauth.not-connected", locale), result.why];
  return pageShell({
    locale,
    title: titleText,
    width: 500,
    content: `<h1>${escapeHtml(titleText)}</h1><div class="callout ${ok ? "callout-ok" : "callout-warn"}">${escapeHtml(text)}</div>`,
  });
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
