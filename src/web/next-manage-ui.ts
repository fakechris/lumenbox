/**
 * Managing everything that runs, will run or has run, on the rebuilt page (INV-1825): an admin's view
 * across agents — what is executing now, what is set to start later, what ended, and the agents
 * themselves — with stop, pause, disable and discard. Nothing is done on a press: the server first
 * says exactly what the action covers and what it cannot know, and the second press does it.
 */
export const NEXT_MANAGE_JS = `
var manage = { section: "running", search: "", offset: 0, archive: false, data: null, error: "", pending: null, result: null, timer: 0 };
var MANAGE_SECTIONS = ["running", "future", "history", "members"];

function loadManage() {
  var query = "section=" + manage.section + "&offset=" + manage.offset + (manage.archive ? "&archive=1" : "");
  if (manage.search) query += "&search=" + encodeURIComponent(manage.search);
  getJson("/api/work-management?" + query).then(function (got) { manage.data = got; manage.error = ""; }, function (error) { manage.data = null; manage.error = error.message; })
    .then(function () { if (next.view === "system") render(); });
}

/** A code the server names a scope, a state or a limit by, in the words the classic page already has for it; itself when there are none. */
function manageWord(code) { return MSG["ui.wg." + code] ? t("ui.wg." + code) : String(code || ""); }

/** What one row is, in a line under its title: its state, where it came from, and when it next does something. */
function manageNote(row) {
  return [manageWord(row.state), manageWord(row.source), row.next ? new Date(row.next).toLocaleString() : "", manageWord(row.condition)].filter(Boolean).join(" · ");
}

function manageAsk(row, action) {
  manage.result = null;
  postJson("/api/work-management/preview", { choices: [{ key: row.key, action: action }] }).then(function (got) {
    manage.pending = { token: got.token, action: action, selections: got.selections || [], unknown: got.unknown || [] }; render();
  }, failed);
}

/** The second press: what will happen, said by the server, then done once. */
function managePending() {
  var box = el("div", "needbox"), acts = el("div", "acts");
  var go = el("button", "act-danger", t("ui.next.manage.act." + manage.pending.action)), no = el("button", "act", t("ui.next.auto.cancel"));
  manage.pending.selections.forEach(function (selection) {
    var row = selection.row || {};
    box.appendChild(el("div", "", t("ui.next.manage.will", { action: t("ui.next.manage.act." + selection.action), title: row.title || row.key || "" })));
    if (row.scope) box.appendChild(el("div", "why", manageWord(row.scope)));
    (row.unknown || []).forEach(function (line) { box.appendChild(el("div", "why", manageWord(line))); });
  });
  (manage.pending.unknown || []).forEach(function (line) { box.appendChild(el("div", "why", manageWord(line))); });
  go.addEventListener("click", function () {
    go.disabled = true;
    var operationId = window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    postJson("/api/work-management/apply", { token: manage.pending.token, operationId: operationId }).then(function (got) {
      manage.pending = null; manage.result = got; loadManage(); refreshSoon();
    }, function (error) { manage.pending = null; failed(error); render(); });
  });
  no.addEventListener("click", function () { manage.pending = null; render(); });
  acts.appendChild(go); acts.appendChild(no); box.appendChild(acts);
  return box;
}

function manageBody(body) {
  if (manage.data === null && !manage.error) { body.appendChild(el("p", "why", t("ui.next.auto.reading"))); loadManage(); return; }
  if (manage.error) { body.appendChild(el("p", "why", manage.error)); return; }
  var data = manage.data, counts = data.counts || {}, tabs = el("div", "acts"), find = el("input");
  MANAGE_SECTIONS.forEach(function (name) {
    var tab = el("button", "seg", t("ui.next.manage.section." + name) + " " + (counts[name] || 0));
    tab.setAttribute("aria-pressed", String(name === manage.section));
    tab.addEventListener("click", function () { manage.section = name; manage.offset = 0; manage.pending = null; manage.data = null; render(); });
    tabs.appendChild(tab);
  });
  body.appendChild(tabs);
  find.placeholder = t("ui.next.work.find"); find.value = manage.search;
  find.addEventListener("input", function () {
    manage.search = find.value.trim(); manage.offset = 0; clearTimeout(manage.timer);
    manage.timer = setTimeout(loadManage, 300);
  });
  body.appendChild(find);
  if (manage.pending) body.appendChild(managePending());
  if (manage.result) {
    (manage.result.results || []).forEach(function (result) {
      body.appendChild(el("div", "fact", t("ui.next.manage.result." + result.state) + (result.detail ? " · " + manageWord(result.detail) : "")));
    });
  }
  (data.unknown || []).forEach(function (line) { body.appendChild(el("p", "why", manageWord(line))); });
  if (!(data.rows || []).length) body.appendChild(el("p", "why", t("ui.next.manage.none")));
  (data.rows || []).forEach(function (row) {
    var line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts");
    var title = row.taskId ? el("button", "link", row.title) : el("b", "", row.title);
    if (row.taskId) title.addEventListener("click", function () { openPanel(row.taskId); });
    text.appendChild(title); text.appendChild(el("div", "why", (row.agentId ? agentName(row.agentId) + " · " : "") + manageNote(row)));
    (row.actions || []).forEach(function (action) {
      var act = el("button", "act", t("ui.next.manage.act." + action));
      act.addEventListener("click", function () { manageAsk(row, action); });
      acts.appendChild(act);
    });
    line.appendChild(text); line.appendChild(acts); body.appendChild(line);
  });
  var more = el("div", "acts"), shown = (data.offset || 0) + (data.rows || []).length;
  var page = function (label, offset) {
    var go = el("button", "act", label);
    go.addEventListener("click", function () { manage.offset = offset; manage.data = null; render(); });
    more.appendChild(go);
  };
  if ((data.offset || 0) > 0) page(t("ui.next.manage.newer"), Math.max(0, manage.offset - (data.limit || 50)));
  if (shown < (data.total || 0)) page(t("ui.next.manage.older", { n: data.total - shown }), shown);
  if (manage.section === "history") {
    var all = el("button", "act", t(manage.archive ? "ui.next.manage.hideEnded" : "ui.next.manage.showEnded"));
    all.addEventListener("click", function () { manage.archive = !manage.archive; manage.offset = 0; manage.data = null; render(); });
    more.appendChild(all);
  }
  if (more.childNodes.length) body.appendChild(more);
}

function manageBlock2() {
  var box = el("section", "setting");
  box.appendChild(systemFold(t("ui.next.manage.all"), "manage", manageBody));
  return box;
}
`;
