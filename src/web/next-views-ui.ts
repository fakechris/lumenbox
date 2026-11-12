/**
 * The two views that cut across agents (INV-1825): everything that needs the person, and all work.
 * Secondary by design — the main line is the conversation (next-chat-ui.ts) — but one click away.
 *
 * Default level only (docs/99 §6): a state and a reason per row. Anything richer is the panel's.
 * The inbox is `/api/attention`'s `mine`; the work list is `/api/tasks/list?records=user` — the same
 * two reads the classic page makes, shown without the rest.
 */
export const NEXT_VIEWS_JS = `
var next = { view: "chat", layout: "list", agents: {}, mine: [], rows: [], loading: false };

function agentName(id) { return next.agents[id] ? next.agents[id].name : (id || ""); }
function initial(name) { return (name || "?").trim().slice(0, 1).toUpperCase(); }
function agoText(iso) { var ago = nextAgo(iso, Date.now()); return t("ui.next.time." + ago.key, { n: ago.n }); }
function isTask(ref) { return /^t\\d+$/.test(ref); }

/** What an inbox item asks, in the page's own words where the server's are bookkeeping. */
function owedText(item) {
  if (item.kind === "review") return t("ui.next.panel.review");
  if (item.kind === "nudged") return t("ui.next.inbox.nudged");
  // A question's choices are buttons on its row; its sentence is the question alone.
  if (item.answer && item.answer.options) return String(item.detail || "").split(" — ")[0];
  return item.detail || "";
}

/** The sentence under a row's title: what the person is asked, else what holds the work, else where it stands. */
function reasonOf(row) {
  var owed = next.mine.filter(function (item) { return item.ref === row.id; })[0];
  if (owed && owedText(owed)) return owedText(owed);
  // What a job is waiting on outside the agent — credentials it lacks, most often — is the reason, in the board's words.
  if (row.waitingOn) return row.waitingOn;
  var reading = row.reading || {};
  if (reading.blocker && MSG["ui.wr.blocker." + reading.blocker.kind]) {
    var tools = (reading.blocker.tools || []).join(", ");
    return t("ui.wr.blocker." + reading.blocker.kind) + (tools ? " (" + tools + ")" : "");
  }
  // Finished work needs no sentence: the word says it, and the panel has the result.
  var state = nextStateOf(row).key;
  if (state === "done" || state === "stopped") return "";
  return MSG["ui.wr.reason." + reading.reason] ? t("ui.wr.reason." + reading.reason) : "";
}

function chip(state) { return el("span", "chip " + state.tone, t("ui.next.state." + state.key)); }

function meter(progress) {
  var bar = el("div", "meter"), fill = el("i");
  fill.style.width = Math.round((progress.done / progress.total) * 100) + "%";
  bar.appendChild(fill);
  return bar;
}

function workRow(row) {
  var state = nextStateOf(row), node = el("div", "row"), open = el("button", "open");
  var body = el("span", "body");
  body.appendChild(el("div", "title", row.title));
  body.appendChild(el("div", "why", reasonOf(row)));
  var progress = nextProgressOf(row.progress);
  if (progress) body.appendChild(meter(progress));
  open.appendChild(el("span", "who", initial(agentName(row.assigneeId))));
  open.appendChild(body);
  open.addEventListener("click", function () { openPanel(row.id); });
  node.appendChild(open);
  node.appendChild(chip(state));
  node.appendChild(el("span", "when", agoText(row.updatedAt)));
  return node;
}

function workCard(row) {
  var card = el("button", "card"), foot = el("div", "foot"), progress = nextProgressOf(row.progress);
  card.appendChild(chip(nextStateOf(row)));
  card.appendChild(el("div", "title", row.title));
  card.appendChild(el("div", "why", reasonOf(row)));
  if (progress) card.appendChild(meter(progress));
  foot.appendChild(el("span", "who", initial(agentName(row.assigneeId))));
  foot.appendChild(el("span", "", agentName(row.assigneeId)));
  foot.appendChild(el("span", "", agoText(row.updatedAt)));
  card.appendChild(foot);
  card.addEventListener("click", function () { openPanel(row.id); });
  return card;
}

var WORK_GROUPS = ["running", "you", "review", "done"];

function renderWork(view) {
  var groups = {};
  WORK_GROUPS.forEach(function (name) { groups[name] = []; });
  next.rows.forEach(function (row) { groups[nextGroupOf(nextStateOf(row).key)].push(row); });
  groups.done = groups.done.slice(0, 10);
  if (next.rows.length === 0) { view.appendChild(el("p", "empty", t("ui.next.work.empty"))); return; }
  var holder = el("div", next.layout === "board" ? "board" : "list");
  WORK_GROUPS.forEach(function (name) {
    if (next.layout === "list" && groups[name].length === 0) return;
    var into = next.layout === "board" ? el("div", "col") : holder;
    into.appendChild(el("h2", "group", t("ui.next.group." + name) + (next.layout === "board" ? " " + groups[name].length : "")));
    groups[name].forEach(function (row) { into.appendChild(next.layout === "board" ? workCard(row) : workRow(row)); });
    if (into !== holder) holder.appendChild(into);
  });
  view.appendChild(holder);
}

var INBOX_GROUPS = ["answer", "approve", "review", "stuck", "other"];

function settle(node, text) { node.replaceChildren(el("span", "body", text)); node.style.opacity = "0.6"; refreshSoon(); }

function inboxRow(item) {
  var node = el("div", "row"), open = el("button", "open"), body = el("span", "body"), acts = el("span", "acts");
  body.appendChild(el("div", "title", item.title));
  body.appendChild(el("div", "why", owedText(item)));
  open.appendChild(el("span", "who", initial(item.with || item.title)));
  open.appendChild(body);
  // Opens the work when it is about work, else the conversation with the agent that asked.
  if (isTask(item.ref)) open.addEventListener("click", function () { openPanel(item.ref); });
  else if (item.answer) open.addEventListener("click", function () { openChat(item.answer.agentId); });
  node.appendChild(open);
  if (item.kind === "approval") {
    var approve = el("button", "act-primary", t("ui.next.act.approve")), deny = el("button", "act", t("ui.next.act.deny"));
    approve.addEventListener("click", function () { postJson("/api/approve", { id: item.ref, scope: "once" }).then(function () { settle(node, t("ui.next.done.approved")); }, failed); });
    deny.addEventListener("click", function () { postJson("/api/deny", { id: item.ref }).then(function () { settle(node, t("ui.next.done.denied")); }, failed); });
    acts.appendChild(approve); acts.appendChild(deny);
  }
  ((item.answer && item.answer.options) || []).forEach(function (option) {
    var pick = el("button", "act", option);
    pick.addEventListener("click", function () {
      acts.querySelectorAll("button").forEach(function (other) { other.disabled = true; });
      postJson("/api/prompt", { agent: item.answer.agentId, conversation: item.answer.conversation, text: option }).then(function () {
        settle(node, t("ui.next.done.sent", { name: item.with || "" }));
      }, function (error) { failed(error); render(); });
    });
    acts.appendChild(pick);
  });
  if (acts.childNodes.length) node.appendChild(acts);
  if (item.deadline) node.appendChild(el("span", "when", agoText(item.deadline)));
  return node;
}

function renderInbox(view) {
  if (next.mine.length === 0) { view.appendChild(el("p", "empty", t("ui.next.inbox.empty"))); return; }
  var list = el("div", "list");
  INBOX_GROUPS.forEach(function (name) {
    var items = next.mine.filter(function (item) { return nextInboxGroupOf(item.kind) === name; });
    if (items.length === 0) return;
    list.appendChild(el("h2", "group", t("ui.next.group." + name)));
    items.forEach(function (item) { list.appendChild(inboxRow(item)); });
  });
  view.appendChild(list);
}

function render() {
  var view = $("view");
  next.atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 80; next.scrollTop = view.scrollTop;
  view.replaceChildren();
  document.body.dataset.view = next.view;
  renderSide();
  $("work-tools").hidden = next.view !== "work";
  $("composer").hidden = true;
  document.querySelectorAll("[data-nav]").forEach(function (button) { button.setAttribute("aria-current", String(button.dataset.nav === next.view)); });
  document.querySelectorAll("[data-layout]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.layout === next.layout)); });
  renderScreen();
  if (next.view === "chat") { renderChat(view); return; }
  $("view-title").textContent = t(next.view === "system" ? "ui.next.side.system" : next.view === "boxes" ? "ui.next.side.boxes2" : next.view === "settings" || next.view === "auto" ? "ui.next.side." + next.view : "ui.next.nav." + next.view);
  $("view-hint").textContent = t("ui.next." + next.view + ".hint");
  if (next.view === "inbox") renderInbox(view);
  else if (next.view === "settings") renderSettings(view);
  else if (next.view === "auto") renderAuto(view);
  else if (next.view === "boxes") renderBoxes(view);
  else if (next.view === "system") renderSystem(view);
  else renderWork(view);
}

function refresh() {
  if (next.loading) return Promise.resolve();
  next.loading = true;
  // The computers are a fourth read that may be refused or slow; the page does not wait on it to be useful.
  var machines = getJson("/api/boxes").then(function (got) { return got; }, function () { return { boxes: [], own: "" }; });
  getJson("/api/setup").then(function (got) { settings.setup = got; }, function () {});
  return Promise.all([getJson("/api/state"), getJson("/api/attention"), getJson("/api/tasks/list?records=user&limit=100"), machines]).then(function (got) {
    boxes.list = got[3].boxes || []; boxes.own = got[3].own || "";
    next.agents = {}; member.allTools = got[0].allTools || [];
    (got[0].agents || []).forEach(function (agent) { next.agents[agent.id] = agent; });
    next.mine = got[1].mine || [];
    next.rows = got[2].tasks || [];
    // An agent named in the address decides which computer is shown.
    if (chat.agentId && next.agents[chat.agentId] && !chat.box) chat.box = next.agents[chat.agentId].boxId || "";
    render();
  }, failed).then(function () { next.loading = false; });
}

var refreshTimer = 0;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 400); }

function nextStart() {
  document.querySelectorAll("[data-nav]").forEach(function (button) {
    button.addEventListener("click", function () { next.view = button.dataset.nav; document.body.dataset.open = "1"; history.replaceState(null, "", "?ui=next&view=" + next.view); render(); });
  });
  document.querySelectorAll("[data-layout]").forEach(function (button) {
    button.addEventListener("click", function () { next.layout = button.dataset.layout; render(); });
  });
  $("theme").addEventListener("click", function () {
    var dark = document.documentElement.getAttribute("data-theme") !== "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem("lumen-theme", dark ? "dark" : "light"); } catch (error) {}
  });
  var asked = new URLSearchParams(location.search).get("view");
  if (asked === "work" || asked === "inbox" || asked === "settings" || asked === "auto" || asked === "boxes" || asked === "system") { next.view = asked; document.body.dataset.open = "1"; }
  panelStart();
  chatStart();
  screenStart();
  memberStart();
  cardsStart();
  embedStart();
  refresh();
  // What changes a row or the inbox arrives as an event; the page re-reads rather than patching.
  var events = new EventSource("/api/events");
  events.onmessage = function (message) {
    var event; try { event = JSON.parse(message.data); } catch (error) { return; }
    var kind = event && event.type;
    if (kind === "task_changed" || kind === "approval_pending" || kind === "approval_settled" || kind === "question" || kind === "turn_finished" || kind === "turn_failed" || kind === "reset") refreshSoon();
    if ((kind === "task_changed" || kind === "task_execution") && event.taskId) panelChanged(event.taskId);
    if (kind === "turn_started" || kind === "turn_finished" || kind === "turn_failed") { var who = next.agents[event.agentId]; if (who) who.running = kind === "turn_started"; }
    chatEvent(event);
    cardsEvent(event);
    // The system page is a snapshot: what can change it re-reads it while it is the page being looked at.
    if (next.view === "system" && (kind === "turn_failed" || kind === "turn_finished" || kind === "error" || kind === "reset")) loadSystem();
  };
}
`;
