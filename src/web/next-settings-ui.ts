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
  // Settings → Organisation leads an Admin's list on an organisation (INV-2311).
  return canOperateInstallation() ? (isOrganisation() ? ["organisation"] : []).concat(SETTING_PANES, shellPanes()) : canDriveAgents() ? ["mine", "memory"] : [];
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
  memory: renderMemoryPane, supervision: renderSupervisionPane, guests: renderGuestsPane, machine: renderMachinePane, organisations: renderOrganisationsPane, organisation: renderOrganisationPane,
};
`;
