/**
 * The conversation with one agent — the page's main line (INV-1825).
 *
 * A person remembers who they asked. So the landing is the agents on a computer and the conversation
 * with one of them, and that agent's work sits pinned at the top of its conversation rather than in a
 * list somewhere else. Default level (docs/99 §6): what was said. An agent's steps and what passed
 * between agents are one folded line each, opened on demand; the host's own notes are not shown.
 */
export const NEXT_CHAT_JS = `
var chat = { agentId: "", box: "", entries: [], live: null, loading: "" };
var markdown = window.markdownit ? window.markdownit({ html: false, linkify: true, breaks: true }) : null;

function agentsHere() {
  return Object.keys(next.agents).map(function (id) { return next.agents[id]; }).filter(function (agent) { return !chat.box || agent.boxId === chat.box; });
}
function boxesKnown() {
  var seen = {}, list = [];
  Object.keys(next.agents).forEach(function (id) {
    var agent = next.agents[id];
    if (agent.boxId && !seen[agent.boxId]) { seen[agent.boxId] = true; list.push({ id: agent.boxId, name: agent.boxName || agent.boxId }); }
  });
  return list;
}
/** What needs the person from this agent: its own waiting state, or an inbox item on one of its tasks. */
function agentOwes(agent) {
  if (agent.facts && agent.facts.awaiting) return true;
  return next.mine.some(function (item) {
    var row = next.rows.filter(function (candidate) { return candidate.id === item.ref; })[0];
    return row && row.assigneeId === agent.id;
  });
}

function renderSide() {
  var boxes = boxesKnown(), holder = $("boxes"), list = $("agents");
  if (!chat.box || !boxes.some(function (box) { return box.id === chat.box; })) chat.box = boxes[0] ? boxes[0].id : "";
  holder.replaceChildren();
  holder.hidden = boxes.length < 2;
  boxes.forEach(function (box) {
    var button = el("button", "", box.name);
    button.setAttribute("aria-pressed", String(box.id === chat.box));
    button.addEventListener("click", function () { chat.box = box.id; chat.agentId = ""; render(); });
    holder.appendChild(button);
  });
  var here = agentsHere();
  if (!here.some(function (agent) { return agent.id === chat.agentId; })) chat.agentId = here[0] ? here[0].id : "";
  list.replaceChildren();
  here.forEach(function (agent) {
    var row = el("button", "agent"), body = el("span", "body");
    row.setAttribute("aria-current", String(next.view === "chat" && agent.id === chat.agentId));
    body.appendChild(el("div", "title", agent.name));
    body.appendChild(el("div", "role", agent.running ? t("ui.next.agent.working") : (agent.title || agent.description || "")));
    row.appendChild(el("span", "who", initial(agent.name)));
    row.appendChild(body);
    if (agentOwes(agent)) row.appendChild(el("span", "chip-need", t("ui.next.agent.needs")));
    else if (agent.running) row.appendChild(el("span", "dot"));
    else if (agent.facts && agent.facts.unreadCount) row.appendChild(el("span", "count", agent.facts.unreadCount));
    row.addEventListener("click", function () { openChat(agent.id); });
    list.appendChild(row);
  });
  var needs = $("needs");
  needs.hidden = next.mine.length === 0;
  needs.textContent = t("ui.next.side.needs", { n: next.mine.length });
}

function openChat(agentId) {
  chat.agentId = agentId; next.view = "chat"; document.body.dataset.open = "1";
  history.replaceState(null, "", "?ui=next&agent=" + encodeURIComponent(agentId));
  render();
}

function bubble(entry) {
  if (entry.role === "user") return el("div", "msg-me", entry.text);
  if (entry.aside) return el("div", "aside", entry.text);
  var node = el("div", "msg");
  if (markdown) node.innerHTML = markdown.render(entry.text); else node.textContent = entry.text;
  node.querySelectorAll("a").forEach(function (link) { link.target = "_blank"; link.rel = "noopener noreferrer"; });
  return node;
}
function fold(summary, lines) {
  var box = el("details", "fold"), list = el("ul");
  box.appendChild(el("summary", "", summary));
  lines.forEach(function (line) {
    var item = el("li", line.bad ? "bad" : "");
    item.appendChild(el("b", "", line.head)); item.appendChild(document.createTextNode(" " + line.text));
    list.appendChild(item);
  });
  box.appendChild(list);
  return box;
}
function clip(text, limit) { text = String(text || "").replace(/\\s+/g, " "); return text.length > limit ? text.slice(0, limit) + "…" : text; }

/** The thread as a person reads it: adjacent steps become one fold, the host's notes are left out. */
function renderThread(view) {
  var thread = el("div", "thread"), agent = next.agents[chat.agentId], steps = [];
  function flush() {
    if (steps.length === 0) return;
    thread.appendChild(fold(t("ui.next.chat.steps", { n: steps.length }), steps.map(function (tool) { return { head: tool.name, text: clip(tool.detail, 160), bad: tool.isError }; })));
    steps = [];
  }
  next.rows.filter(function (row) { return row.assigneeId === chat.agentId && nextGroupOf(nextStateOf(row).key) !== "done"; }).forEach(function (row) {
    var pin = el("button", "pin"), body = el("span", "body");
    body.appendChild(el("div", "title", row.title)); body.appendChild(el("div", "why", reasonOf(row)));
    pin.appendChild(chip(nextStateOf(row))); pin.appendChild(body);
    pin.addEventListener("click", function () { openPanel(row.id); });
    thread.appendChild(pin);
  });
  chat.entries.forEach(function (entry) {
    if (entry.kind === "tools") { steps = steps.concat(entry.tools || []); return; }
    if (entry.kind === "text" && entry.aside) return; // commentary beside steps: the fold's, not the thread's
    flush();
    if (entry.kind === "text") thread.appendChild(bubble(entry));
    else if (entry.kind === "peer") thread.appendChild(fold(t("ui.next.chat.team", { n: (entry.messages || []).length }), (entry.messages || []).map(function (message) { return { head: message.from, text: clip(message.text, 300) }; })));
    else if (entry.kind === "trigger" && entry.skipped) thread.appendChild(el("div", "aside", t("ui.next.chat.earlier", { n: entry.skipped })));
  });
  flush();
  if (chat.live) {
    if (chat.live.text) thread.appendChild(bubble({ role: "assistant", text: chat.live.text }));
    var bar = el("div", "livebar"), stop = el("button", "act", t("ui.next.chat.stop"));
    bar.appendChild(el("span", "dot"));
    bar.appendChild(el("span", "", chat.live.doing || t("ui.next.chat.working", { name: agent ? agent.name : "" })));
    stop.addEventListener("click", function () { postJson("/api/stop", { agent: chat.agentId }).catch(failed); });
    bar.appendChild(stop); thread.appendChild(bar);
  }
  if (thread.childNodes.length === 0) thread.appendChild(el("p", "empty", t(agent ? "ui.next.chat.empty" : "ui.next.chat.none")));
  var atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 80 || chat.jump;
  view.appendChild(thread);
  if (atEnd) view.scrollTop = view.scrollHeight;
  chat.jump = false;
}

function renderChat(view) {
  var agent = next.agents[chat.agentId];
  $("view-title").textContent = agent ? agent.name : t("ui.next.nav.chat");
  $("view-hint").textContent = agent ? (agent.title || agent.description || "") : "";
  $("composer").hidden = !agent;
  $("composer-text").placeholder = agent ? t("ui.next.chat.placeholder", { name: agent.name }) : "";
  if (agent && chat.loading !== chat.agentId && chat.loadedFor !== chat.agentId) loadThread();
  if (chat.loadedFor === chat.agentId) renderThread(view);
}

function loadThread() {
  var id = chat.agentId;
  if (!id) return;
  chat.loading = id;
  getJson("/api/transcript?agent=" + encodeURIComponent(id) + "&conversation=main").then(function (entries) {
    if (chat.agentId !== id) return;
    if (chat.loadedFor !== id) { chat.jump = true; chat.live = next.agents[id] && next.agents[id].running ? { text: "", doing: "" } : null; }
    chat.entries = entries; chat.loadedFor = id; chat.loading = "";
    if (next.view === "chat") render();
    postJson("/api/agents/viewed", { id: id }).catch(function () {});
  }, function (error) { chat.loading = ""; failed(error); });
}

function sendMessage() {
  var input = $("composer-text"), text = input.value.trim(), id = chat.agentId;
  if (!text || !id) return;
  input.value = ""; input.style.height = "";
  chat.entries = chat.entries.concat([{ kind: "text", role: "user", text: text }]);
  chat.live = { text: "", doing: "" }; chat.jump = true;
  render();
  postJson("/api/prompt", { agent: id, conversation: "main", text: text }).catch(function (error) { chat.live = null; failed(error); loadThread(); });
}

/** Live events for the open conversation: words as they come, what it is doing, and a re-read when the turn ends. */
function chatEvent(event) {
  if (!event || event.agentId !== chat.agentId || next.view !== "chat") return;
  if (event.conversation && event.conversation !== "main") return;
  if (event.type === "turn_started") { chat.live = { text: "", doing: "" }; render(); }
  else if (event.type === "text" && typeof event.delta === "string") { chat.live = chat.live || { text: "", doing: "" }; chat.live.text += event.delta; render(); }
  else if (event.type === "tool_start") { chat.live = chat.live || { text: "", doing: "" }; chat.live.text = ""; chat.live.doing = event.phrase || event.tool || ""; render(); }
  else if (event.type === "turn_finished" || event.type === "turn_failed" || event.type === "turn_interrupted") { chat.live = null; loadThread(); }
  else if (event.type === "prompt" || event.type === "reset") loadThread();
}

function chatStart() {
  var input = $("composer-text");
  $("composer-form").addEventListener("submit", function (event) { event.preventDefault(); sendMessage(); });
  input.addEventListener("keydown", function (event) { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
  input.addEventListener("input", function () { input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
  $("back").addEventListener("click", function () { delete document.body.dataset.open; });
  var asked = new URLSearchParams(location.search).get("agent");
  if (asked) { chat.agentId = asked; document.body.dataset.open = "1"; }
}
`;
