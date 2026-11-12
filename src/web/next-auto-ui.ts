/**
 * Automations on the rebuilt page (INV-1825): what starts on its own, made, run and read here.
 *
 * Default: one row per automation — its name, what it does, when it next runs, on or paused.
 * Detail, one press: its recent runs and how each ended. Making one asks four things: a name, what
 * to do, who does it, and what starts it. The routes are the classic page's.
 */
export const NEXT_AUTO_JS = `
var auto = { creating: false, open: "", runs: null, trigger: "schedule" };
// minute hour day month weekday, as the scheduler reads it
var AUTO_TIMES = [["hourly", "0 * * * *"], ["daily", "0 9 * * *"], ["weekdays", "0 9 * * 1-5"], ["monday", "0 9 * * 1"]];

function reloadAuto() { settings.routines = null; render(); }

function autoForm() {
  var form = el("section", "setting"), name = field(t("ui.next.auto.name"), ""), what = field(t("ui.next.auto.what"), "", true);
  var who = el("select"), kind = el("select"), when = el("select"), custom = field(t("ui.next.auto.cron"), ""), match = field(t("ui.next.auto.match"), "");
  var pick = function (labelText, select) { var label = el("label", "", labelText); label.appendChild(select); return label; };
  var option = function (select, value, text) { var node = el("option", "", text); node.value = value; select.appendChild(node); };
  option(who, "", t("ui.next.auto.anyone"));
  agentsHere().forEach(function (agent) { option(who, agent.name, agent.name); });
  ["schedule", "webhook", "message"].forEach(function (value) { option(kind, value, t("ui.next.auto.kind." + value)); });
  AUTO_TIMES.forEach(function (pair) { option(when, pair[1], t("ui.next.auto.time." + pair[0])); });
  option(when, "", t("ui.next.auto.time.custom"));
  kind.value = auto.trigger;
  var whenLabel = pick(t("ui.next.auto.when"), when), show = function () {
    whenLabel.hidden = kind.value !== "schedule"; custom.label.hidden = kind.value !== "schedule" || when.value !== ""; match.label.hidden = kind.value !== "message";
  };
  kind.addEventListener("change", function () { auto.trigger = kind.value; show(); });
  when.addEventListener("change", show);
  var save = el("button", "act-primary", t("ui.next.member.create")), cancel = el("button", "act", t("ui.next.auto.cancel")), acts = el("div", "acts");
  save.addEventListener("click", function () {
    var body = { name: name.input.value.trim(), body: what.input.value.trim(), triggerType: kind.value };
    if (kind.value === "schedule") body.schedule = when.value || custom.input.value.trim();
    if (kind.value === "message") body.match = match.input.value.trim();
    if (who.value) body.agent = who.value;
    try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (error) {}
    save.disabled = true;
    postJson("/api/automations", body).then(function () { auto.creating = false; toast(t("ui.next.member.created")); reloadAuto(); }, function (error) { save.disabled = false; failed(error); });
  });
  cancel.addEventListener("click", function () { auto.creating = false; render(); });
  [name.label, what.label, pick(t("ui.next.auto.who"), who), pick(t("ui.next.auto.starts"), kind), whenLabel, custom.label, match.label].forEach(function (node) { form.appendChild(node); });
  acts.appendChild(save); acts.appendChild(cancel); form.appendChild(acts);
  show();
  return form;
}

/** How its recent runs ended, newest first. */
function autoRuns(routine) {
  var box = el("div", "runs");
  if (!auto.runs) {
    box.appendChild(el("p", "why", t("ui.next.auto.reading")));
    getJson("/api/schedules/runs?slug=" + encodeURIComponent(routine.slug) + "&limit=10").then(function (got) { if (auto.open === routine.slug) { auto.runs = got; render(); } }, failed);
    return box;
  }
  if (auto.runs.hold) box.appendChild(el("p", "why", t("ui.next.auto.held", { reason: auto.runs.hold.reason || "" })));
  if (!(auto.runs.runs || []).length) box.appendChild(el("p", "why", t("ui.next.auto.noRuns")));
  (auto.runs.runs || []).forEach(function (run) {
    var line = el("div", "fact"), known = MSG["ui.next.auto.outcome." + run.outcome];
    line.appendChild(el("span", "why", new Date(run.at).toLocaleString() + (run.manual ? " · " + t("ui.next.auto.byHand") : "")));
    line.appendChild(el("span", "", (known ? t("ui.next.auto.outcome." + run.outcome) : run.outcome) + (run.reason ? " · " + run.reason : "")));
    box.appendChild(line);
  });
  return box;
}

function renderAuto(view) {
  if (!settings.routines) {
    getJson("/api/schedules").then(function (got) { settings.routines = got.schedules || []; if (next.view === "auto") render(); }, failed);
    return;
  }
  if (auto.creating) view.appendChild(autoForm());
  else {
    var add = el("button", "act", t("ui.next.auto.new"));
    add.addEventListener("click", function () { auto.creating = true; render(); });
    view.appendChild(add);
  }
  if (settings.routines.length === 0) { view.appendChild(el("p", "empty", t("ui.next.auto.empty"))); return; }
  var list = el("div", "list");
  settings.routines.forEach(function (routine) {
    var row = el("div", "row"), open = el("button", "open"), body = el("span", "body"), acts = el("span", "acts");
    var toggle = el("button", "act", t(routine.paused ? "ui.next.auto.resume" : "ui.next.auto.pause")), run = el("button", "act", t("ui.next.auto.run"));
    var when = routine.nextRun ? t("ui.next.auto.next", { when: new Date(routine.nextRun).toLocaleString() }) : t("ui.next.auto.event");
    body.appendChild(el("div", "title", routine.name || routine.slug));
    body.appendChild(el("div", "why", [routine.described || routine.schedule || "", when].filter(Boolean).join(" · ")));
    open.appendChild(el("span", "who", initial(routine.agent || routine.name)));
    open.appendChild(body);
    open.addEventListener("click", function () { auto.open = auto.open === routine.slug ? "" : routine.slug; auto.runs = null; render(); });
    row.appendChild(open);
    row.appendChild(el("span", routine.paused ? "chip" : "chip-run", t(routine.paused ? "ui.next.auto.paused" : "ui.next.auto.on")));
    toggle.addEventListener("click", function () { postJson(routine.paused ? "/api/schedules/resume" : "/api/schedules/pause", { slug: routine.slug }).then(reloadAuto, failed); });
    run.addEventListener("click", function () {
      run.disabled = true;
      postJson("/api/schedules/run", { slug: routine.slug }).then(function () { toast(t("ui.next.auto.started")); auto.runs = null; reloadAuto(); }, function (error) { run.disabled = false; failed(error); });
    });
    acts.appendChild(run); acts.appendChild(toggle); row.appendChild(acts);
    list.appendChild(row);
    if (auto.open === routine.slug) list.appendChild(autoRuns(routine));
  });
  view.appendChild(list);
}
`;
