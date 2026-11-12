/**
 * Settings and automation in the rebuilt page (INV-1825).
 *
 * Settings starts with the one setting this work added and a person asked to have on the page: how
 * far the host may carry work on unattended. The rest of the settings are still the classic page's,
 * and this says so rather than half-rebuilding them. Automation is the routines: what starts by
 * itself, when next, and a switch.
 */
export const NEXT_SETTINGS_JS = `
var settings = { long: null, routines: null };

function numberField(labelText, value, min, max) {
  var label = el("label", "", labelText), input = el("input");
  input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1"; input.value = String(value);
  label.appendChild(input);
  return { label: label, input: input };
}

function renderSettings(view) {
  if (!settings.long) {
    getJson("/api/long-work").then(function (got) { settings.long = got; if (next.view === "settings") render(); }, failed);
    return;
  }
  var long = el("section", "setting"), fields = el("div", "fields"), save = el("button", "act-primary", t("ui.next.settings.save"));
  var slices = numberField(t("ui.next.settings.slices"), settings.long.continuations, 0, 1000);
  var hours = numberField(t("ui.next.settings.hours"), settings.long.activeHours, 1, 168);
  long.appendChild(el("h2", "group", t("ui.next.settings.long")));
  long.appendChild(el("p", "", t("ui.next.settings.longNote")));
  fields.appendChild(slices.label); fields.appendChild(hours.label);
  long.appendChild(fields);
  long.appendChild(el("p", "why", t("ui.next.settings.default", { slices: settings.long.defaults.continuations, hours: settings.long.defaults.activeHours })));
  save.addEventListener("click", function () {
    postJson("/api/long-work", { continuations: Number(slices.input.value), activeHours: Number(hours.input.value) }).then(function (got) { settings.long = got; toast(t("ui.next.settings.saved")); render(); }, failed);
  });
  long.appendChild(save);
  view.appendChild(long);
  var more = el("section", "setting"), link = el("a", "act", t("ui.next.settings.openClassic"));
  link.href = "/?ui=classic";
  more.appendChild(el("h2", "group", t("ui.next.settings.more")));
  more.appendChild(el("p", "", t("ui.next.settings.moreNote")));
  more.appendChild(link);
  view.appendChild(more);
}

function renderAuto(view) {
  if (!settings.routines) {
    getJson("/api/schedules").then(function (got) { settings.routines = got.schedules || []; if (next.view === "auto") render(); }, failed);
    return;
  }
  if (settings.routines.length === 0) { view.appendChild(el("p", "empty", t("ui.next.auto.empty"))); return; }
  var list = el("div", "list");
  settings.routines.forEach(function (routine) {
    var row = el("div", "row"), body = el("span", "body"), toggle = el("button", "act", t(routine.paused ? "ui.next.auto.resume" : "ui.next.auto.pause"));
    var when = routine.nextRun ? t("ui.next.auto.next", { when: new Date(routine.nextRun).toLocaleString() }) : t("ui.next.auto.event");
    body.appendChild(el("div", "title", routine.name || routine.slug));
    body.appendChild(el("div", "why", [routine.described || routine.schedule || "", when].filter(Boolean).join(" · ")));
    row.appendChild(el("span", "who", initial(routine.agent || routine.name)));
    row.appendChild(body);
    row.appendChild(el("span", routine.paused ? "chip" : "chip-run", t(routine.paused ? "ui.next.auto.paused" : "ui.next.auto.on")));
    toggle.addEventListener("click", function () {
      postJson(routine.paused ? "/api/schedules/resume" : "/api/schedules/pause", { slug: routine.slug }).then(function () { settings.routines = null; render(); }, failed);
    });
    row.appendChild(toggle);
    list.appendChild(row);
  });
  view.appendChild(list);
}
`;
