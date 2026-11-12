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
function owedText(item) { return item.kind === "review" ? t("ui.next.panel.review") : (item.detail || ""); }

/** The sentence under a row's title: what the person is asked, else what holds the work, else where it stands. */
function reasonOf(row) {
  var owed = next.mine.filter(function (item) { return item.ref === row.id; })[0];
  if (owed && owedText(owed)) return owedText(owed);
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
  if (isTask(item.ref)) open.addEventListener("click", function () { openPanel(item.ref); });
  else open.addEventListener("click", function () { location.href = "/"; });
  node.appendChild(open);
  if (item.kind === "approval") {
    var approve = el("button", "act-primary", t("ui.next.act.approve")), deny = el("button", "act", t("ui.next.act.deny"));
    approve.addEventListener("click", function () { postJson("/api/approve", { id: item.ref, scope: "once" }).then(function () { settle(node, t("ui.next.done.approved")); }, failed); });
    deny.addEventListener("click", function () { postJson("/api/deny", { id: item.ref }).then(function () { settle(node, t("ui.next.done.denied")); }, failed); });
    acts.appendChild(approve); acts.appendChild(deny);
  }
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
  $("view-title").textContent = t(next.view === "settings" || next.view === "auto" ? "ui.next.side." + next.view : "ui.next.nav." + next.view);
  $("view-hint").textContent = t("ui.next." + next.view + ".hint");
  if (next.view === "inbox") renderInbox(view);
  else if (next.view === "settings") renderSettings(view);
  else if (next.view === "auto") renderAuto(view);
  else renderWork(view);
}

function refresh() {
  if (next.loading) return Promise.resolve();
  next.loading = true;
  return Promise.all([getJson("/api/state"), getJson("/api/attention"), getJson("/api/tasks/list?records=user&limit=100")]).then(function (got) {
    next.agents = {};
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
  var asked = new URLSearchParams(location.search).get("view");
  if (asked === "work" || asked === "inbox" || asked === "settings" || asked === "auto") { next.view = asked; document.body.dataset.open = "1"; }
  panelStart();
  chatStart();
  screenStart();
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
  };
}
`;
