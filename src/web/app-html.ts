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
 * deliberate interpolation is the Markdown renderer, injected as source text.
 */

import { renderMarkdown } from "./markdown.ts";

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
  .tool { padding: 5px 16px; color: var(--dim); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tool .nm { color: var(--accent); }
  .tool.res { padding-left: 30px; opacity: .85; }
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

<script>
"use strict";
// The Markdown renderer, shipped as its own source. It lives in a module so it can
// be unit-tested — escaping model output is not something to verify by eye — and is
// injected rather than inlined because Markdown means matching backticks, which
// cannot be written inside this template literal.
var renderMarkdown = ${String(renderMarkdown)};

function $(id) { return document.getElementById(id); }

var agents = [];
var current = null;
var busy = new Set();
/** In-flight assistant text nodes, keyed by agent id, so deltas land in one bubble. */
var live = new Map();

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

function toolRow(html, cls) {
  var el = $("chat");
  var stick = nearBottom(el);
  var row = document.createElement("div");
  row.className = "tool " + (cls || "");
  row.innerHTML = html;
  el.appendChild(row);
  if (stick) el.scrollTop = el.scrollHeight;
  return row;
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
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        bubble(e.role === "user" ? "user" : "", e.role === "user" ? "you" : nameOf(id), e.text);
      }
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

stream.onmessage = function (raw) {
  var e = JSON.parse(raw.data);

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
    var input = e.input || {};
    var detail = "";
    if (e.tool === "bash") detail = input.command || "";
    else if (e.tool === "SendToAgent") detail = nameOf(input.target_id || "");
    else if (e.tool === "computer") {
      var acts = input.actions || [];
      var parts = [];
      for (var i = 0; i < acts.length; i++) parts.push(acts[i].action);
      detail = parts.join(" + ");
    } else {
      var values = Object.keys(input).map(function (k) { return String(input[k]); });
      detail = values.length ? values[0] : "";
    }
    if (e.agentId === current) {
      toolRow('&rarr; <span class="nm">' + esc(e.tool) + "</span> " + esc(String(detail).slice(0, 200)));
    }
    feed("<b>" + esc(e.agentName) + "</b> &rarr; " + esc(e.tool));
    return;
  }

  if (e.type === "tool_end") {
    if (e.agentId === current && (e.summary || e.screenshot)) {
      var row = toolRow(esc(e.summary || ""), "res");
      if (e.screenshot) {
        var img = document.createElement("img");
        img.className = "shot";
        img.src = "data:image/webp;base64," + e.screenshot;
        row.appendChild(img);
        $("chat").scrollTop = $("chat").scrollHeight;
      }
    }
    return;
  }

  if (e.type === "message_sent") {
    feed("&#9993; <b>" + esc(e.fromName) + "</b> &rarr; <b>" + esc(e.toName) + "</b>" +
      (e.priority ? " (priority)" : "") + ": " + esc(String(e.text).slice(0, 90)), "mail");
    return;
  }

  if (e.type === "turn_started") {
    busy.add(e.agentId); renderAgents();
    feed("<b>" + esc(nameOf(e.agentId)) + "</b> started a turn");
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
    feed("<b>" + esc(nameOf(e.agentId)) + "</b> failed: " + esc(e.error), "err");
    return;
  }

  if (e.type === "turn_interrupted") {
    feed("<b>" + esc(nameOf(e.agentId)) + "</b> interrupted (" + esc(e.reason) + ")", "warn");
    return;
  }

  if (e.type === "round") {
    if (e.agentId === current) $("round").textContent = "round " + (e.round + 1);
    return;
  }

  if (e.type === "error") {
    feed(esc(e.message), "err");
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

refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
