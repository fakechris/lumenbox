/**
 * Supervision on the rebuilt page (INV-1825): the watchdog that notices an agent that has stalled,
 * the model that supervises a long objective, and its runs — started here, watched here, stopped
 * here. Reading is a driver's; changing the settings is an admin's. A key is saved and never shown.
 */
export const NEXT_SET_SUPERVISION_JS = `
var supervision = { data: null, error: "", runs: null, open: "", detail: null, test: "", timer: 0 };

function loadSupervision() {
  clearTimeout(supervision.timer);
  getJson("/api/supervision").then(function (got) { supervision.data = got; supervision.error = ""; }, function (error) { supervision.data = {}; supervision.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  loadSupervisionRuns();
}
function loadSupervisionRuns() {
  clearTimeout(supervision.timer);
  getJson("/api/supervision/runs").then(function (got) {
    supervision.runs = got.runs || [];
    if (next.view === "settings" && settings.pane === "supervision") {
      render();
      // A run in flight is watched; nothing is polled once they have all ended or the pane is left.
      if (supervision.runs.some(function (run) { return run.state === "queued" || run.state === "running"; })) supervision.timer = setTimeout(loadSupervisionRuns, 5000);
    }
  }, function () {});
}

/** The numbers a supervision form holds, read strictly: minutes 1–1440, calls a whole number 1–500, a budget above zero or nothing. */
function supervisionNumbers(form) {
  var minutes = Number(form.maxMinutes), calls = Number(form.maxModelCalls), budget = String(form.budget || "").trim();
  if (!(minutes >= 1 && minutes <= 1440)) return { bad: "maxMinutes" };
  if (!(Number.isInteger(calls) && calls >= 1 && calls <= 500)) return { bad: "maxModelCalls" };
  if (budget !== "" && !(Number(budget) > 0)) return { bad: "budget" };
  return { maxMinutes: minutes, maxModelCalls: calls, budget: budget };
}

function supervisionForm() {
  var data = supervision.data, saved = data.settings || {}, dog = saved.watchdog || {}, sup = saved.supervisor || {}, admin = settings.me && settings.me.role === "admin";
  var box = el("section", "setting"), on = el("input"), onLabel = el("label", "tool"), stall = el("input"), paused = el("input");
  box.appendChild(el("h2", "group", t("ui.next.sup.watchdog")));
  on.type = "checkbox"; on.checked = !!dog.enabled; onLabel.appendChild(on); onLabel.appendChild(document.createTextNode(" " + t("ui.next.sup.watchdogOn")));
  stall.value = String(dog.stallMinutes === undefined ? "" : dog.stallMinutes); paused.value = String(dog.pausedMinutes === undefined ? "" : dog.pausedMinutes);
  box.appendChild(onLabel); box.appendChild(labelled(t("ui.next.sup.stall"), stall)); box.appendChild(labelled(t("ui.next.sup.paused"), paused));
  if (data.lastFlag) box.appendChild(el("p", "why", t("ui.next.sup.lastFlag", { what: data.lastFlag })));
  box.appendChild(el("h2", "group", t("ui.next.sup.model")));
  var providers = data.providers || [], provider = selectOf(providers.map(function (row) { return [row.name, row.label + (row.hasKey ? "" : " · " + t("ui.next.config.noKey"))]; }), sup.provider || "");
  var name = el("input"), who = selectOf([["", t("ui.next.sup.coordinator")]].concat((data.agents || []).map(function (agent) { return [agent, agent]; })), sup.agent || "");
  var minutes = el("input"), calls = el("input"), budget = el("input"), key = el("input"), note = el("p", "why", supervision.test);
  name.value = sup.model || ""; minutes.value = String(sup.maxMinutes || ""); calls.value = String(sup.maxModelCalls || ""); budget.value = sup.budget === undefined || sup.budget === null ? "" : String(sup.budget);
  key.type = "password"; key.autocomplete = "off"; key.placeholder = t("ui.next.model.key");
  var follow = function () { var chosen = providers.filter(function (row) { return row.name === provider.value; })[0] || {}; name.placeholder = chosen.defaultModel || ""; };
  provider.addEventListener("change", follow); follow();
  [labelled(t("ui.next.config.provider"), provider), labelled(t("ui.next.model.name"), name), labelled(t("ui.next.sup.agent"), who), labelled(t("ui.next.sup.maxMinutes"), minutes),
    labelled(t("ui.next.sup.maxCalls"), calls), labelled(t("ui.next.sup.budget"), budget)].forEach(function (node) { box.appendChild(node); });
  if (!admin) { box.appendChild(el("p", "why", t("ui.next.set.adminOnly"))); return box; }
  var acts = el("div", "acts"), save = el("button", "act-primary", t("ui.next.settings.save")), test = el("button", "act", t("ui.next.model.test")), keep = el("button", "act", t("ui.next.sup.saveKey")), keyRow = el("div", "acts");
  save.addEventListener("click", function () {
    var numbers = supervisionNumbers({ maxMinutes: minutes.value, maxModelCalls: calls.value, budget: budget.value });
    if (numbers.bad) { ({ maxMinutes: minutes, maxModelCalls: calls, budget: budget })[numbers.bad].focus(); toast(t("ui.next.sup.range")); return; }
    var body = { watchdog: Object.assign({}, dog, { enabled: on.checked, stallMinutes: Number(stall.value) || dog.stallMinutes, pausedMinutes: Number(paused.value) || dog.pausedMinutes }) };
    body.supervisor = { provider: provider.value, model: name.value.trim(), agent: who.value, budget: numbers.budget, maxMinutes: numbers.maxMinutes, maxModelCalls: numbers.maxModelCalls };
    postJson("/api/supervision/settings", body).then(function (got) { supervision.data = Object.assign({}, supervision.data, { settings: got.settings }); toast(got.note || t("ui.next.settings.saved2")); render(); }, failed);
  });
  test.addEventListener("click", function () {
    test.disabled = true; note.textContent = t("ui.next.model.testing");
    postJson("/api/supervision/test", { provider: provider.value, model: name.value.trim() || name.placeholder }).then(function (got) {
      supervision.test = got.ok ? t("ui.next.model.testOk", { model: name.value.trim() || name.placeholder, ms: got.ms || 0 }) : t("ui.next.model.testBad", { error: got.error || "" });
    }, function (error) { supervision.test = t("ui.next.model.testBad", { error: error.message }); }).then(function () { test.disabled = false; note.textContent = supervision.test; });
  });
  keep.addEventListener("click", function () {
    if (!key.value.trim()) { key.focus(); return; }
    postJson("/api/supervision/key", { provider: provider.value, key: key.value.trim() }).then(function () { key.value = ""; toast(t("ui.next.settings.saved2")); loadSupervision(); }, failed);
  });
  acts.appendChild(save); acts.appendChild(test); box.appendChild(acts); box.appendChild(note);
  keyRow.appendChild(key); keyRow.appendChild(keep); box.appendChild(keyRow);
  return box;
}

function supervisionRuns() {
  var box = el("section", "setting"), objective = el("textarea"), start = el("button", "act", t("ui.next.sup.start")), runs = supervision.runs || [];
  box.appendChild(el("h2", "group", t("ui.next.sup.runs")));
  objective.rows = 3; objective.placeholder = t("ui.next.sup.objective");
  start.addEventListener("click", function () {
    if (!objective.value.trim()) { objective.focus(); return; }
    // A run spends the supervisor's budget on its own: asked for twice.
    var sure = el("button", "act-danger", t("ui.next.sup.startSure"));
    sure.addEventListener("click", function () {
      var saved = ((supervision.data.settings || {}).supervisor) || {};
      postJson("/api/supervision/runs", { objective: objective.value.trim(), agent: saved.agent || "", budget: saved.budget === undefined || saved.budget === null ? "" : String(saved.budget) }).then(loadSupervisionRuns, failed);
    });
    start.replaceWith(sure);
  });
  box.appendChild(objective); box.appendChild(start);
  runs.slice(0, 20).forEach(function (run) {
    var line = el("button", "fact"), state = MSG["ui.next.sup.state." + run.state] ? t("ui.next.sup.state." + run.state) : run.state;
    line.appendChild(el("span", "", clip(run.objective, 80)));
    line.appendChild(el("span", run.state === "failed" ? "bad" : "why", state + (run.modelCalls ? " · " + t("ui.next.sup.calls", { n: run.modelCalls }) : "")));
    line.addEventListener("click", function () {
      supervision.open = supervision.open === run.id ? "" : run.id; supervision.detail = null; render();
      if (supervision.open) getJson("/api/supervision/runs/" + encodeURIComponent(run.id)).then(function (got) { if (supervision.open === run.id) { supervision.detail = got; render(); } }, failed);
    });
    box.appendChild(line);
    if (supervision.open !== run.id) return;
    var body = el("div", "fold-body");
    if (run.error) body.appendChild(el("p", "why", run.error));
    if (run.outcome) body.appendChild(el("p", "", run.outcome));
    if (supervision.detail && supervision.detail.summary) { var text = el("pre", "raw"); text.textContent = supervision.detail.summary; body.appendChild(text); }
    if (run.state === "queued" || run.state === "running") {
      var stop = el("button", "act-danger", t("ui.next.manage.act.stop"));
      stop.addEventListener("click", function () { postJson("/api/supervision/runs/" + encodeURIComponent(run.id) + "/stop", {}).then(loadSupervisionRuns, failed); });
      body.appendChild(stop);
    }
    box.appendChild(body);
  });
  return box;
}

function renderSupervisionPane(view) {
  if (supervision.data === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadSupervision(); return; }
  if (supervision.error) { view.appendChild(el("p", "why", supervision.error)); return; }
  view.appendChild(supervisionForm()); view.appendChild(supervisionRuns());
}
`;
