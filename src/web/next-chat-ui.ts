/**
 * The conversation with one agent — the page's main line (INV-1825).
 *
 * A person remembers who they asked. So the landing is the agents on a computer and the conversation
 * with one of them, and that agent's work sits pinned at the top of its conversation rather than in a
 * list somewhere else. Default level (docs/99 §6): what was said. An agent's steps and what passed
 * between agents are one folded line each, opened on demand; the host's own notes are not shown.
 */
export const NEXT_CHAT_JS = `
var chat = { agentId: "", conversation: "main", conversations: [], plan: null, box: "", entries: [], live: null, loading: "", loadedFor: "", request: 0, jump: false };
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
    if (member.paused[agent.id]) row.appendChild(el("span", "chip", t("ui.next.agent.paused")));
    else if (agentOwes(agent)) row.appendChild(el("span", "chip-need", t("ui.next.agent.needs")));
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
  // Another agent's half-written words and its thread are not this one's.
  if (agentId !== chat.agentId) { chat.live = null; chat.loadedFor = ""; chat.entries = []; chat.conversation = "main"; chat.conversations = []; chat.plan = null; }
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
/** A question the agent put to the person, answerable where it was asked. */
function askCard(tool, agent) {
  var card = el("div", "ask"), acts = el("div", "acts");
  card.appendChild(el("div", "why", t("ui.next.chat.asked", { name: agent ? agent.name : "" })));
  card.appendChild(el("div", "", tool.question.question));
  (tool.question.options || []).forEach(function (option) {
    var pick = el("button", "act", option);
    pick.addEventListener("click", function () { $("composer-text").value = option; sendMessage(); });
    acts.appendChild(pick);
  });
  if (acts.childNodes.length) card.appendChild(acts);
  return card;
}

/** The agent's own plan for what it is doing here, when it keeps one. */
function planCard() {
  var todos = (chat.plan && chat.plan.todos) || [];
  if (todos.length === 0) return null;
  var done = todos.filter(function (item) { return item.status === "done"; }).length;
  var card = el("details", "plan"), list = el("ul");
  card.open = done < todos.length;
  card.appendChild(el("summary", "", t("ui.next.chat.plan", { done: done, total: todos.length })));
  todos.forEach(function (item) { list.appendChild(el("li", "todo-" + item.status, item.text)); });
  card.appendChild(list);
  return card;
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
  var plan = planCard(), lastAsk = null;
  if (plan) thread.appendChild(plan);
  chat.entries.forEach(function (entry) {
    if (entry.kind === "tools") {
      (entry.tools || []).forEach(function (tool) { if (tool.question && tool.result === undefined) lastAsk = tool; });
      steps = steps.concat((entry.tools || []).filter(function (tool) { return !tool.question; }));
      return;
    }
    if (entry.kind === "text" && entry.role === "user") lastAsk = null; // answered by what was said next
    if (entry.kind === "text" && entry.aside) return; // commentary beside steps: the fold's, not the thread's
    flush();
    if (entry.kind === "text") thread.appendChild(bubble(entry));
    else if (entry.kind === "peer") thread.appendChild(fold(t("ui.next.chat.team", { n: (entry.messages || []).length }), (entry.messages || []).map(function (message) { return { head: message.from, text: clip(message.text, 300) }; })));
    else if (entry.kind === "trigger" && entry.skipped) thread.appendChild(el("div", "aside", t("ui.next.chat.earlier", { n: entry.skipped })));
  });
  flush();
  if (lastAsk && !chat.live) thread.appendChild(askCard(lastAsk, agent));
  if (chat.live) {
    if (chat.live.text) thread.appendChild(bubble({ role: "assistant", text: chat.live.text }));
    var bar = el("div", "livebar"), stop = el("button", "act", t("ui.next.chat.stop"));
    bar.appendChild(el("span", "dot"));
    bar.appendChild(el("span", "", chat.live.doing || t("ui.next.chat.working", { name: agent ? agent.name : "" })));
    stop.addEventListener("click", function () { postJson("/api/stop", { agent: chat.agentId }).catch(failed); });
    bar.appendChild(stop); thread.appendChild(bar);
  }
  if (thread.childNodes.length === 0) thread.appendChild(el("p", "empty", t(agent ? "ui.next.chat.empty" : "ui.next.chat.none")));
  view.appendChild(thread);
  // Follow the newest words only for somebody who was already reading the end (measured before the redraw).
  if (next.atEnd || chat.jump) view.scrollTop = view.scrollHeight; else view.scrollTop = next.scrollTop;
  chat.jump = false;
}

function renderChat(view) {
  var agent = next.agents[chat.agentId];
  $("view-title").textContent = agent ? agent.name : t("ui.next.nav.chat");
  $("view-hint").textContent = agent ? (agent.title || agent.description || "") : "";
  $("composer").hidden = !agent;
  $("composer-text").placeholder = agent ? t("ui.next.chat.placeholder", { name: agent.name }) : "";
  var picker = $("conversations");
  picker.hidden = chat.conversations.length < 2;
  if (!picker.hidden) {
    picker.replaceChildren();
    chat.conversations.forEach(function (row) {
      var option = el("option", "", row.id === "main" ? t("ui.next.chat.main") : clip(row.firstLine || row.id, 40));
      option.value = row.id; option.selected = row.id === chat.conversation;
      picker.appendChild(option);
    });
  }
  if (agent && chat.loading !== chat.agentId && chat.loadedFor !== chat.agentId) loadThread();
  if (chat.loadedFor === chat.agentId) renderThread(view);
}

/** The conversation is on screen: this agent's, in a visible tab, not behind the agent list on a narrow screen. */
function chatVisible() {
  var narrow = window.matchMedia("(max-width: 720px)").matches;
  return next.view === "chat" && document.visibilityState === "visible" && (!narrow || document.body.dataset.open === "1");
}

function loadThread() {
  var id = chat.agentId, request = ++chat.request;
  if (!id) return;
  chat.loading = id;
  getJson("/api/transcript?agent=" + encodeURIComponent(id) + "&conversation=" + encodeURIComponent(chat.conversation)).then(function (entries) {
    if (chat.agentId !== id || request !== chat.request) return; // a newer read is on its way
    if (chat.loadedFor !== id) { chat.jump = true; chat.live = next.agents[id] && next.agents[id].running ? { text: "", doing: "" } : null; }
    chat.entries = entries; chat.loadedFor = id; chat.loading = "";
    if (next.view === "chat") render();
    if (chatVisible()) postJson("/api/agents/viewed", { id: id, conversation: chat.conversation }).catch(function () {});
    // Beside the thread, and allowed to fail: a viewer may not read the plan, and one conversation needs no picker.
    getJson("/api/progress?agent=" + encodeURIComponent(id) + "&conversation=" + encodeURIComponent(chat.conversation)).then(function (plan) { if (request === chat.request) { chat.plan = plan; if (next.view === "chat") render(); } }, function () {});
    getJson("/api/conversations?agent=" + encodeURIComponent(id) + "&limit=30").then(function (got) { if (chat.agentId === id) { chat.conversations = got.conversations || []; if (next.view === "chat") render(); } }, function () {});
  }, function (error) { if (request === chat.request) chat.loading = ""; failed(error); });
}

function sendMessage() {
  var input = $("composer-text"), text = input.value.trim(), id = chat.agentId;
  if (!text || !id) return;
  input.value = ""; input.style.height = "";
  chat.entries = chat.entries.concat([{ kind: "text", role: "user", text: text }]);
  chat.live = { text: "", doing: "" }; chat.jump = true;
  render();
  postJson("/api/prompt", { agent: id, conversation: chat.conversation, text: text }).catch(function (error) { chat.live = null; failed(error); loadThread(); });
}

/** Live events for the open conversation: words as they come, what it is doing, and a re-read when the turn ends. */
function chatEvent(event) {
  if (!event || event.agentId !== chat.agentId || next.view !== "chat") return;
  if ((event.conversation || "main") !== chat.conversation) return;
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
  // Back is always to the agents: from a conversation, and from the two views that cut across them.
  $("back").addEventListener("click", function () { next.view = "chat"; delete document.body.dataset.open; render(); });
  $("conversations").addEventListener("change", function (event) {
    chat.conversation = event.target.value; chat.loadedFor = ""; chat.entries = []; chat.live = null; chat.plan = null;
    render();
  });
  var asked = new URLSearchParams(location.search).get("agent");
  if (asked) { chat.agentId = asked; document.body.dataset.open = "1"; }
}
`;
