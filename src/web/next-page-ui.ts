/**
 * The rebuilt page (INV-1825, docs/99 §6): a narrow rail, an inbox that is the only place asking for
 * a person's attention, work one row each, and a panel that opens on demand.
 *
 * It reads the endpoints the classic page reads and writes nothing new: no storage changed for it,
 * so `/?ui=next` and `/` can be switched between at will. What is not rebuilt yet links to the
 * classic page rather than pretending.
 */
import { NEXT_LOGIC_JS } from "./next-logic-ui.ts";
import { NEXT_VIEWS_JS } from "./next-views-ui.ts";
import { NEXT_PANEL_JS } from "./next-panel-ui.ts";

const STYLE = `
:root {
  --bg: #f7f6f2; --rail: #efece5; --surface: #fffdfa; --border: #e7e1d8; --border-strong: #cdc4b6;
  --text: #1f1a17; --soft: #443a32; --muted: #71675d;
  --accent: #9f4f24; --accent-soft: #f4dfd2; --blue: #2563bb; --blue-soft: #dbe7f7;
  --ok: #2f7d52; --ok-soft: #e4f0e8; --warn: #a85e10; --warn-soft: #fff3df; --bad: #b04545; --bad-soft: #fbe9e7;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 14px/1.5 "IBM Plex Sans", "PingFang SC", system-ui, sans-serif; color: var(--text); background: var(--bg); display: flex; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
a { color: inherit; }
[hidden] { display: none !important; }
.rail { width: 64px; flex: none; background: var(--rail); border-right: 1px solid var(--border); display: flex; flex-direction: column; align-items: center; padding: 12px 0; gap: 4px; }
.rail .logo { width: 30px; height: 30px; border-radius: 8px; background: var(--text); color: var(--bg); display: grid; place-items: center; font-weight: 700; margin-bottom: 12px; }
.rail button, .rail a { width: 52px; padding: 7px 0 5px; border-radius: 10px; font-size: 11px; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 2px; position: relative; text-decoration: none; }
.rail svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.rail [aria-current="true"] { background: var(--surface); color: var(--text); box-shadow: 0 0 0 1px var(--border); }
.rail .badge { position: absolute; top: 2px; right: 8px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 10px; line-height: 16px; padding: 0 4px; }
.rail .spacer { flex: 1; }
main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
header.bar { min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid var(--border); flex: none; }
header.bar h1 { font-size: 16px; font-weight: 600; margin: 0; }
header.bar .hint { color: var(--muted); font-size: 13px; }
header.bar .tools { margin-left: auto; display: flex; gap: 6px; }
.seg { padding: 4px 12px; border-radius: 8px; font-size: 13px; color: var(--muted); }
.seg[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 0 0 1px var(--border); }
.view { flex: 1; overflow: auto; padding: 20px 24px 40px; }
.list { max-width: 880px; }
h2.group { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: .04em; margin: 22px 0 10px; }
h2.group:first-child { margin-top: 0; }
.row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 8px; }
.row:hover { border-color: var(--border-strong); }
.row .open { flex: 1; min-width: 0; text-align: left; display: flex; align-items: center; gap: 14px; }
.who { width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-weight: 600; font-size: 12px; flex: none; }
.body { flex: 1; min-width: 0; }
.title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.why { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.when { color: var(--muted); font-size: 12px; flex: none; }
.meter { height: 3px; border-radius: 2px; background: var(--border); margin-top: 6px; max-width: 260px; }
.meter i { display: block; height: 100%; border-radius: 2px; background: var(--blue); }
.chip { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; background: var(--rail); color: var(--soft); flex: none; }
.chip.need { background: var(--warn-soft); color: var(--warn); }
.chip.run { background: var(--blue-soft); color: var(--blue); }
.chip.done { background: var(--ok-soft); color: var(--ok); }
.chip.stuck { background: var(--bad-soft); color: var(--bad); }
.act, .act-primary, .act-danger { padding: 5px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface); font-size: 13px; flex: none; }
.act-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.act-danger { color: var(--bad); border-color: var(--bad); }
.acts { display: flex; gap: 6px; flex: none; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; max-width: 880px; }
.board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 14px; align-items: start; }
.col { background: var(--rail); border-radius: 14px; padding: 12px; }
.col h2.group { margin: 0 0 10px; }
.card { display: block; width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; margin-bottom: 8px; }
.card .title { white-space: normal; margin: 6px 0 2px; }
.card .why { white-space: normal; }
.card .foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.scrim { position: fixed; inset: 0; background: rgba(31,26,23,.18); }
.panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(600px, calc(100vw - 24px)); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 18px 50px rgba(31,26,23,.16); display: flex; flex-direction: column; }
.panel > header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.panel > header .x { margin-left: auto; font-size: 20px; color: var(--muted); width: 28px; }
.panel .inner { padding: 18px; overflow: auto; flex: 1; }
.panel h3 { font-size: 18px; margin: 0 0 6px; overflow-wrap: anywhere; }
.panel .asked { color: var(--soft); margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9em; overflow: auto; }
.needbox { background: var(--warn-soft); border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; }
.needbox .acts { margin-top: 10px; flex-wrap: wrap; }
.needbox textarea { width: 100%; margin-top: 10px; min-height: 64px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px; font: inherit; background: var(--surface); }
.file { display: flex; justify-content: space-between; gap: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 6px 0; font-size: 13px; text-decoration: none; }
.file span:last-child { color: var(--muted); flex: none; }
.counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 8px 0; }
.count { border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
.count b { display: block; font-size: 20px; }
.count small { color: var(--muted); display: block; }
.budget { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--bg); border-radius: 10px; padding: 10px 12px; margin: 8px 0; font-size: 13px; }
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 13px; }
.steps li:first-child { border-top: 0; }
.steps .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.steps time, .steps .flag { color: var(--muted); flex: none; }
.steps .flag.bad { color: var(--bad); }
.foot-links { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 10px; font-size: 13px; max-width: 80vw; }
@media (max-width: 640px) {
  body { flex-direction: column-reverse; }
  .rail { width: 100%; flex-direction: row; justify-content: space-around; border-right: 0; border-top: 1px solid var(--border); padding: 6px 0; }
  .rail .logo, .rail .spacer { display: none; }
  header.bar { padding: 8px 14px; flex-wrap: wrap; } .view { padding: 14px; }
  .row { flex-wrap: wrap; } .when { display: none; }
  .board { grid-template-columns: 1fr; }
  .panel { inset: 0; width: auto; border-radius: 0; }
}
`;

const ICON: Record<string, string> = {
  inbox: `<path d="M4 13l2.5-8h11L20 13v6H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>`,
  work: `<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6M9 17h3"/>`,
  chat: `<path d="M5 5h14v11H10l-5 4z"/>`,
  team: `<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.2"/><path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>`,
  auto: `<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>`,
};
const icon = (name: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
/** Rebuilt here; the rest open the classic page until they are. */
const navButton = (name: string): string => `<button data-nav="${name}">${icon(name)}{{ui.next.nav.${name}}}${name === "inbox" ? `<span class="badge" id="inbox-badge" hidden></span>` : ""}</button>`;
const navLink = (name: string, href: string): string => `<a href="${href}" title="{{ui.next.soon}}">${icon(name)}{{ui.next.nav.${name}}}</a>`;

export const NEXT_HTML = `<!doctype html>
<html lang="{{@lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ui.next.title}}</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<nav class="rail" aria-label="{{ui.next.nav.label}}">
  <div class="logo" aria-hidden="true">L</div>
  ${navButton("inbox")}
  ${navButton("work")}
  ${navLink("chat", "/")}
  ${navLink("team", "/")}
  ${navLink("auto", "/")}
  <div class="spacer"></div>
  ${navLink("settings", "/")}
</nav>
<main>
  <header class="bar">
    <h1 id="view-title"></h1><span class="hint" id="view-hint"></span>
    <div class="tools" id="work-tools" hidden>
      <button class="seg" data-layout="list" aria-pressed="true">{{ui.next.view.list}}</button>
      <button class="seg" data-layout="board" aria-pressed="false">{{ui.next.view.board}}</button>
    </div>
  </header>
  <section class="view" id="view"></section>
</main>
<div class="scrim" id="scrim" hidden></div>
<aside class="panel" id="panel" aria-label="{{ui.next.panel.label}}" hidden>
  <header><span class="chip" id="panel-chip"></span><span class="when" id="panel-who"></span><button class="x" id="panel-close" aria-label="{{ui.next.act.close}}">×</button></header>
  <div class="inner" id="panel-inner"></div>
</aside>
<div class="toast" id="toast" role="status" hidden></div>
<script>
var MSG = {{@messages}};
function t(key, vars) {
  var text = MSG[key] === undefined ? key : MSG[key];
  return text.replace(/\\{(\\w+)\\}/g, function (whole, name) { return vars && vars[name] !== undefined ? String(vars[name]) : whole; });
}
function $(id) { return document.getElementById(id); }
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function getJson(path) {
  return fetch(path, { headers: { accept: "application/json" } }).then(function (res) {
    return res.json().then(function (body) { if (!res.ok) throw new Error(body && body.error ? body.error : String(res.status)); return body; });
  });
}
function postJson(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) { if (!res.ok) throw new Error(data && data.error ? data.error : String(res.status)); return data; });
  });
}
var toastTimer = 0;
function toast(text) {
  var node = $("toast"); node.textContent = text; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { node.hidden = true; }, 3200);
}
function failed(error) { toast(t("ui.next.failed", { error: error && error.message ? error.message : String(error) })); }
${NEXT_LOGIC_JS}
${NEXT_VIEWS_JS}
${NEXT_PANEL_JS}
nextStart();
</script>
</body>
</html>`;
