/**
 * The web UI, as a single inlined document.
 *
 * Inlined rather than served from disk so the CLI stays one esbuild bundle with no
 * asset paths to resolve, and vanilla JS on purpose: this is an acceptance-testing
 * surface, and a build step for it would be a liability rather than a feature.
 *
 * The embedded script uses string concatenation instead of template literals
 * throughout. It has to: this file is itself a template literal, so an inner
 * "${...}" would be evaluated here rather than shipped to the browser. The one
 * deliberate interpolation is the Markdown options, which belong next to the tests
 * that assert what they guarantee.
 */

import { MARKDOWN_OPTIONS } from "./markdown.ts";

export const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentbox</title>
<style>
  .tab { padding: 2px 9px; border-radius: 4px; text-decoration: none; }
  .tab.on { background: var(--line); color: var(--text); }
  #filespreview pre { white-space: pre-wrap; word-break: break-word; margin: 0; padding: 10px; }
  #filespreview img, #filespreview video { max-width: 100%; display: block; }
  #fileslist .row { padding: 3px 8px; cursor: pointer; }
  #fileslist .row:hover { background: var(--line); }
  #fileslist .row.on { background: var(--line); }
  #filesview.dropping { outline: 2px dashed var(--accent); outline-offset: -4px; }
  :root {
    --bg: #14161a; --panel: #1b1e24; --line: #2a2f38; --text: #e6e9ef;
    --dim: #8b93a1; --accent: #7aa2f7; --warn: #e0af68; --ok: #9ece6a; --err: #f7768e;
  }
  * { box-sizing: border-box; }
  /*
   * Nothing scrolls the document. Each column scrolls inside itself, so reading
   * back through one agent's conversation never moves the desktop out of view.
   *
   * min-height: 0 on the panes and their scrollers is what makes that work: a flex
   * item defaults to min-height auto, so a long conversation or a busy activity
   * feed grows its column past the viewport, the body scrolls instead, and all
   * three columns move together.
   */
  html, body { height: 100%; }
  body {
    margin: 0; overflow: hidden; display: grid;
    grid-template-columns: 232px minmax(340px, 1fr) minmax(420px, 1.05fr);
    font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--text);
  }
  .pane {
    min-width: 0; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; border-right: 1px solid var(--line);
  }
  .pane:last-child { border-right: 0; }
  h2, form, .bar, iframe { flex: none; }
  h2 {
    margin: 0; padding: 11px 14px; font-size: 11px; letter-spacing: .09em;
    text-transform: uppercase; color: var(--dim); border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  h2 .plain { text-transform: none; letter-spacing: 0; }
  .scroll { overflow-y: auto; flex: 1; min-height: 0; }

  .agent {
    padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--line);
    display: flex; gap: 9px; align-items: flex-start;
  }
  .agent:hover { background: #20242b; }
  .agent.on { background: #232935; box-shadow: inset 2px 0 0 var(--accent); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); margin-top: 6px; flex: none; }
  .dot.busy { background: var(--warn); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .agent .nm { font-weight: 600; }
  .agent .ttl { color: var(--dim); font-size: 12px; }

  /* No pre-wrap: the body is rendered Markdown now, so the blocks carry the layout.
     Leaving it on would add a blank line for every newline between two tags. */
  .msg { padding: 11px 16px; border-bottom: 1px solid #21252c; word-break: break-word; }
  .msg .who { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .msg.user .who { color: var(--accent); }
  .msg .body > :first-child { margin-top: 0; }
  .msg .body > :last-child { margin-bottom: 0; }
  .msg .body p { margin: 0 0 8px; }
  .msg .body h1, .msg .body h2, .msg .body h3,
  .msg .body h4, .msg .body h5, .msg .body h6 { margin: 14px 0 6px; font-size: 15px; line-height: 1.3; }
  .msg .body h1 { font-size: 18px; }
  .msg .body h2 { font-size: 16px; }
  .msg .body ul, .msg .body ol { margin: 4px 0 8px; padding-left: 22px; }
  .msg .body li { margin: 2px 0; }
  .msg .body a { color: var(--accent); }
  .msg .body code {
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #1b1f27; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px;
  }
  .msg .body pre {
    margin: 8px 0; padding: 10px 12px; background: #0f1115; border: 1px solid var(--line);
    /* Scroll long lines rather than wrapping them: wrapped code misreads. */
    border-radius: 6px; overflow-x: auto; word-break: normal;
  }
  .msg .body pre code { background: none; border: 0; padding: 0; }
  .msg .body blockquote {
    margin: 6px 0; padding: 2px 0 2px 12px; border-left: 2px solid var(--line); color: var(--dim);
  }
  .msg .body hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
  /* Full width and wrapping cells, rather than a scrolling block: these tables are
     mostly long prose in two columns, and wrapping keeps all of it on screen. */
  .msg .body table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 13px; }
  .msg .body th, .msg .body td {
    border: 1px solid var(--line); padding: 5px 8px; text-align: left; vertical-align: top;
  }
  .msg .body th { background: #1b1f27; font-weight: 600; }
  /* Tool calls collapse to one line. A turn can make dozens, each result can be pages
     long, and shown in full the conversation becomes a log with the reasoning buried
     in it. The summary is the call; arguments, output and screenshot are one click in. */
  .tool { padding: 4px 16px; color: var(--dim); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tool .nm { color: var(--accent); }
  details.tool > summary {
    cursor: pointer; list-style: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  details.tool > summary::-webkit-details-marker { display: none; }
  details.tool > summary::before { content: "\25b8  "; }
  details.tool[open] > summary::before { content: "\25be  "; }
  details.tool > summary:hover { color: var(--text); }
  details.tool .det {
    white-space: pre-wrap; word-break: break-word; color: var(--text);
    padding: 5px 0 6px 15px; opacity: .9;
  }
  details.tool.err > summary, details.tool.err .det { color: var(--err); }
  /* A teammate message: a one-line hint naming the agent, not the message body.
     The text is there when you open it. */
  details.note > summary { color: var(--ok); }
  .note .chip {
    background: #232935; border: 1px solid var(--line); border-radius: 9px;
    padding: 0 7px; color: var(--text);
  }
  .shot { display: block; max-width: 100%; margin: 8px 0 2px; border: 1px solid var(--line); border-radius: 4px; }
  form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
  textarea {
    flex: 1; resize: none; height: 62px; padding: 9px 11px; border-radius: 6px;
    border: 1px solid var(--line); background: #0f1115; color: var(--text); font: inherit;
  }
  textarea:focus { outline: 0; border-color: var(--accent); }
  button {
    padding: 0 16px; border-radius: 6px; border: 1px solid var(--line);
    background: #262c36; color: var(--text); font: inherit; cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: default; }

  iframe { width: 100%; border: 0; background: #000; aspect-ratio: 16/10; flex: none; }
  /* The desktop keeps its size no matter how long the activity feed gets. */
  #vnc { min-height: 240px; }
  .feed { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
  .ev { padding: 3px 14px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dim); }
  .ev b { color: var(--text); font-weight: 600; }
  .ev .t { color: #59616e; }
  .ev.mail { color: var(--ok); }
  .ev.err { color: var(--err); }
  .ev.warn { color: var(--warn); }
  .bar { padding: 8px 14px; color: var(--dim); font-size: 12px; border-bottom: 1px solid var(--line); }
  .bar b { color: var(--text); }
  /* One line, because it sits between the desktop and the activity feed. */
  #clipbar { display: flex; gap: 6px; align-items: center; }
  #clipbar input {
    flex: 1; min-width: 0; padding: 3px 7px; border-radius: 4px;
    border: 1px solid var(--line); background: #0f1115; color: var(--text);
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #clipbar button { padding: 2px 9px; font-size: 12px; }
  h2 a { color: var(--accent); text-decoration: none; margin-right: 10px; }
  h2 a#rec.on { color: var(--err); }
  #recordings a { color: var(--accent); text-decoration: none; margin-right: 10px; }
  #recordings a:hover { text-decoration: underline; }
  h2 a:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="pane">
  <h2><span>Agents</span><button id="new" style="padding:2px 9px;font-size:12px">+</button></h2>
  <div class="scroll" id="agents"></div>
</div>

<div class="pane">
  <h2>
    <span id="title">&mdash;</span>
    <span class="plain">
      <span id="round"></span>
      <!-- Only shown while a turn is running: a stop button with nothing to stop invites a click
           that does nothing, and then the real one is not trusted. -->
      <button id="stop" style="display:none;padding:2px 9px;font-size:12px">stop</button>
    </span>
  </h2>
  <!-- Ahead of the conversation on purpose. An agent waiting on consent has stopped working, and a
       person who has to scroll to find that out has been kept waiting by the interface. -->
  <div class="bar" id="approvals" style="display:none;flex-direction:column;align-items:stretch;gap:6px"></div>
  <div class="bar" id="progress" style="display:none;flex-direction:column;align-items:stretch">
    <div id="progresshead"></div>
    <div id="progresslist" style="font-size:12px;opacity:0.85"></div>
  </div>
  <div class="scroll" id="chat"></div>
  <!-- Anchored above the composer so it does not cover what is being typed. -->
  <div id="slashmenu" style="display:none;position:absolute;bottom:64px;left:10px;right:10px;background:var(--panel);border:1px solid var(--line);border-radius:6px;max-height:180px;overflow:auto;z-index:5"></div>
  <form id="form" style="position:relative">
    <textarea id="input" placeholder="Ask this agent to do something.  Enter sends, Shift+Enter for a newline."></textarea>
    <button id="send">Send</button>
  </form>
</div>

<div class="pane">
  <h2>
    <!-- Tabs rather than a third panel: the files view needs the height, and stacking it under a
         150px-tall desktop gave neither enough room to be usable. -->
    <span>
      <a href="#" id="tabdesktop" class="tab on">Desktop</a>
      <a href="#" id="tabfiles" class="tab">Files</a>
      <span id="desktoptitle" class="dim"></span>
    </span>
    <span class="plain">
      <a id="rec" href="#">&#9679; record</a>
      <a id="full" href="#" target="_blank" rel="noopener">open full size</a>
      <span id="boxinfo"></span>
    </span>
  </h2>
  <div id="desktopview">
  <div class="bar" id="model">&mdash;</div>
  <div class="bar" id="recordings" style="display:none"></div>
  <div class="bar" id="clipbar">
    <b>clipboard</b>
    <input id="cliptext" placeholder="text to paste into the box" spellcheck="false">
    <button id="clipin" title="Put this on the box's clipboard, then press Ctrl+V in the desktop">&rarr; box</button>
    <button id="clipout" title="Read the box's clipboard and copy it here">&larr; box</button>
  </div>
  <iframe id="vnc" title="box desktop"></iframe>
  <div class="bar" style="border-top:1px solid var(--line);border-bottom:0">
    Every agent has its own desktop, so they never fight over focus. This shows the
    selected agent's. Click it for keyboard focus, or open it full size — you can
    drive one while the others keep working.
  </div>
  </div>

  <!-- The files view. Two columns: what is there, and what is in the selected one. Previewing in
       place is the whole point — a link that opens markdown in a new tab shows raw text, which is
       what the old version did and why it was useless. -->
  <div id="filesview" style="display:none;flex:1;min-height:0;display:none">
    <div class="bar" id="filesbar">
      <b id="filespath">/home/box/work</b>
      <span class="plain">
        <a href="#" id="filesup">up</a>
        <a href="#" id="filesrefresh">refresh</a>
        <label class="dim" style="cursor:pointer">add file<input id="filesupload" type="file" multiple style="display:none"></label>
      </span>
    </div>
    <div id="filessplit" style="display:flex;flex:1;min-height:0">
      <div class="scroll" id="fileslist" style="width:44%;border-right:1px solid var(--line)"></div>
      <div class="scroll" id="filespreview" style="flex:1"><div class="dim" style="padding:10px">Select a file.</div></div>
    </div>
  </div>
  <h2 style="border-top:1px solid var(--line)">Activity &mdash; all agents</h2>
  <div class="feed" id="feed"></div>
</div>

<script src="/vendor/markdown-it.js"></script>
<script>
"use strict";
// Markdown rendering is markdown-it's job, served from node_modules by this server.
// html:false is what keeps model output inert — see src/web/markdown.ts.
var md = window.markdownit ? window.markdownit(${JSON.stringify(MARKDOWN_OPTIONS)}) : null;

function renderMarkdown(text) {
  var value = String(text == null ? "" : text);
  // If the library did not load, show escaped text rather than nothing. A feed
  // showing raw Markdown is poor; a blank one is useless.
  if (!md) return linkifyWorkPaths("<p>" + esc(value).replace(/\n/g, "<br>") + "</p>");
  // After rendering, not before: markdown-it escapes and structures first, so this is operating on
  // known-safe HTML and cannot be used to inject anything. html:false remains the boundary.
  return linkifyWorkPaths(md.render(value));
}

function $(id) { return document.getElementById(id); }

var agents = [];
var current = null;
var busy = new Set();
/** In-flight assistant text nodes, keyed by agent id, so deltas land in one bubble. */
var live = new Map();
/** The tool row awaiting its result, per agent. */
var openTool = new Map();

function esc(value) {
  return String(value).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function nameOf(id) {
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) return agents[i].name;
  return String(id).slice(0, 8);
}

/**
 * One activity line. The at argument is when it happened; omit it for something now.
 *
 * The clock is there because this history outlives the process: without it, a line from
 * last night's run reads as if it just happened.
 */
function feed(html, cls, at) {
  var el = $("feed");
  var stick = nearBottom(el);
  var when = at ? new Date(at) : new Date();
  var stamp = isNaN(when.getTime())
    ? ""
    : '<span class="t">' + ("0" + when.getHours()).slice(-2) + ":" +
        ("0" + when.getMinutes()).slice(-2) + "</span> ";
  var row = document.createElement("div");
  row.className = "ev " + (cls || "");
  row.innerHTML = stamp + html;
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
}

function renderAgents() {
  var html = "";
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    html += '<div class="agent ' + (a.id === current ? "on" : "") + '" data-id="' + esc(a.id) + '">' +
      '<div class="dot ' + (busy.has(a.id) ? "busy" : "") + '"></div>' +
      '<div style="min-width:0"><div class="nm">' + esc(a.name) + "</div>" +
      '<div class="ttl">' + esc(String(a.title || a.description || "").slice(0, 40)) +
      (a.displayIndex ? ' <span style="opacity:.7">:' + esc(a.displayIndex) + "</span>" : "") +
      "</div></div></div>";
  }
  $("agents").innerHTML = html;
  var nodes = document.querySelectorAll(".agent");
  for (var j = 0; j < nodes.length; j++) {
    nodes[j].onclick = function () { select(this.dataset.id); };
  }
}

function bubble(role, who, text) {
  var el = $("chat");
  var stick = nearBottom(el);
  var div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = '<div class="who">' + esc(who) + '</div><div class="body"></div>';
  var body = div.querySelector(".body");
  body.innerHTML = renderMarkdown(text);
  el.appendChild(div);
  if (stick) el.scrollTop = el.scrollHeight;
  return body;
}

/**
 * A collapsed row: one line of summary, the rest behind a click.
 *
 * Used for tool calls and for teammate messages, which are the two things that arrive
 * in bulk and drown the conversation when shown in full.
 */
/** The argument that identifies a call. Mirrors src/web/transcript.ts for replay. */
function toolDetail(tool, input) {
  var args = input || {};
  if (tool === "bash") return args.command || "";
  if (tool === "SendToAgent") return nameOf(args.target_id || "") + ": " + (args.text || "");
  if (tool === "computer") {
    var actions = args.actions || [];
    var names = [];
    for (var i = 0; i < actions.length; i++) names.push(actions[i].action);
    return names.join(" + ");
  }
  var values = Object.keys(args).map(function (key) { return String(args[key]); });
  return values.length ? values[0] : "";
}

function collapsedRow(cls, summaryHtml, detail) {
  var el = $("chat");
  var stick = nearBottom(el);
  var row = document.createElement("details");
  row.className = "tool " + (cls || "");
  row.innerHTML = "<summary>" + summaryHtml + '</summary><div class="det"></div>';
  // textContent, not innerHTML: this is output from a command or another agent.
  row.querySelector(".det").textContent = String(detail == null ? "" : detail);
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
  return row;
}

/** Appends to an open row's body, for a result that arrives after the call. */
function appendDetail(row, text) {
  if (!row || !text) return;
  var body = row.querySelector(".det");
  body.textContent = body.textContent ? body.textContent + "\n\n" + text : String(text);
}

function toolCall(name, detail, result, isError) {
  var oneLine = String(detail == null ? "" : detail).replace(/\s+/g, " ");
  var row = collapsedRow(
    isError ? "err" : "",
    '<span class="nm">' + esc(name) + "</span> " + esc(oneLine.slice(0, 140)),
    detail
  );
  appendDetail(row, result);
  return row;
}

/**
 * A teammate message as a one-line hint.
 *
 * The established pattern for this is an inline hint — "Messaged [Bob]" — naming the
 * agent rather than quoting what was sent. Following that: the row says who and which
 * direction, and the message itself is one click away.
 */
function peerNote(direction, name, text, priority) {
  var oneLine = String(text == null ? "" : text).replace(/\s+/g, " ");
  return collapsedRow(
    "note",
    "&#9993; " + esc(direction) + ' <span class="chip">' + esc(name) + "</span>" +
      (priority ? " (priority)" : "") + " " + esc(oneLine.slice(0, 60)),
    text
  );
}

/** Points the desktop pane at one agent's own display. */
function showDesktop(id) {
  var agent = null;
  for (var i = 0; i < agents.length; i++) if (agents[i].id === id) agent = agents[i];
  if (!agent || !agent.desktopUrl) {
    $("desktoptitle").textContent = "Desktop";
    $("full").style.display = "none";
    return;
  }
  $("desktoptitle").textContent = agent.name + "'s desktop (:" + agent.displayIndex + ")";
  $("full").href = agent.desktopUrl;
  $("full").style.display = "";
  // Only reload when it is a different desktop: re-setting src restarts noVNC and
  // flashes "Connecting…", so switching back and forth must not thrash it.
  if ($("vnc").getAttribute("src") !== agent.desktopUrl) {
    $("vnc").setAttribute("src", agent.desktopUrl);
  }
}

/**
 * One mapped transcript entry.
 *
 * The server hands over what to show — prose, teammate messages, tool calls, results —
 * because the stored transcript is written for the model and needs a real parse to read
 * as a conversation. See src/web/transcript.ts.
 */
function replayEntry(id, entry) {
  if (entry.kind === "peer") {
    for (var p = 0; p < entry.messages.length; p++) {
      peerNote("from", entry.messages[p].from, entry.messages[p].text, entry.messages[p].priority);
    }
    return;
  }
  if (entry.kind === "tools") {
    for (var t = 0; t < entry.tools.length; t++) {
      var call = entry.tools[t];
      toolCall(call.name, call.detail, call.result, call.isError);
    }
    return;
  }
  bubble(entry.role === "user" ? "user" : "", entry.role === "user" ? "you" : nameOf(id), entry.text);
}

function select(id) {
  current = id;
  $("title").textContent = nameOf(id);
  $("round").textContent = "";
  spend = { input: 0, output: 0 };
  spendLabel = "";
  roundLabel = "";
  renderAgents();
  showDesktop(id);
  $("chat").innerHTML = "";
  live.delete(id);

  return fetch("/api/transcript?agent=" + encodeURIComponent(id))
    .then(function (r) { return r.json(); })
    .then(function (entries) {
      for (var i = 0; i < entries.length; i++) replayEntry(id, entries[i]);
      $("chat").scrollTop = $("chat").scrollHeight;
    });
}

function refresh() {
  return fetch("/api/state").then(function (r) { return r.json(); }).then(function (state) {
    agents = state.agents;
    $("model").innerHTML = "<b>model</b> " + esc(state.provider);
    $("boxinfo").textContent = state.box.ok ? state.box.detail : "unavailable";
    if (!current && agents.length) return select(agents[0].id);
    renderAgents();
    // A newly created agent gets its display assigned server-side; keep the pane
    // in step without reloading an unchanged one.
    if (current) showDesktop(current);
    return Promise.all([refreshPolicy(), refreshProgress(), refreshSkills()]);
  });
}

// Every few seconds, because an approval and a ticked-off todo both arrive without an event to ride
// on. Slow enough to be free, fast enough that a person is not kept waiting by the interface.
setInterval(function () { refreshPolicy(); refreshProgress(); }, 4000);
// Skills change when someone writes one, which is rare. Slow enough to be free.
setInterval(refreshSkills, 30000);
// Only while the files tab is open: polling a listing nobody is looking at is work for nothing.
setInterval(function () {
  if ($("filesview").style.display !== "none") refreshFiles();
}, 15000);

/**
 * Anything waiting on a person, and the selected agent's plan.
 *
 * Polled rather than pushed. An approval is created by a turn that then *stops*, so there is no
 * stream of events to ride on — and the alternative to polling is a person watching an agent do
 * nothing while its request sits unseen on the server. Cheap: two small reads every few seconds.
 */
function refreshPolicy() {
  return fetch("/api/policy")
    .then(function (r) { return r.json(); })
    .then(function (state) { renderApprovals(state.pending || []); })
    .catch(function () { /* a dropped poll is not worth a message; the next one covers it */ });
}

function renderApprovals(pending) {
  var box = $("approvals");
  if (!pending.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "";
  box.innerHTML = pending.map(function (item) {
    // The exact text the fingerprint was taken over. Not a summary of it: consent is given to what
    // is read here, so anything shortened would be consent to something else.
    return '<div style="display:flex;gap:8px;align-items:flex-start">' +
      '<b style="color:var(--warn)">approve?</b>' +
      '<code style="flex:1;white-space:pre-wrap;word-break:break-all">' + esc(item.description) + '</code>' +
      '<button data-approve="' + esc(item.id) + '">allow</button>' +
      '<button data-deny="' + esc(item.id) + '">deny</button>' +
      '</div>';
  }).join("");
}

document.getElementById("approvals").addEventListener("click", function (event) {
  var allow = event.target.getAttribute && event.target.getAttribute("data-approve");
  var deny = event.target.getAttribute && event.target.getAttribute("data-deny");
  if (!allow && !deny) return;
  event.target.disabled = true;
  fetch(allow ? "/api/approve" : "/api/deny", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: allow || deny })
  }).then(function () {
    feed(allow ? "you allowed an action" : "you denied an action", "warn");
    // The agent does not resume by itself: it was told to stop and ask. Say so, rather than
    // leaving a person waiting for something that is not coming.
    if (allow) feed("send the agent a message to have it retry the approved action", "");
    return refreshPolicy();
  });
});

document.getElementById("stop").addEventListener("click", function () {
  if (!current) return;
  $("stop").disabled = true;
  fetch("/api/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current })
  }).then(function () {
    // It takes effect at the next round boundary, not instantly — aborting mid-request would leave
    // a tool call with no result. Said here so the delay does not read as the button not working.
    feed("stopping " + esc(nameOf(current)) + " at the end of this round", "warn");
  }).finally(function () { $("stop").disabled = false; });
});

/** The selected agent's plan and todo list, which is what a long task's progress looks like. */
function refreshProgress() {
  if (!current) return Promise.resolve();
  return fetch("/api/progress?agent=" + encodeURIComponent(current))
    .then(function (r) { return r.json(); })
    .then(function (state) {
      var head = $("progresshead");
      var list = $("progresslist");
      var todos = state.todos || [];
      var hasPlan = !!(state.plan && state.plan.trim());
      if (!hasPlan && !todos.length) {
        $("progress").style.display = "none";
        return;
      }
      $("progress").style.display = "";
      var done = todos.filter(function (t) { return t.status === "done"; }).length;
      head.innerHTML = "<b>plan</b> " + (hasPlan ? esc(state.plan.split("\n")[0]) : "&mdash;") +
        (todos.length ? ' <span class="plain">' + done + "/" + todos.length + " done</span>" : "");
      list.innerHTML = todos.map(function (t) {
        var mark = t.status === "done" ? "&#10003;" : t.status === "doing" ? "&rarr;" :
          t.status === "blocked" ? "&#9888;" : "&middot;";
        var dim = t.status === "done" ? "opacity:0.5;text-decoration:line-through" : "";
        return '<div style="' + dim + '">' + mark + " " + esc(t.text) + "</div>";
      }).join("");
    })
    .catch(function () {});
}

/**
 * What the agents have produced, as something a person can actually read.
 *
 * The first version of this was a flat list of links in a 150px box. Clicking one opened a new tab,
 * which for markdown — the most common thing an agent writes — shows raw text. So the panel existed
 * and was still useless, which is worse than absent: it looks like the problem was solved.
 *
 * Three things fix it, and none of them needed a desktop app:
 *
 *   - **Preview in place.** Markdown rendered, images and video shown, text and CSV readable. The
 *     point of handing a file over is that someone reads it.
 *   - **Newest first.** "What did the agent just make" is the question people have; alphabetical
 *     order answers a different one.
 *   - **Room.** A tab rather than a strip, so the list and the preview both get height.
 */
var filesDir = "/home/box/work";
var filesSelected = null;

function fileKind(name) {
  var ext = (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  if (/^\.(png|jpe?g|webp|gif|svg|bmp|ico)$/.test(ext)) return "image";
  if (/^\.(mp4|webm|mov)$/.test(ext)) return "video";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (/^\.(txt|log|json|csv|tsv|ya?ml|toml|ini|conf|sh|py|js|ts|tsx|jsx|html?|css|xml|sql|rs|go|java|rb|c|h|cpp|diff|patch)$/.test(ext)) return "text";
  if (ext === ".pdf") return "pdf";
  return "binary";
}

function fmtBytes(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fmtWhen(iso) {
  if (!iso) return "";
  var then = new Date(iso).getTime();
  if (!then) return "";
  var secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return Math.round(secs / 60) + "m ago";
  if (secs < 86400) return Math.round(secs / 3600) + "h ago";
  return Math.round(secs / 86400) + "d ago";
}

function fileUrl(path, download) {
  return "/api/file?" + (download ? "download=1&" : "") + "path=" + encodeURIComponent(path);
}

function refreshFiles(dir) {
  if (dir) { filesDir = dir; filesSelected = null; }
  $("filespath").textContent = filesDir;
  $("filesup").style.visibility = filesDir === "/home/box/work" ? "hidden" : "";
  return fetch("/api/files?dir=" + encodeURIComponent(filesDir))
    .then(function (r) { return r.json(); })
    .then(function (listing) {
      var entries = (listing.entries || []).slice();
      // Directories first, then newest file first. Two sorts rather than one because a folder's own
      // mtime says nothing about what is in it.
      entries.sort(function (a, b) {
        if ((a.type === "directory") !== (b.type === "directory")) return a.type === "directory" ? -1 : 1;
        if (a.type === "directory") return a.name.localeCompare(b.name);
        return String(b.modified || "").localeCompare(String(a.modified || ""));
      });
      if (!entries.length) {
        $("fileslist").innerHTML = '<div class="dim" style="padding:10px">Nothing here yet. Agents write to this directory; you can drop a file in.</div>';
        return;
      }
      $("fileslist").innerHTML = entries.map(function (e) {
        var full = filesDir.replace(/\/$/, "") + "/" + e.name;
        var on = full === filesSelected ? " on" : "";
        var meta = e.type === "directory" ? "" : fmtBytes(e.size) + " · " + fmtWhen(e.modified);
        return '<div class="row' + on + '" data-path="' + esc(full) + '" data-type="' + esc(e.type) + '">' +
          esc(e.name) + (e.type === "directory" ? "/" : "") +
          '<div class="dim" style="font-size:11px">' + esc(meta) + "</div></div>";
      }).join("");
    })
    .catch(function () {
      $("fileslist").innerHTML = '<div class="dim" style="padding:10px">Could not read the work directory.</div>';
    });
}

function previewFile(path) {
  filesSelected = path;
  var name = path.split("/").pop();
  var kind = fileKind(name);
  var head = '<div class="bar" style="border-top:0"><b>' + esc(name) + "</b>" +
    '<span class="plain"><a href="' + fileUrl(path, true) + '">save</a>' +
    '<a href="' + fileUrl(path) + '" target="_blank" rel="noopener">open</a></span></div>';

  if (kind === "image") {
    $("filespreview").innerHTML = head + '<img src="' + fileUrl(path) + '" alt="' + esc(name) + '">';
    return Promise.resolve();
  }
  if (kind === "video") {
    $("filespreview").innerHTML = head + '<video src="' + fileUrl(path) + '" controls></video>';
    return Promise.resolve();
  }
  if (kind === "pdf" || kind === "binary") {
    // Said rather than guessed at: a binary rendered as text is a screen of noise, and pretending to
    // preview it wastes the one action a person came here to take.
    $("filespreview").innerHTML = head +
      '<div class="dim" style="padding:10px">' +
      (kind === "pdf" ? "PDF — open it in a tab, or save it." : "Not a text file. Save it to look at it.") +
      "</div>";
    return Promise.resolve();
  }

  $("filespreview").innerHTML = head + '<div class="dim" style="padding:10px">Loading…</div>';
  return fetch(fileUrl(path))
    .then(function (r) { return r.text(); })
    .then(function (body) {
      // Markdown through the same renderer as the chat, so a report reads the way the agent meant
      // it to. Everything else escaped into a <pre>: it is text, not markup.
      $("filespreview").innerHTML = head +
        (kind === "markdown"
          ? '<div style="padding:10px">' + renderMarkdown(body) + "</div>"
          : "<pre>" + esc(body) + "</pre>");
    })
    .catch(function () {
      $("filespreview").innerHTML = head + '<div class="dim" style="padding:10px">Could not read it.</div>';
    });
}

document.getElementById("fileslist").addEventListener("click", function (event) {
  var row = event.target.closest && event.target.closest(".row");
  if (!row) return;
  var path = row.getAttribute("data-path");
  if (row.getAttribute("data-type") === "directory") return refreshFiles(path);
  previewFile(path);
  refreshFiles();
});

document.getElementById("filesup").addEventListener("click", function (event) {
  event.preventDefault();
  refreshFiles(filesDir.replace(/\/[^/]+$/, "") || "/home/box/work");
});
document.getElementById("filesrefresh").addEventListener("click", function (event) {
  event.preventDefault();
  refreshFiles();
});

/** Sends one file into the work directory. The inverse of a download: giving the agent something. */
function uploadOne(file) {
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result).split(",")[1] || "";
      fetch("/api/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: filesDir.replace(/\/$/, "") + "/" + file.name, base64: base64 })
      })
        .then(function (r) { return r.json(); })
        .then(function (result) {
          feed(result.error
            ? "upload failed: " + esc(result.error)
            : "added " + esc(file.name) + " to " + esc(filesDir), result.error ? "err" : "");
          resolve();
        })
        .catch(function () { resolve(); });
    };
    reader.onerror = function () { resolve(); };
    reader.readAsDataURL(file);
  });
}

function uploadFiles(list) {
  var files = Array.prototype.slice.call(list || []);
  if (!files.length) return Promise.resolve();
  return files.reduce(function (chain, file) {
    return chain.then(function () { return uploadOne(file); });
  }, Promise.resolve()).then(function () { return refreshFiles(); });
}

document.getElementById("filesupload").addEventListener("change", function (event) {
  uploadFiles(event.target.files);
  event.target.value = "";
});

// Drag and drop, because that is how a person expects to hand over a file.
var filesView = document.getElementById("filesview");
["dragenter", "dragover"].forEach(function (name) {
  filesView.addEventListener(name, function (event) {
    event.preventDefault();
    filesView.classList.add("dropping");
  });
});
["dragleave", "drop"].forEach(function (name) {
  filesView.addEventListener(name, function () { filesView.classList.remove("dropping"); });
});
filesView.addEventListener("drop", function (event) {
  event.preventDefault();
  uploadFiles(event.dataTransfer && event.dataTransfer.files);
});

/** Which of the two views the right-hand pane is showing. */
function showTab(which) {
  var files = which === "files";
  $("desktopview").style.display = files ? "none" : "";
  $("filesview").style.display = files ? "flex" : "none";
  $("tabfiles").className = "tab" + (files ? " on" : "");
  $("tabdesktop").className = "tab" + (files ? "" : " on");
  if (files) refreshFiles();
}
document.getElementById("tabdesktop").addEventListener("click", function (e) { e.preventDefault(); showTab("desktop"); });
document.getElementById("tabfiles").addEventListener("click", function (e) { e.preventDefault(); showTab("files"); });

/**
 * Turns a work path an agent mentioned into a link.
 *
 * Agents already say "I wrote /home/box/work/report.md", and that was dead text — the single
 * cheapest thing that was missing. Applied after markdown rendering, and skipped inside an existing
 * anchor so a path already formatted as a link is left alone.
 */
function linkifyWorkPaths(html) {
  return html.replace(/(^|[\s>(\[])(\/home\/box\/work\/[^\s<>)\]"']+)/g, function (all, lead, path) {
    var clean = path.replace(/[.,;:]+$/, "");
    var trailing = path.slice(clean.length);
    return lead + '<a href="/api/file?path=' + encodeURIComponent(clean) +
      '" target="_blank" rel="noopener">' + clean + "</a>" + trailing;
  });
}

/**
 * The composer's "/" menu.
 *
 * Picking a skill inserts its *name* as an ordinary instruction rather than pasting its body. Two
 * reasons: the body can be pages long and nobody wants that in their message, and the agent already
 * has the index in its prompt — so it reads the current version of the file rather than whatever was
 * pasted at the time. A message that carries a stale copy of a recipe is worse than one that names it.
 */
var skills = [];
var slashIndex = 0;

function refreshSkills() {
  return fetch("/api/skills")
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      skills = payload.skills || [];
      // A skill nobody can choose is worth complaining about once, in the feed: the agent silently
      // never picks it, and only the person who wrote it can fix it.
      (payload.problems || []).forEach(function (problem) {
        if (!seenSkillProblems[problem]) {
          seenSkillProblems[problem] = true;
          feed("skill not usable &mdash; " + esc(problem), "warn");
        }
      });
    })
    .catch(function () {});
}
var seenSkillProblems = {};

function slashQuery() {
  var value = $("input").value;
  // Only when "/" opens the message: mid-sentence a slash is a path or a date, and popping a menu
  // over someone typing /home/box/work would be worse than having no menu.
  var match = /^\/([^\s]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

function slashMatches(query) {
  return skills.filter(function (skill) {
    return skill.name.toLowerCase().indexOf(query) >= 0 || skill.slug.indexOf(query) >= 0;
  });
}

function renderSlash() {
  var query = slashQuery();
  var menu = $("slashmenu");
  if (query === null) { menu.style.display = "none"; return; }
  var found = slashMatches(query);
  if (!found.length) {
    menu.style.display = "";
    menu.innerHTML = '<div class="dim" style="padding:8px">' +
      (skills.length ? "No skill matches." : "No skills yet. Ask an agent to write one when it works something out.") +
      "</div>";
    return;
  }
  if (slashIndex >= found.length) slashIndex = 0;
  menu.style.display = "";
  menu.innerHTML = found.map(function (skill, index) {
    return '<div class="row' + (index === slashIndex ? " on" : "") + '" data-skill="' + esc(skill.name) + '" style="padding:5px 9px;cursor:pointer">' +
      "<b>" + esc(skill.name) + "</b>" +
      '<div class="dim" style="font-size:11px">' + esc(skill.description) + "</div></div>";
  }).join("");
}

function chooseSkill(name) {
  $("slashmenu").style.display = "none";
  // Phrased as an instruction, because that is what it is. The agent resolves the name against the
  // index it already has.
  $("input").value = "Use the " + name + " skill.";
  $("input").focus();
}

document.getElementById("slashmenu").addEventListener("mousedown", function (event) {
  var row = event.target.closest && event.target.closest("[data-skill]");
  if (!row) return;
  event.preventDefault();
  chooseSkill(row.getAttribute("data-skill"));
});

// --- live events ----------------------------------------------------------

var stream = new EventSource("/api/events");

/**
 * The activity line for an event, or null if it does not belong in the feed.
 *
 * Shared by the live stream and by the replay of recent activity on load, so a
 * reloaded page reads the same as one that was open the whole time.
 */
function activityLine(e) {
  if (e.type === "prompt") return { html: "<b>you</b> &rarr; " + esc(nameOf(e.agentId)), cls: "" };
  if (e.type === "turn_started") return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> started a turn", cls: "" };
  if (e.type === "tool_start") return { html: "<b>" + esc(e.agentName) + "</b> &rarr; " + esc(e.tool), cls: "" };
  if (e.type === "message_sent") {
    return {
      html: "&#9993; <b>" + esc(e.fromName) + "</b> &rarr; <b>" + esc(e.toName) + "</b>" +
        (e.priority ? " (priority)" : "") + ": " + esc(String(e.text).slice(0, 90)),
      cls: "mail"
    };
  }
  if (e.type === "turn_failed") {
    return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> failed: " + esc(e.error), cls: "err" };
  }
  if (e.type === "turn_interrupted") {
    return { html: "<b>" + esc(nameOf(e.agentId)) + "</b> interrupted (" + esc(e.reason) + ")", cls: "warn" };
  }
  if (e.type === "error") return { html: esc(e.message), cls: "err" };
  return null;
}

/** What happened before this page was opened. The feed used to start blank on reload. */
function loadActivity() {
  return fetch("/api/activity")
    .then(function (r) { return r.json(); })
    .then(function (events) {
      for (var i = 0; i < events.length; i++) {
        var line = activityLine(events[i]);
        if (line) feed(line.html, line.cls, events[i].at);
      }
    })
    .catch(function () { /* an empty feed is not worth an error row */ });
}

/** Tokens as a person reads them: exact until it stops being useful. */
function fmtTokens(n) {
  if (n < 10000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 100000 ? 1 : 0) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

var spend = { input: 0, output: 0 };
var spendLabel = "";
var roundLabel = "";

stream.onmessage = function (raw) {
  var e = JSON.parse(raw.data);
  var line = activityLine(e);
  if (line) feed(line.html, line.cls);

  if (e.type === "prompt") {
    if (e.agentId === current) bubble("user", "you", e.text);
    return;
  }

  if (e.type === "text") {
    if (e.agentId !== current) return;
    var open = live.get(e.agentId);
    if (!open) {
      open = { node: bubble("", e.agentName, ""), text: "", queued: false };
      // Marked while it is still streaming, so a retry can drop it. Cleared when the turn's own
      // message is stored, at which point it is no longer a partial anyone should discard.
      open.node.setAttribute("data-partial", "1");
      live.set(e.agentId, open);
    }
    open.text += e.delta;
    // The whole message has to be re-rendered, not appended to: half a fence is not
    // yet a code block, and a list grows an item at a time. Deltas arrive far faster
    // than the screen refreshes, so paint once per frame instead of once per delta.
    if (!open.queued) {
      open.queued = true;
      requestAnimationFrame(function () {
        open.queued = false;
        var chat = $("chat");
        var stick = nearBottom(chat);
        open.node.innerHTML = renderMarkdown(open.text);
        if (stick) chat.scrollTop = chat.scrollHeight;
      });
    }
    return;
  }

  if (e.type === "tool_start") {
    live.delete(e.agentId);
    // Held so the result can be folded into the same row when it arrives.
    if (e.agentId === current) {
      openTool.set(e.agentId, toolCall(e.tool, toolDetail(e.tool, e.input)));
    }
    return;
  }

  if (e.type === "tool_end") {
    var row = openTool.get(e.agentId);
    openTool.delete(e.agentId);
    if (e.agentId !== current || !row) return;
    appendDetail(row, e.summary);
    if (e.screenshot) {
      var img = document.createElement("img");
      img.className = "shot";
      img.src = "data:image/webp;base64," + e.screenshot;
      // Inside the row, so it appears when opened rather than filling the column.
      row.appendChild(img);
    }
    return;
  }

  if (e.type === "message_sent") {
    // Both sides, in their own chat: the sender's record of messaging a teammate, and
    // the recipient's of being messaged. Without the second, the pane jumps from
    // nothing to a reply and what prompted it only shows up on reload.
    if (e.toId === current) peerNote("from", e.fromName, e.text, e.priority);
    else if (e.fromId === current) peerNote("to", e.toName, e.text, e.priority);
    return;
  }

  if (e.type === "turn_started") {
    busy.add(e.agentId); renderAgents();
    return;
  }

  if (e.type === "turn_finished") {
    // No longer running, so the stop button goes away rather than staying to be clicked at nothing.
    if (e.agentId === current) $("stop").style.display = "none";
    var settled = live.get(e.agentId);
    if (settled) settled.node.removeAttribute("data-partial");
    busy.delete(e.agentId); live.delete(e.agentId); renderAgents();
    // A teammate that just worked may be new to this page, or have new history.
    refresh();
    return;
  }

  if (e.type === "turn_failed") {
    busy.delete(e.agentId); renderAgents();
    return;
  }

  if (e.type === "round") {
    if (e.agentId === current) {
      // A round starting is the clearest signal a turn is live, and the only one that is not a guess.
      $("stop").style.display = "";
      roundLabel = "round " + (e.round + 1);
      $("round").textContent = spendLabel ? roundLabel + " · " + spendLabel : roundLabel;
    }
    return;
  }

  if (e.type === "retrying") {
    // Explained rather than left as a pause. A silent gap while a connection is retried is
    // indistinguishable from a hang, and a person watching one reaches for the reload button.
    feed(
      "<b>" + esc(nameOf(e.agentId)) + "</b> retrying round " + (e.round + 1) +
        " in " + Math.round(e.delayMs / 100) / 10 + "s &mdash; " + esc(e.detail),
      "warn"
    );
    if (e.agentId === current && e.discardPartial) {
      // The partial answer exists only here: nothing was written to the transcript, so dropping it
      // is what stops the retry showing the same text twice.
      var last = $("chat").lastElementChild;
      if (last && last.getAttribute("data-partial") === "1") last.remove();
    }
    return;
  }

  if (e.type === "usage") {
    // Shown while it is being spent, not after: a turn that is costing more than it should is
    // something to notice during, and this is the only number that says so.
    if (e.agentId !== current) return;
    spend.input += e.inputTokens;
    spend.output += e.outputTokens;
    spendLabel = fmtTokens(spend.input) + " in / " + fmtTokens(spend.output) + " out";
    $("round").textContent = roundLabel ? roundLabel + " · " + spendLabel : spendLabel;
    return;
  }

};

stream.onerror = function () {
  feed("event stream dropped &mdash; reload the page to reconnect", "err");
};

// --- input ----------------------------------------------------------------

$("form").onsubmit = function (event) {
  event.preventDefault();
  var text = $("input").value.trim();
  if (!text || !current) return;
  $("input").value = "";
  $("send").disabled = true;
  fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, text: text })
  }).then(function (res) {
    if (!res.ok) return res.text().then(function (t) { feed("prompt rejected: " + esc(t), "err"); });
  }).catch(function (error) {
    feed("prompt failed: " + esc(error.message), "err");
  }).then(function () {
    $("send").disabled = false;
    $("input").focus();
  });
};

// Enter is overloaded, and an IME has the stronger claim on it: while composing,
// Enter accepts the candidate. That keydown reaches the page looking like a
// deliberate send, and sending on it throws away a half-composed sentence — the
// characters chosen so far go out as the message and the rest of the thought is
// lost. Anyone typing Chinese, Japanese or Korean hits this on their first line.
var composing = false;
var compositionEndedAt = 0;

$("input").addEventListener("compositionstart", function () {
  composing = true;
});
$("input").addEventListener("compositionend", function () {
  composing = false;
  compositionEndedAt = Date.now();
});

$("input").addEventListener("input", function () {
  slashIndex = 0;
  renderSlash();
});

$("input").onkeydown = function (event) {
  // The slash menu takes the arrow keys and Enter while it is open, and nothing else — Escape
  // closes it so a person who opened it by accident is not trapped.
  var menu = $("slashmenu");
  if (menu.style.display !== "none" && slashQuery() !== null) {
    var found = slashMatches(slashQuery());
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : -1) + found.length) % Math.max(1, found.length);
      renderSlash();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      menu.style.display = "none";
      return;
    }
    // Enter picks, but never mid-composition: an IME accepting a candidate sends the same key, and
    // stealing it would make the menu unusable for anyone typing Chinese.
    if (event.key === "Enter" && !event.shiftKey && found.length > 0) {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (Date.now() - compositionEndedAt < 50) return;
      event.preventDefault();
      chooseSkill(found[slashIndex].name);
      return;
    }
  }

  if (event.key !== "Enter" || event.shiftKey) return;

  // isComposing is the standard signal (Chrome, Firefox, Edge); keyCode 229 is the
  // older one some IMEs still send; the flag covers anything that sets neither.
  if (event.isComposing || event.keyCode === 229 || composing) return;

  // Safari delivers the accepting Enter *after* compositionend with isComposing
  // false, so none of the checks above can see it. Nothing legitimate arrives this
  // fast: a second, deliberate Enter needs the key released and pressed again.
  if (Date.now() - compositionEndedAt < 50) return;

  event.preventDefault();
  $("form").requestSubmit();
};

/**
 * The box's clipboard, in both directions.
 *
 * The desktop is a VNC canvas, so text cannot be typed into it from here and text copied
 * inside it cannot be got out. Writing puts it on the box's CLIPBOARD selection, ready
 * for a Ctrl+V in the desktop; reading pulls it back and, where the browser allows it,
 * onto the host clipboard too — the click is the user gesture that permission needs.
 */
function clipboard(text) {
  var body = { agent: current };
  if (text !== undefined) body.text = text;
  return fetch("/api/clipboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "clipboard failed");
      return data;
    });
  });
}

function flashButton(button, label) {
  var original = button.textContent;
  button.textContent = label;
  setTimeout(function () { button.textContent = original; }, 1200);
}

$("clipin").onclick = function () {
  if (!current) return;
  var text = $("cliptext").value;
  if (!text) return;
  clipboard(text).then(function () {
    flashButton($("clipin"), "on the box");
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

$("clipout").onclick = function () {
  if (!current) return;
  clipboard().then(function (data) {
    $("cliptext").value = data.text;
    if (!data.text) {
      flashButton($("clipout"), "empty");
      return;
    }
    // Best effort: this needs a secure context and permission, and the field is
    // already filled either way, so a refusal is not worth an error row.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(data.text).then(function () {
        flashButton($("clipout"), "copied here");
      }, function () {
        flashButton($("clipout"), "in the field");
      });
    } else {
      flashButton($("clipout"), "in the field");
    }
  }).catch(function (error) {
    feed("clipboard: " + esc(error.message), "err");
  });
};

/**
 * Recording the desktop.
 *
 * A transcript says what an agent claims it did and a screenshot shows one instant;
 * neither answers "what did it actually do" after the screen has moved on. The file
 * lands on the box's work volume, so it outlives the container, and opens in a tab
 * rather than an embedded player — the browser plays fragmented MP4 natively.
 */
var recording = null;

function renderRecordings(list) {
  var box = $("recordings");
  if (!list || !list.length) {
    box.style.display = "none";
    return;
  }
  var html = "<b>recordings</b> ";
  for (var i = 0; i < Math.min(list.length, 6); i++) {
    var item = list[i];
    var size = item.size_bytes ? Math.round(item.size_bytes / 1024) + "KB" : "recording…";
    html += '<a href="/recording?name=' + encodeURIComponent(item.file) + '" target="_blank"' +
      ' rel="noopener">' + esc(item.file.replace(/\.mp4$/, "")) + " (" + size + ")</a>";
  }
  box.innerHTML = html;
  box.style.display = "";
}

function loadRecordings() {
  return fetch("/api/recordings")
    .then(function (r) { return r.json(); })
    .then(function (data) { renderRecordings(data.recordings); })
    .catch(function () { /* the box may be down; the pane just stays hidden */ });
}

$("rec").onclick = function (event) {
  event.preventDefault();
  if (!current) return;
  var starting = recording === null;
  var link = $("rec");
  link.textContent = starting ? "starting…" : "stopping…";

  fetch("/api/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: current, action: starting ? "start" : "stop" })
  }).then(function (r) {
    return r.json().then(function (data) {
      if (!r.ok) throw new Error(data.error || "failed");
      return data;
    });
  }).then(function (data) {
    recording = starting ? data.file : null;
    link.textContent = starting ? "\u25a0 stop" : "\u25cf record";
    link.className = starting ? "on" : "";
    if (!starting) feed("recording saved: " + esc(data.file), "mail");
    return loadRecordings();
  }).catch(function (error) {
    link.textContent = "\u25cf record";
    link.className = "";
    recording = null;
    feed("recording: " + esc(error.message), "err");
  });
};

$("new").onclick = function () {
  var name = prompt("Agent name?");
  if (!name) return;
  var description = prompt("What is this agent for? (becomes its system prompt)") || "";
  fetch("/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name, description: description })
  }).then(refresh);
};

// Activity after the roster, because its lines name agents.
refresh().then(loadActivity).then(loadRecordings);
setInterval(refresh, 15000);
</script>
</body>
</html>`;
