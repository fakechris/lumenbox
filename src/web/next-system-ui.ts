/**
 * The system page of the rebuilt view (INV-1825, docs/99 §6): what is running this installation and
 * what went wrong in it. Nothing here asks for attention — what needs a person is in their inbox —
 * so it is one click into Settings and never on a default surface.
 */
export const NEXT_SYSTEM_JS = `
var system = { state: null, exceptions: null, history: null };

function loadSystem() {
  var none = function () { return null; };
  Promise.all([
    getJson("/api/state").catch(none),
    getJson("/api/exceptions").catch(none),
    getJson("/api/tasks/list?records=internal&limit=1").catch(none),
  ]).then(function (got) {
    system.state = got[0]; system.exceptions = got[1]; system.history = got[2];
    if (next.view === "system") render();
  });
}

function fact(label, value) {
  var row = el("div", "fact");
  row.appendChild(el("span", "why", label)); row.appendChild(el("span", "", value));
  return row;
}

function exceptionRow(entry) {
  var row = el("div", "row"), body = el("span", "body"), acts = el("span", "acts");
  body.appendChild(el("div", "title", entry.subject));
  body.appendChild(el("div", "why", entry.reason + (entry.attempt > 1 ? " ×" + entry.attempt : "")));
  row.appendChild(el("span", "who", initial(agentName(entry.agent))));
  row.appendChild(body);
  [["retry", t("ui.next.system.retry")], ["dismiss", t("ui.next.card.dismiss")]].forEach(function (pair) {
    var button = el("button", "act", pair[1]);
    button.addEventListener("click", function () { postJson("/api/exceptions/" + pair[0], { id: entry.id }).then(loadSystem, failed); });
    acts.appendChild(button);
  });
  row.appendChild(acts);
  row.appendChild(el("span", "when", agoText(entry.at)));
  return row;
}

function renderSystem(view) {
  if (!system.state) { loadSystem(); return; }
  var state = system.state, health = el("section", "setting"), usage = state.usageToday || {};
  health.appendChild(el("h2", "group", t("ui.next.system.health")));
  health.appendChild(fact(t("ui.next.system.model"), String(state.provider || "")));
  boxes.list.forEach(function (box) { health.appendChild(fact(box.name, t(box.connected ? "ui.next.box.on" : "ui.next.box.off"))); });
  health.appendChild(fact(t("ui.next.system.today"), t("ui.next.diag.tokens", { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cache: usage.cacheReadTokens || 0 })));
  if (state.build) health.appendChild(fact(t("ui.next.system.version"), [state.build.version, state.build.commit].filter(Boolean).join(" · ")));
  view.appendChild(health);

  var open = [];
  ((system.exceptions && system.exceptions.groups) || []).forEach(function (group) {
    group.entries.forEach(function (entry) { if (!entry.resolvedAt) open.push(entry); });
  });
  var wrong = el("div", "list");
  wrong.appendChild(el("h2", "group", t("ui.next.system.wrong", { n: open.length })));
  if (open.length === 0) wrong.appendChild(el("p", "why", t("ui.next.system.nothingWrong")));
  open.slice(0, 30).forEach(function (entry) { wrong.appendChild(exceptionRow(entry)); });
  view.appendChild(wrong);

  var kept = el("section", "setting"), total = (system.history && system.history.total) || 0;
  kept.appendChild(el("h2", "group", t("ui.next.system.history")));
  kept.appendChild(el("p", "", t("ui.next.system.historyNote", { n: total })));
  view.appendChild(kept);
}
`;
