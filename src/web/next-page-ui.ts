/**
 * The rebuilt page (INV-1825, docs/99 §6). Its main line is what a person remembers: which agent, on
 * which computer, they talked to. So it opens on the agents and the conversation with one of them;
 * that agent's work sits pinned in its conversation. What cuts across agents — everything that needs
 * the person, all work — is one click away and never the landing.
 *
 * It reads the endpoints the classic page reads and writes nothing new: no storage changed for it,
 * so `/?ui=next` and `/` can be switched between at will. What is not rebuilt yet links to the
 * classic page rather than pretending.
 */
import { NEXT_LOGIC_JS } from "./next-logic-ui.ts";
import { NEXT_VIEWS_JS } from "./next-views-ui.ts";
import { NEXT_PANEL_JS } from "./next-panel-ui.ts";
import { NEXT_CHAT_JS } from "./next-chat-ui.ts";
import { NEXT_DIAGNOSTICS_JS } from "./next-diagnostics-ui.ts";
import { NEXT_SCREEN_JS } from "./next-screen-ui.ts";
import { NEXT_SETTINGS_JS } from "./next-settings-ui.ts";
import { NEXT_AUTO_JS } from "./next-auto-ui.ts";
import { NEXT_THREAD_JS } from "./next-thread-ui.ts";
import { NEXT_MEMBER_JS } from "./next-member-ui.ts";
import { NEXT_BOXES_JS } from "./next-boxes-ui.ts";
import { NEXT_CARDS_JS } from "./next-cards-ui.ts";
import { NEXT_SYSTEM_JS } from "./next-system-ui.ts";

const STYLE = `
:root {
  --bg: #f7f6f2; --rail: #efece5; --surface: #fffdfa; --border: #e7e1d8; --border-strong: #cdc4b6;
  --text: #1f1a17; --soft: #443a32; --muted: #71675d;
  --accent: #9f4f24; --accent-soft: #f4dfd2; --blue: #2563bb; --blue-soft: #dbe7f7;
  --ok: #2f7d52; --ok-soft: #e4f0e8; --warn: #a85e10; --warn-soft: #fff3df; --bad: #b04545; --bad-soft: #fbe9e7;
}
html[data-theme="dark"] {
  --bg: #0f1218; --rail: #0b0e13; --surface: #161b24; --border: #232b38; --border-strong: #33405280;
  --text: #e6edf5; --soft: #c2cfde; --muted: #8492a6;
  --accent: #e08a5b; --accent-soft: rgba(224,138,91,.16); --blue: #6aa5f8; --blue-soft: rgba(59,130,246,.18);
  --ok: #4ecb86; --ok-soft: rgba(34,197,94,.15); --warn: #f0b34a; --warn-soft: rgba(245,158,11,.14); --bad: #f08a8a; --bad-soft: rgba(240,90,90,.14);
}
html[data-theme="dark"] .msg-me, html[data-theme="dark"] .act-primary, html[data-theme="dark"] .brand .logo { background: #e6edf5; color: #0f1218; border-color: #e6edf5; }
html[data-theme="dark"] .agent:hover { background: rgba(255,255,255,.04); }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { font: 14px/1.5 "IBM Plex Sans", "PingFang SC", system-ui, sans-serif; color: var(--text); background: var(--bg); display: flex; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
a { color: inherit; }
[hidden] { display: none !important; }
.side { width: 248px; flex: none; background: var(--rail); border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 14px 10px; gap: 6px; min-height: 0; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; padding: 0 6px 8px; }
.brand .logo { width: 26px; height: 26px; border-radius: 7px; background: var(--text); color: var(--bg); display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.boxes { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 2px 6px; }
.boxes button { padding: 3px 10px; border-radius: 999px; font-size: 12px; color: var(--muted); border: 1px solid transparent; }
.boxes button[aria-pressed="true"] { background: var(--surface); color: var(--text); border-color: var(--border); }
.box-notice { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; background: var(--bad-soft); color: var(--bad); font-size: 13px; }
.boxes button.off::before { content: "●"; color: var(--bad); font-size: 8px; margin-right: 5px; vertical-align: middle; }
.needs { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-radius: 10px; background: var(--warn-soft); color: var(--warn); font-size: 13px; font-weight: 500; }
.side h2.group { margin: 10px 8px 4px; }
.agents { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.agent { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; text-align: left; width: 100%; }
.agent:hover { background: rgba(31,26,23,.04); }
.agent[aria-current="true"] { background: var(--surface); box-shadow: 0 0 0 1px var(--border); }
.agent .body { line-height: 1.3; }
.agent .role { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue); flex: none; }
.count { min-width: 18px; height: 18px; border-radius: 9px; background: var(--accent); color: #fff; font-size: 11px; line-height: 18px; text-align: center; padding: 0 5px; flex: none; }
.side-links { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--border); padding-top: 8px; }
.side-links button, .side-links a { padding: 7px 10px; border-radius: 8px; font-size: 13px; color: var(--soft); text-align: left; text-decoration: none; }
.side-foot { display: flex; align-items: center; gap: 2px; }
.side-foot a { margin-left: auto; font-size: 12px; color: var(--muted); }
.side-links [aria-current="true"] { background: var(--surface); box-shadow: 0 0 0 1px var(--border); }
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
.chip.need, .chip-need { background: var(--warn-soft); color: var(--warn); }
.chip-need { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; flex: none; }
.chip.run, .chip-run { background: var(--blue-soft); color: var(--blue); }
.chip-run { display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 12px; flex: none; }
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
.thread { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.pin { display: flex; align-items: center; gap: 12px; padding: 9px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); width: 100%; text-align: left; }
.msg, .msg-me { max-width: 82%; padding: 9px 14px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); overflow-wrap: anywhere; align-self: flex-start; }
.msg-me { align-self: flex-end; background: var(--text); color: var(--bg); border-color: var(--text); white-space: pre-wrap; }
.msg p { margin: 0 0 8px; } .msg p:last-child { margin-bottom: 0; }
.msg pre { background: var(--bg); padding: 8px 10px; border-radius: 8px; overflow: auto; font-size: 12.5px; }
.msg code { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px; }
.msg table { border-collapse: collapse; } .msg td, .msg th { border: 1px solid var(--border); padding: 3px 8px; }
.aside { color: var(--muted); font-size: 13px; align-self: flex-start; max-width: 82%; overflow-wrap: anywhere; }
.fold { color: var(--muted); font-size: 13px; align-self: flex-start; max-width: 100%; }
.fold summary { cursor: pointer; }
.fold ul { list-style: none; margin: 6px 0 0; padding: 0 0 0 14px; border-left: 2px solid var(--border); }
.fold li { padding: 2px 0; overflow-wrap: anywhere; }
.fold li.bad { color: var(--bad); }
.fold b { color: var(--soft); font-weight: 500; }
.livebar { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; align-self: flex-start; }
.composer { flex: none; padding: 10px 24px 16px; }
.composer form { max-width: 780px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
.composer textarea { flex: 1; min-height: 44px; max-height: 180px; resize: none; padding: 11px 14px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface); font: inherit; }
.ask { align-self: flex-start; max-width: 82%; background: var(--warn-soft); border-radius: 14px; padding: 10px 14px; }
.ask .acts { margin-top: 8px; flex-wrap: wrap; }
.plan { align-self: stretch; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 9px 14px; font-size: 13px; }
.plan summary { cursor: pointer; font-weight: 500; }
.plan ul { list-style: none; margin: 8px 0 2px; padding: 0; }
.plan li { padding: 2px 0 2px 20px; position: relative; }
.plan li::before { content: "○"; position: absolute; left: 0; color: var(--muted); }
.plan li.todo-done { color: var(--muted); } .plan li.todo-done::before { content: "✓"; color: var(--ok); }
.plan li.todo-doing { font-weight: 500; } .plan li.todo-doing::before { content: "●"; color: var(--blue); }
.plan li.todo-blocked::before { content: "!"; color: var(--bad); }
header.bar select { font: inherit; font-size: 13px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); max-width: 260px; }
.tabs { display: flex; gap: 2px; background: var(--bg); border-radius: 9px; padding: 2px; }
.diag-note { background: var(--bg); border-radius: 10px; padding: 10px 12px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
.diag { width: 100%; border-collapse: collapse; font: 12.5px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
.diag td { padding: 6px 8px; border-top: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
.diag tr.step { cursor: pointer; } .diag tr.step:hover { background: var(--bg); }
.diag .bad { color: var(--bad); }
.raw { background: #26211e; color: #f4efe8; border-radius: 8px; padding: 10px 12px; margin: 4px 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
.ids { font: 12px/1.6 "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); overflow-wrap: anywhere; }
#screen-toggle { margin-left: auto; }
header.bar { position: relative; }
.menu { position: absolute; right: 14px; top: 46px; z-index: 5; display: flex; flex-direction: column; min-width: 180px; padding: 4px; }
.menu { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
.menu[hidden], .find[hidden] { display: none; }
.menu button { text-align: left; padding: 8px 10px; border-radius: 6px; font-size: 13px; }
.menu button:hover { background: var(--bg); }
.find { display: flex; align-items: center; gap: 10px; padding: 8px 24px; border-bottom: 1px solid var(--border); }
.find input { flex: 1; max-width: 420px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface); font: inherit; }
#screen-toggle[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.screen { width: min(46vw, 640px); flex: none; border-left: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; background: var(--surface); }
.screen > header { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); min-height: 52px; }
.screen > header .x { margin-left: auto; font-size: 20px; color: var(--muted); width: 28px; }
.screen-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.screen-body iframe { flex: 1; min-height: 320px; width: 100%; border: 0; border-radius: 10px; background: #000; }
.files { display: flex; flex-direction: column; }
.files .file { width: 100%; text-align: left; background: none; cursor: pointer; }
.setting { max-width: 640px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
.setting h2.group { margin: 0 0 8px; }
.setting .fields { display: flex; gap: 14px; flex-wrap: wrap; margin: 12px 0; }
.setting label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--soft); }
.setting select { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); color: inherit; font: inherit; }
.setting > label { margin-bottom: 12px; }
.runs { padding: 4px 14px 12px 52px; }
.setting input { width: 140px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); font: inherit; }
.side h2.group { display: flex; align-items: center; justify-content: space-between; }
.side h2.group button { width: 22px; height: 22px; border-radius: 6px; color: var(--muted); font-size: 16px; line-height: 1; }
.side h2.group button:hover { background: var(--surface); color: var(--text); }
body[data-view="chat"] #view-title { cursor: pointer; }
.setting label { width: 100%; }
.setting label input:not([type]), .setting textarea { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--bg); font: inherit; }
.setting textarea { min-height: 120px; resize: vertical; }
.panel .setting { border: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; max-width: none; }
.panel .setting .act-primary { align-self: flex-start; }
.toolgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 12px; margin-top: 8px; }
.toolgrid .tool { flex-direction: row; align-items: center; gap: 6px; font-size: 12.5px; color: var(--soft); }
.toolgrid input { width: auto; }
.card-need, .card-stuck, .card-plain { align-self: flex-start; max-width: 82%; border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.card-need { background: var(--warn-soft); }
.card-stuck { background: var(--bad-soft); }
.card-plain { background: var(--surface); border: 1px solid var(--border); min-width: 260px; }
.card-head { font-weight: 600; }
.card-code { display: block; background: var(--surface); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
.card-need .acts { flex-wrap: wrap; }
.card-need input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--surface); font: inherit; }
.card-need a.act-primary { text-decoration: none; }
.msg-tools { display: none; gap: 4px; margin-top: 6px; }
.msg:hover .msg-tools, .msg-me:hover .msg-tools, .msg:focus-within .msg-tools, .msg-me:focus-within .msg-tools { display: flex; }
.msg-tools button { font-size: 11px; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--muted); }
.msg-me .msg-tools button { background: transparent; color: inherit; border-color: rgba(255,255,255,.3); }
.embed { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 5; background: rgba(31,26,23,.18); }
button.row { width: 100%; text-align: left; }
.setting .row .why, .list button.row .why { white-space: normal; }
.setup-step { display: flex; align-items: center; gap: 10px; }
.setup-done { color: var(--ok); width: 16px; } .setup-todo { color: var(--muted); width: 16px; }
.fact { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; }
.fact:first-of-type { border-top: 0; } .fact span:last-child { text-align: right; overflow-wrap: anywhere; }
.scrim { position: fixed; inset: 0; background: rgba(31,26,23,.18); }
.panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(600px, calc(100vw - 24px)); background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 18px 50px rgba(31,26,23,.16); display: flex; flex-direction: column; }
.panel > header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.panel > header .tabs { margin-left: auto; }
#member > header .x { margin-left: auto; }
.panel > header .x { font-size: 20px; color: var(--muted); width: 28px; }
.panel .inner { padding: 18px; overflow: auto; flex: 1; }
.panel h3 { font-size: 18px; margin: 0 0 6px; overflow-wrap: anywhere; }
.panel .asked { color: var(--soft); margin: 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9em; overflow: auto; }
.needbox { background: var(--warn-soft); border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; }
.needbox .acts { margin-top: 10px; flex-wrap: wrap; }
.needbox textarea { width: 100%; margin-top: 10px; min-height: 64px; border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px; font: inherit; background: var(--surface); }
.file { display: flex; justify-content: space-between; gap: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 6px 0; font-size: 13px; text-decoration: none; }
.file span:last-child { color: var(--muted); flex: none; }
.tallies { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin: 8px 0; }
.tally { border: 1px solid var(--border); border-radius: 10px; padding: 10px; }
.tally b { display: block; font-size: 20px; }
.tally small { color: var(--muted); display: block; }
.budget { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--bg); border-radius: 10px; padding: 10px 12px; margin: 8px 0; font-size: 13px; }
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { display: flex; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border); font-size: 13px; }
.steps li:first-child { border-top: 0; }
.steps .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.steps time, .steps .flag { color: var(--muted); flex: none; }
.steps .flag.bad { color: var(--bad); }
.foot-links { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 10px; font-size: 13px; max-width: 80vw; }
@media (max-width: 720px) {
  body { flex-direction: column; }
  .side { width: 100%; border-right: 0; border-bottom: 1px solid var(--border); }
  .side { max-height: none; flex: 1; }
  body[data-open="1"] .side { display: none; }
  .screen { position: fixed; inset: 0; width: auto; z-index: 2; }
  body:not([data-open="1"]) main { display: none; }
  header.bar { padding: 8px 14px; flex-wrap: wrap; } .view { padding: 14px; } .composer { padding: 8px 14px 12px; }
  .row { flex-wrap: wrap; } .when { display: none; }
  .board { grid-template-columns: 1fr; }
  .panel { inset: 0; width: auto; border-radius: 0; }
  .back { display: inline-flex !important; }
}
.back { display: none; padding: 4px 8px; border-radius: 8px; color: var(--muted); }
`;

export const NEXT_HTML = `<!doctype html>
<html lang="{{@lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ui.next.title}}</title>
<link rel="icon" href="data:,">
<script src="/vendor/markdown-it.js"></script>
<style>${STYLE}</style>
</head>
<body>
<script>
// Before anything is drawn: the theme the person chose, else the one their system asks for. The key is the classic page's.
(function () {
  var saved = null; try { saved = localStorage.getItem("lumen-theme"); } catch (error) {}
  var dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
</script>
<nav class="side" aria-label="{{ui.next.nav.label}}">
  <div class="brand"><span class="logo" aria-hidden="true">L</span>{{ui.next.title}}</div>
  <div class="boxes" id="boxes" aria-label="{{ui.next.side.boxes}}"></div>
  <div class="box-notice" id="box-notice" hidden></div>
  <button class="needs" id="needs" data-nav="inbox" hidden></button>
  <h2 class="group">{{ui.next.side.label}}<button id="agent-new" aria-label="{{ui.next.member.add}}" title="{{ui.next.member.add}}">+</button></h2>
  <div class="agents" id="agents"></div>
  <div class="side-links">
    <button data-nav="work">{{ui.next.side.work}}</button>
    <button data-nav="auto">{{ui.next.side.auto}}</button>
    <button data-nav="boxes">{{ui.next.side.boxes2}}</button>
    <button data-nav="settings">{{ui.next.side.settings}}</button>
    <div class="side-foot">
      <button id="theme" aria-label="{{ui.next.theme}}" title="{{ui.next.theme}}">◐</button>
      <button id="lang">{{ui.next.lang}}</button>
      <a id="classic" href="/?ui=classic">{{ui.next.classic}}</a>
    </div>
  </div>
</nav>
<main>
  <header class="bar">
    <button class="back" id="back" aria-label="{{ui.next.side.label}}">‹</button>
    <h1 id="view-title"></h1><span class="hint" id="view-hint"></span>
    <select id="conversations" aria-label="{{ui.next.chat.conversation}}" hidden></select>
    <button class="act" id="screen-toggle" aria-pressed="false" hidden>{{ui.next.screen.toggle}}</button>
    <button class="act" id="thread-more" aria-label="{{ui.next.thread.more}}" title="{{ui.next.thread.more}}" hidden>⋯</button>
    <div class="menu" id="thread-menu" hidden>
      <button id="thread-find">{{ui.next.thread.find}}</button>
      <button id="thread-export">{{ui.next.thread.export}}</button>
      <button id="thread-link">{{ui.next.thread.link}}</button>
    </div>
    <div class="tools" id="work-tools" hidden>
      <button class="seg" data-layout="list" aria-pressed="true">{{ui.next.view.list}}</button>
      <button class="seg" data-layout="board" aria-pressed="false">{{ui.next.view.board}}</button>
    </div>
  </header>
  <div class="find" id="find" hidden>
    <input id="find-text" placeholder="{{ui.next.thread.findPlaceholder}}" aria-label="{{ui.next.thread.find}}">
    <span class="why" id="find-count"></span>
    <button id="find-close" aria-label="{{ui.next.card.dismiss}}">×</button>
  </div>
  <section class="view" id="view"></section>
  <div class="composer" id="composer" hidden>
    <form id="composer-form"><textarea id="composer-text" rows="1"></textarea><button class="act-primary" id="composer-send" type="submit">{{ui.next.act.send}}</button></form>
  </div>
</main>
<aside class="screen" id="screen" aria-label="{{ui.next.screen.label}}" hidden>
  <header><span class="tabs"><button class="seg" data-screen="desktop" aria-pressed="true">{{ui.next.screen.desktop}}</button><button class="seg" data-screen="files" aria-pressed="false">{{ui.next.screen.files}}</button></span><button class="x" id="screen-close" aria-label="{{ui.next.act.close}}">×</button></header>
  <div class="screen-body" id="screen-body"></div>
</aside>
<div class="scrim" id="scrim" hidden></div>
<aside class="panel" id="panel" aria-label="{{ui.next.panel.label}}" hidden>
  <header><span class="chip" id="panel-chip"></span><span class="when" id="panel-who"></span>
    <span class="tabs"><button class="seg" data-tab="overview" aria-pressed="true">{{ui.next.tab.overview}}</button><button class="seg" data-tab="diagnostics" aria-pressed="false">{{ui.next.tab.diagnostics}}</button></span>
    <button class="x" id="panel-close" aria-label="{{ui.next.act.close}}">×</button></header>
  <div class="inner" id="panel-inner"></div>
</aside>
<aside class="panel" id="member" aria-label="{{ui.next.member.label}}" hidden>
  <header><b id="member-title"></b><button class="x" id="member-close" aria-label="{{ui.next.act.close}}">×</button></header>
  <div class="inner" id="member-inner"></div>
</aside>
<iframe class="embed" id="embed" title="{{ui.next.side.settings}}" hidden></iframe>
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
  return fetch(path, { headers: { accept: "application/json", "accept-language": "{{@locale}}" } }).then(function (res) {
    return res.json().then(function (body) { if (!res.ok) throw new Error(body && body.error ? body.error : String(res.status)); return body; });
  });
}
function postJson(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "accept-language": "{{@locale}}" }, body: JSON.stringify(body) }).then(function (res) {
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
${NEXT_CHAT_JS}
${NEXT_PANEL_JS}
${NEXT_DIAGNOSTICS_JS}
${NEXT_SCREEN_JS}
${NEXT_SETTINGS_JS}
${NEXT_AUTO_JS}
${NEXT_THREAD_JS}
${NEXT_MEMBER_JS}
${NEXT_BOXES_JS}
${NEXT_CARDS_JS}
${NEXT_SYSTEM_JS}
nextStart();
</script>
</body>
</html>`;
