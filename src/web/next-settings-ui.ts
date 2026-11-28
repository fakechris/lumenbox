/**
 * Settings and automation in the rebuilt page (INV-1825).
 *
 * Settings starts with the one setting this work added and a person asked to have on the page: how
 * far the host may carry work on unattended. The rest of the settings are still the classic page's,
 * and this says so rather than half-rebuilding them. Automation is the routines: what starts by
 * itself, when next, and a switch.
 */
export const NEXT_SETTINGS_JS = `
var settings = { long: null, routines: null, setup: null, pane: "", me: null };

function canOperateInstallation() { return !!settings.me && settings.me.role === "admin"; }
function canDriveAgents() { return canOperateInstallation() || (!!settings.me && settings.me.role === "driver"); }
function settingsPanes() {
  return canOperateInstallation() ? SETTING_PANES.concat(shellPanes()) : canDriveAgents() ? ["mine", "memory"] : [];
}

function numberField(labelText, value, min, max) {
  var label = el("label", "", labelText), input = el("input");
  input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1"; input.value = String(value);
  label.appendChild(input);
  return { label: label, input: input };
}

function settingsPane(key) { return Object.hasOwn(NATIVE_PANES, key) ? key : ""; }
function openSettingsPane(key) {
  if (!canDriveAgents() || (key && settingsPanes().indexOf(key) < 0)) return;
  if (key === "boxes" && boxSet.config !== null) loadBoxSet();
  navigateView("settings", key);
}

function renderSettings(view) {
  var panes = settingsPanes(), admin = canOperateInstallation();
  if (panes.indexOf(settings.pane) >= 0) {
    var back = el("button", "file", "‹ " + t("ui.next.side.settings") + " · " + t("ui.pane." + settings.pane));
    back.addEventListener("click", function () { openSettingsPane(""); });
    view.appendChild(back);
    NATIVE_PANES[settings.pane](view);
    return;
  }
  if (!panes.length) return;
  if (admin) renderLongWork(view);
  var more = el("div", "list");
  if (admin) more.appendChild(el("h2", "group", t("ui.next.settings.more")));
  panes.forEach(function (key) {
    var row = el("button", "row"), body = el("span", "body");
    body.appendChild(el("div", "title", t("ui.pane." + key)));
    body.appendChild(el("div", "why", t("ui.pane." + key + ".about")));
    row.appendChild(body);
    row.addEventListener("click", function () { openSettingsPane(key); });
    more.appendChild(row);
  });
  view.appendChild(more);
  if (!admin) return;
  var status = el("button", "row"), body = el("span", "body");
  body.appendChild(el("div", "title", t("ui.next.side.system")));
  body.appendChild(el("div", "why", t("ui.next.system.open")));
  status.appendChild(body);
  status.addEventListener("click", function () { system.state = null; navigateView("system"); });
  more.appendChild(status);
}

function renderLongWork(view) {
  if (!settings.long) {
    getJson("/api/long-work").then(function (got) { settings.long = got; if (next.view === "settings") render(); }, failed);
    return;
  }
  // One rough choice; the numbers behind it are for whoever wants them, folded away.
  var long = el("section", "setting"), fields = el("div", "fields"), save = el("button", "act-primary", t("ui.next.settings.save")), levels = el("div", "acts"), own = el("details", "fold");
  var slices = numberField(t("ui.next.settings.slices"), settings.long.continuations, 0, 1000);
  var hours = numberField(t("ui.next.settings.hours"), settings.long.activeHours, 1, 168);
  long.appendChild(el("h2", "group", t("ui.next.settings.long")));
  long.appendChild(el("p", "", t("ui.next.settings.effortNote")));
  ["lean", "standard", "open"].forEach(function (level) {
    var pick = el("button", "seg", t("ui.next.settings.effort." + level));
    pick.setAttribute("aria-pressed", String(!settings.long.custom && settings.long.effort === level));
    pick.addEventListener("click", function () { postJson("/api/long-work", { effort: level }).then(function (got) { settings.long = got; toast(t("ui.next.settings.saved")); render(); }, failed); });
    levels.appendChild(pick);
  });
  long.appendChild(levels);
  long.appendChild(el("p", "why", t("ui.next.settings.default", { slices: settings.long.continuations, hours: settings.long.activeHours })));
  own.appendChild(el("summary", "", t("ui.next.settings.ownNumbers")));
  own.appendChild(el("p", "why", t("ui.next.settings.longNote")));
  fields.appendChild(slices.label); fields.appendChild(hours.label);
  own.appendChild(fields);
  save.addEventListener("click", function () {
    postJson("/api/long-work", { continuations: Number(slices.input.value), activeHours: Number(hours.input.value) }).then(function (got) { settings.long = got; toast(t("ui.next.settings.saved")); render(); }, failed);
  });
  own.appendChild(save); own.open = !!settings.long.custom;
  long.appendChild(own);
  view.appendChild(long);
}

var SETTING_PANES = ["model", "boxes", "doors", "team", "mine", "memory", "supervision", "guests"];
var NATIVE_PANES = {
  mine: renderMinePane, model: renderModelPane, doors: renderDoorsPane, team: renderTeamPane, boxes: renderBoxesPane,
  memory: renderMemoryPane, supervision: renderSupervisionPane, guests: renderGuestsPane, machine: renderMachinePane, organisations: renderOrganisationsPane,
};

/**
 * Getting started, for an installation that has not yet done a piece of work: the few things an agent
 * needs before it can, each with the button that opens the place to do it. Gone once the first work
 * has been done and looked at, or when the person closes it.
 */
function createSetupBox() {
  if (settings.creatingBox) return;
  settings.boxRequest = settings.boxRequest || crypto.randomUUID();
  settings.creatingBox = true; render();
  postJson("/api/personal-boxes/create", { requestId: settings.boxRequest }).then(function (got) {
    var box = (got.boxes || []).find(function (row) { return row.id === got.boxId; });
    if (!box || box.status !== "ready") throw new Error(box && box.error || t("ui.next.box.off"));
    settings.boxRequest = ""; chat.box = box.id; chat.agentId = "";
    chat.entries = []; chat.live = null; chat.liveSurfaces = {}; chat.plan = null;
    chat.conversation = "main"; chat.loading = ""; chat.loadedFor = ""; chat.request++;
    chat.find = ""; chat.focus = "";
  }).catch(failed).finally(function () { settings.creatingBox = false; refresh(); });
}

function setupCard() {
  var state = settings.setup;
  if (!state || !canDriveAgents()) return null;
  var admin = canOperateInstallation(), here = state.byBox ? state.byBox[chat.box] || {} : state;
  var bootstrap = admin && state.bootstrapPending, card = el("div", "card-plain");
  if (bootstrap) {
    var link = el("a", "act", t("ui.channels.bootstrap-pending"));
    link.href = "/bootstrap"; card.appendChild(link);
  }
  // On an organisation (hasPersonalBox said) an Admin is a member like the others: their own box is the step, not the installation's (INV-2310).
  var organisation = state.hasPersonalBox !== undefined;
  if (!chat.box && state.hasPersonalBox !== false) return bootstrap ? card : null;
  var who = settings.me.identity || "operator";
  var storageKey = "lumen-setup-closed:" + state.installationId + ":" + who + ":" + chat.box;
  if ((admin && here.established) || localStorage.getItem(storageKey) === "1") return bootstrap ? card : null;
  var agent = agentsHere().length > 0, steps = admin ? [
    { key: "key", done: state.key, open: function () { openSettingsPane("model"); } },
    { key: "box", done: here.box, open: function () { openSettingsPane("boxes"); } },
    { key: "agent", done: agent, open: function () { openMember(""); } },
    { key: "door", done: state.door, optional: true, open: function () { openSettingsPane("doors"); } },
  ].filter(function (step) { return step.key !== "box" || !organisation; }) : chat.box ? [{ key: "agent", done: agent, open: function () { openMember(""); } }] : [];
  // A box made at first sign-in (INV-2203): said while it is prepared, why it failed, or that the quota is used up.
  if (organisation) steps.unshift({ key: "personalBox", done: state.hasPersonalBox, auto: state.autoBox,
    open: !state.autoBox ? createSetupBox : state.autoBox.state === "failed" ? function () { navigateView("boxes"); } : null });
  if (!admin && steps.every(function (step) { return step.done; })) return null;
  var close = el("button", "act", t("ui.next.act.close"));
  card.appendChild(el("div", "card-head", t("ui.next.setup.title")));
  steps.forEach(function (step) {
    var row = el("div", "setup-step"), go = el("button", "act", t("ui.next.setup.go"));
    row.appendChild(el("span", step.done ? "setup-done" : "setup-todo", step.done ? "✓" : "○"));
    var words = step.auto ? t("ui.next.setup.personalBox." + step.auto.state, { why: step.auto.reason || "" }) : t("ui.next.setup." + step.key);
    row.appendChild(el("span", "body", words + (step.optional ? " " + t("ui.next.setup.optional") : "")));
    if (step.key === "box") row.appendChild(el("span", step.done ? "chip-run" : "chip", t(step.done ? "ui.next.box.on" : "ui.next.box.off")));
    go.disabled = step.key === "personalBox" && !!settings.creatingBox;
    go.addEventListener("click", step.open);
    if (!step.done && step.open) row.appendChild(go);
    card.appendChild(row);
  });
  close.addEventListener("click", function () { localStorage.setItem(storageKey, "1"); render(); });
  card.appendChild(close);
  return card;
}
`;
