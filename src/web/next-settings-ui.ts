/**
 * Settings and automation in the rebuilt page (INV-1825).
 *
 * Settings starts with the one setting this work added and a person asked to have on the page: how
 * far the host may carry work on unattended. The rest of the settings are still the classic page's,
 * and this says so rather than half-rebuilding them. Automation is the routines: what starts by
 * itself, when next, and a switch.
 */
export const NEXT_SETTINGS_JS = `
var settings = { long: null, routines: null, setup: null };

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
  // The other settings are the classic page's dialogs, opened here in a frame until each is rebuilt (embed-ui.ts).
  var more = el("div", "list");
  more.appendChild(el("h2", "group", t("ui.next.settings.more")));
  SETTING_PANES.forEach(function (key) {
    var row = el("button", "row"), body = el("span", "body");
    body.appendChild(el("div", "title", t("ui.pane." + key)));
    body.appendChild(el("div", "why", t("ui.pane." + key + ".about")));
    row.appendChild(body);
    row.addEventListener("click", function () { openEmbed("settings", key); });
    more.appendChild(row);
  });
  view.appendChild(more);
  var status = el("button", "row"), body = el("span", "body");
  body.appendChild(el("div", "title", t("ui.next.side.system")));
  body.appendChild(el("div", "why", t("ui.next.system.open")));
  status.appendChild(body);
  status.addEventListener("click", function () { next.view = "system"; system.state = null; render(); });
  more.appendChild(status);
}

var SETTING_PANES = ["model", "boxes", "doors", "team", "mine", "memory", "supervision", "guests"];

/** A classic dialog in a frame over the page; it says when it has closed, and the frame goes. */
function openEmbed(kind, tab) {
  var frame = $("embed");
  frame.src = "/?embed=" + kind + (tab ? "&tab=" + encodeURIComponent(tab) : "") + "&lang={{@locale}}";
  frame.hidden = false;
}
function embedStart() {
  window.addEventListener("message", function (event) {
    if (event.origin !== location.origin || !event.data || event.data.lumen !== "embed-closed") return;
    var frame = $("embed");
    frame.hidden = true; frame.removeAttribute("src");
    settings.long = null; refresh();
  });
}

/**
 * Getting started, for an installation that has not yet done a piece of work: the few things an agent
 * needs before it can, each with the button that opens the place to do it. Gone once the first work
 * has been done and looked at, or when the person closes it.
 */
function setupCard() {
  var state = settings.setup;
  if (!state || state.established || localStorage.getItem("lumen-setup-closed:" + state.installationId) === "1") return null;
  var steps = [
    { key: "key", done: state.key, open: function () { openEmbed("settings", "model"); } },
    { key: "box", done: state.box, open: function () { openEmbed("settings", "boxes"); } },
    { key: "agent", done: state.agentTurn || Object.keys(next.agents).length > 0, open: function () { openEmbed("shelf"); } },
    { key: "door", done: state.door, optional: true, open: function () { openEmbed("settings", "doors"); } },
  ];
  var card = el("div", "card-plain"), close = el("button", "act", t("ui.next.act.close"));
  card.appendChild(el("div", "card-head", t("ui.next.setup.title")));
  steps.forEach(function (step) {
    var row = el("div", "setup-step"), go = el("button", "act", t("ui.next.setup.go"));
    row.appendChild(el("span", step.done ? "setup-done" : "setup-todo", step.done ? "✓" : "○"));
    row.appendChild(el("span", "body", t("ui.next.setup." + step.key) + (step.optional ? " " + t("ui.next.setup.optional") : "")));
    go.addEventListener("click", step.open);
    if (!step.done) row.appendChild(go);
    card.appendChild(row);
  });
  close.addEventListener("click", function () { localStorage.setItem("lumen-setup-closed:" + state.installationId, "1"); render(); });
  card.appendChild(close);
  return card;
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
