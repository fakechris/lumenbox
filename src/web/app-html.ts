/**
 * The web UI, as a single inlined document.
 *
 * Inlined rather than served from disk so the CLI stays one esbuild bundle with no
 * asset paths to resolve, and vanilla JS on purpose: this is an acceptance-testing
 * surface, and a build step for it would be a liability rather than a feature.
 *
 * The embedded script uses string concatenation instead of template literals
 * throughout. It has to: this file is itself a template literal, so an inner
 * "${...}" would be evaluated here rather than shipped to the browser.
 */

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

  .msg { padding: 11px 16px; border-bottom: 1px solid #21252c; white-space: pre-wrap; word-break: break-word; }
  .msg .who { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin-bottom: 4px; }
  .msg.user .who { color: var(--accent); }
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
    <span>Box desktop</span>
    <span class="plain">
      <a id="full" href="#" target="_blank" rel="noopener">open full size</a>
      <span id="boxinfo"></span>
    </span>
  </h2>
  <div class="bar" id="model">&mdash;</div>
  <iframe id="vnc" title="box desktop"></iframe>
  <div class="bar" style="border-top:1px solid var(--line);border-bottom:0">
    Click the desktop to give it keyboard focus, or open it full size to drive it
    like a normal screen.
  </div>
  <h2 style="border-top:1px solid var(--line)">Activity &mdash; all agents</h2>
  <div class="feed" id="feed"></div>
</div>

<script>
"use strict";
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
      '<div class="ttl">' + esc(String(a.title || a.description || "").slice(0, 46)) + "</div></div></div>";
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
  div.innerHTML = '<div class="who">' + esc(who) + '</div><span class="body"></span>';
  var body = div.querySelector(".body");
  body.textContent = text;
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

function select(id) {
  current = id;
  $("title").textContent = nameOf(id);
  $("round").textContent = "";
  renderAgents();
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
    if (state.box.novncUrl) {
      // Set once, never re-set. The path is fixed, so assigning src again could
      // only reload noVNC — which is what made the desktop flash "Connecting…"
      // on a timer. Checking .src would not have caught it either: the browser
      // resolves that to an absolute URL, so a relative path never compares equal.
      if (!$("vnc").getAttribute("src")) {
        $("vnc").setAttribute("src", state.box.novncUrl);
      }
      $("full").href = state.box.novncUrl;
      $("full").style.display = "";
    } else {
      $("full").style.display = "none";
    }
    if (!current && agents.length) return select(agents[0].id);
    renderAgents();
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
    var node = live.get(e.agentId);
    if (!node) { node = bubble("", e.agentName, ""); live.set(e.agentId, node); }
    node.textContent += e.delta;
    var chat = $("chat");
    if (nearBottom(chat)) chat.scrollTop = chat.scrollHeight;
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

$("input").onkeydown = function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("form").requestSubmit();
  }
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
