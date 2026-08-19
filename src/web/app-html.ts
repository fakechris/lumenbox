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
  .ev.mail { color: var(--ok); }
  .ev.err { color: var(--err); }
  .ev.warn { color: var(--warn); }
  .bar { padding: 8px 14px; color: var(--dim); font-size: 12px; border-bottom: 1px solid var(--line); }
  .bar b { color: var(--text); }
  h2 a { color: var(--accent); text-decoration: none; margin-right: 10px; }
  h2 a:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="pane">
  <h2><span>Agents</span><button id="new" style="padding:2px 9px;font-size:12px">+</button></h2>
  <div class="scroll" id="agents"></div>
</div>

<div class="pane">
  <h2><span id="title">&mdash;</span><span class="plain" id="round"></span></h2>
  <div class="scroll" id="chat"></div>
  <form id="form">
    <textarea id="input" placeholder="Ask this agent to do something.  Enter sends, Shift+Enter for a newline."></textarea>
    <button id="send">Send</button>
  </form>
</div>

<div class="pane">
  <h2>
    <span id="desktoptitle">Desktop</span>
    <span class="plain">
      <a id="full" href="#" target="_blank" rel="noopener">open full size</a>
      <span id="boxinfo"></span>
    </span>
  </h2>
  <div class="bar" id="model">&mdash;</div>
  <iframe id="vnc" title="box desktop"></iframe>
  <div class="bar" style="border-top:1px solid var(--line);border-bottom:0">
    Every agent has its own desktop, so they never fight over focus. This shows the
    selected agent's. Click it for keyboard focus, or open it full size — you can
    drive one while the others keep working.
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
  if (!md) return "<p>" + esc(value).replace(/\n/g, "<br>") + "</p>";
  return md.render(value);
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

function feed(html, cls) {
  var el = $("feed");
  var stick = nearBottom(el);
  var row = document.createElement("div");
  row.className = "ev " + (cls || "");
  row.innerHTML = html;
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
  });
}

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
        if (line) feed(line.html, line.cls);
      }
    })
    .catch(function () { /* an empty feed is not worth an error row */ });
}

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
    if (e.agentId === current) $("round").textContent = "round " + (e.round + 1);
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

$("input").onkeydown = function (event) {
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
refresh().then(loadActivity);
setInterval(refresh, 15000);
</script>
</body>
</html>`;
