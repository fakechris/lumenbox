/**
 * What this machine is for (INV-1696, docs/96 §3): the first-run choice, and Settings → This
 * machine (本机) afterwards. The uses, the record and the allowed changes are electron/machine-use.cjs;
 * this file is only what a person reads and clicks.
 *
 * The first-run page is shown by the shell before anything is started — an organisation node has
 * no personal installation, so the personal server cannot be the one to ask. The shell renders it
 * with `firstRunPage` (through first-run-page.ts, a child process, since the shell does not load
 * TypeScript) and talks to it through the preload bridge (`window.lumenboxShell.machine`). The
 * organisation node choice stops at its own step until INV-1697 registers nodes
 * (electron/organisation-node.cjs).
 *
 * The Settings pane is mounted by the bundle beside the page, only in the desktop app: in a browser
 * there is no bridge and no pane, because the use is the machine's, not the installation's.
 */
import { resolveLocale } from "../i18n/locale.ts";
import { localizePage } from "./page-locale.ts";

export const FIRST_RUN_CSS = `
  :root { color-scheme: light dark; --bg:#f7f6f2; --text:#1d1d1b; --muted:#6b6b66; --border:#e3e3df; --accent:#2f6f4f; --pick:#eef5f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0a0e16; --text:#eceae4; --muted:#9a9a92; --border:#2c2c2a; --accent:#7fbf9a; --pick:#14241b; } }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--text);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; -webkit-app-region:drag; }
  .card { width:min(620px,92vw); padding:30px 32px; border:1px solid var(--border); border-radius:14px; -webkit-app-region:no-drag; }
  h1 { margin:0 0 6px; font-size:21px; font-weight:600; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label.use { display:flex; gap:12px; align-items:flex-start; padding:14px 16px; border:1px solid var(--border); border-radius:11px; margin-top:10px; cursor:pointer; }
  label.use:has(input:checked) { border-color:var(--accent); background:var(--pick); }
  label.use input { margin-top:4px; }
  .name { font-weight:600; }
  .about { font-size:13px; color:var(--muted); }
  .row { display:flex; gap:10px; justify-content:flex-end; margin-top:20px; }
  button { padding:9px 18px; font:inherit; font-weight:500; cursor:pointer; border:0; border-radius:9px; background:var(--accent); color:#fff; }
  button.ghost { background:transparent; color:var(--text); border:1px solid var(--border); }
  button:disabled { opacity:.5; cursor:default; }
  .line { margin-top:14px; font-size:13px; color:var(--muted); min-height:18px; }
  .off { display:none; }
`;

export const FIRST_RUN_HTML = `<!doctype html>
<html lang="{{@lang}}">
<head>
<meta charset="utf-8">
<title>{{ui.machine.title}}</title>
<style>/*css*/</style>
</head>
<body>
<div class="card" id="choose">
  <h1>{{ui.machine.title}}</h1>
  <p class="sub">{{ui.machine.lead}}</p>
  <label class="use"><input type="radio" name="use" value="personal" checked><span><div class="name">{{ui.machine.use.personal}}</div><div class="about">{{ui.machine.use.personal-about}}</div></span></label>
  <label class="use"><input type="radio" name="use" value="personal-organisation"><span><div class="name">{{ui.machine.use.personal-organisation}}</div><div class="about">{{ui.machine.use.personal-organisation-about}}</div></span></label>
  <label class="use"><input type="radio" name="use" value="organisation-node"><span><div class="name">{{ui.machine.use.organisation-node}}</div><div class="about">{{ui.machine.use.organisation-node-about}}</div></span></label>
  <p class="sub" style="margin-top:14px">{{ui.machine.only-personal-changes}}</p>
  <div class="row"><button id="go" type="button">{{ui.machine.continue}}</button></div>
  <div class="line" id="line"></div>
</div>
<div class="card off" id="node">
  <h1>{{ui.machine.node-title}}</h1>
  <p class="sub" id="nodepending">{{ui.machine.node-pending}}</p>
  <p class="sub off" id="nodeis">{{ui.machine.node-is}}</p>
  <div class="row"><button class="ghost" id="back" type="button">{{ui.machine.back}}</button></div>
</div>
<script>
(function () {
  var shell = window.lumenboxShell && window.lumenboxShell.machine;
  var WHY = { reinstall: "{{ui.machine.why-reinstall}}", unknown: "{{ui.machine.why-failed}}", refused: "{{ui.machine.why-failed}}", failed: "{{ui.machine.why-failed}}" };
  function $(id) { return document.getElementById(id); }
  function show(id) { $("choose").classList.toggle("off", id !== "choose"); $("node").classList.toggle("off", id !== "node"); }
  if (location.hash === "#node") { show("node"); $("nodepending").classList.add("off"); $("nodeis").classList.remove("off"); $("back").classList.add("off"); return; }
  $("back").onclick = function () { show("choose"); $("line").textContent = ""; };
  $("go").onclick = function () {
    var picked = document.querySelector("input[name=use]:checked");
    if (!shell || !picked) { $("line").textContent = WHY.failed; return; }
    $("go").disabled = true;
    $("line").textContent = "{{ui.machine.starting}}";
    shell.choose(picked.value).then(function (a) {
      $("go").disabled = false;
      if (a.error) { $("line").textContent = WHY[a.error] || WHY.failed; return; }
      if (a.step === "node") { $("line").textContent = ""; show("node"); }
    });
  };
})();
</script>
</body>
</html>
`;

/** The first-run page in the language the system asks for (`zh-CN,en` — an Accept-Language list). */
export function firstRunPage(languages: string | undefined): string {
  const locale = resolveLocale(languages ? { acceptLanguage: languages } : {});
  return localizePage(FIRST_RUN_HTML.replace("/*css*/", FIRST_RUN_CSS), locale);
}

/**
 * Settings → This machine: the use, one sentence of what it means, and the changes allowed —
 * personal machine → personal + organisation (join one, in Settings → Organisations), and back
 * (disconnect every organisation). The organisation node is not offered: it is a reinstall.
 */
export const MACHINE_JS = `(function () {
  var shell = window.lumenboxShell && window.lumenboxShell.machine;
  if (!shell) return;
  var NAME = { personal: "{{ui.machine.use.personal}}", "personal-organisation": "{{ui.machine.use.personal-organisation}}", "organisation-node": "{{ui.machine.use.organisation-node}}" };
  var ABOUT = { personal: "{{ui.machine.use.personal-about}}", "personal-organisation": "{{ui.machine.use.personal-organisation-about}}", "organisation-node": "{{ui.machine.use.organisation-node-about}}" };
  var HOW = { "first-run": "{{ui.machine.how-first-run}}", upgrade: "{{ui.machine.how-upgrade}}", settings: "{{ui.machine.how-settings}}" };
  var WHY = { reinstall: "{{ui.machine.why-reinstall}}", unknown: "{{ui.machine.why-failed}}", refused: "{{ui.machine.why-failed}}", failed: "{{ui.machine.why-failed}}" };
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  var ui = {};
  function joinNext() { if (typeof openSettings === "function") openSettings("organisations"); }
  function render(a) {
    ui.body.textContent = "";
    ui.body.appendChild(el("div", { style: "font-weight:600", "data-machine-use": a.use }, NAME[a.use] || a.use));
    ui.body.appendChild(el("div", { class: "fieldnote" }, ABOUT[a.use] || ""));
    ui.body.appendChild(el("div", { class: "dim", style: "font-size:12px" }, (HOW[a.how] || "") + " · {{ui.machine.organisations-connected}} " + a.connections));
    var row = el("div", { class: "ui-row ui-gap" });
    if (a.use === "personal") {
      var add = el("button", { class: "btn", type: "button", "data-machine-change": "personal-organisation" }, "{{ui.machine.add-organisation}}");
      add.onclick = function () { shell.change("personal-organisation").then(function (r) { if (r.error) { ui.line.textContent = WHY[r.error] || WHY.failed; return; } load(); joinNext(); }); };
      row.appendChild(add);
    }
    if (a.use === "personal-organisation") {
      var back = el("button", { class: "btn ghost", type: "button", "data-machine-change": "personal" }, "{{ui.machine.back-to-personal}}");
      back.onclick = function () {
        if (a.connections > 0 && back.getAttribute("data-sure") !== "1") { back.setAttribute("data-sure", "1"); back.textContent = "{{ui.machine.back-to-personal-sure}}"; return; }
        shell.change("personal").then(function (r) { ui.line.textContent = r.error ? (WHY[r.error] || WHY.failed) : "{{ui.machine.changed}}"; load(); });
      };
      row.appendChild(back);
    }
    ui.body.appendChild(row);
  }
  function load(first) {
    shell.get().then(function (a) {
      if (a.error) { ui.line.textContent = WHY[a.error] || WHY.failed; return; }
      render(a);
      if (first && a.joinNext) joinNext();
    });
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("machineuse")) return false;
    tabs.appendChild(el("a", { href: "#", class: "tab", "data-settab": "machine" }, "{{ui.pane.machine}}"));
    var wrap = el("div", { class: "field settab-off", "data-settab": "machine", id: "machineuse" });
    wrap.appendChild(el("label", {}, "{{ui.machine.what-this-machine-is-for}}"));
    ui.body = el("div", { class: "ui-gap", id: "machineusebody" });
    ui.line = el("div", { class: "fieldnote", id: "machineuseline" });
    wrap.appendChild(ui.body);
    wrap.appendChild(el("div", { class: "fieldnote" }, "{{ui.machine.only-personal-changes}}"));
    wrap.appendChild(ui.line);
    modal.insertBefore(wrap, modal.querySelector(".actions"));
    // Read again whenever the pane is shown — by its tab or by openSettings("machine") — since a join elsewhere changes it.
    new MutationObserver(function () { if (!wrap.classList.contains("settab-off")) load(); }).observe(wrap, { attributes: true, attributeFilter: ["class"] });
    return true;
  }
  var tries = 0, wait = setInterval(function () {
    if (mount()) { clearInterval(wait); setTimeout(function () { load(true); }, 300); return; }
    if (++tries > 40) clearInterval(wait);
  }, 250);
})();
`;
