/**
 * The computers the agents work on, as an admin sets them up, on the rebuilt page (INV-1825): the
 * image this installation's own box runs and updating it, its CPU ceiling, starting it over, running
 * commands on the person's own machine, attaching another computer, and who may use each. What a
 * person does every day with a computer is in the computers view; this is its set-up.
 */
export const NEXT_SET_BOXES_JS = `
var boxSet = { config: null, image: null, limits: null, list: null, error: "", note: "", timer: 0, confirming: "" };

function loadBoxSet() {
  clearTimeout(boxSet.timer);
  getJson("/api/config").then(function (got) { boxSet.config = got; boxSet.error = ""; }, function (error) { boxSet.config = {}; boxSet.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  var also = function (path, keep) { getJson(path).then(function (got) { keep(got); if (next.view === "settings") render(); }, function () {}); };
  also("/api/boxes", function (got) { boxSet.list = got; });
  also("/api/box/limits", function (got) { boxSet.limits = got; });
  also("/api/box/image", function (got) {
    boxSet.image = got;
    // An update in progress is watched until it ends, and only while this pane is the one shown.
    if (got.running && next.view === "settings" && settings.pane === "boxes") boxSet.timer = setTimeout(loadBoxSet, 3000);
  });
  loadBoxMore();
}

/** Whether an image has something newer to move to, and what to say of it. */
function imageWord(state) {
  if (!state) return "unknown";
  if (state.runningId && state.expectedId && state.runningId === state.expectedId) return "current";
  return state.available ? "ready" : state.needsPull ? "pull" : "behind";
}

function imageBlock() {
  if (!boxSet.image) return null;
  var box = el("section", "setting"), image = boxSet.image, state = image.state || {}, acts = el("div", "acts"), backup = el("input"), keep = el("label", "tool");
  box.appendChild(el("h2", "group", t("ui.next.boxset.image")));
  box.appendChild(fact(t("ui.next.boxset.running"), state.runningRef || "—"));
  box.appendChild(fact(t("ui.next.boxset.expected"), (state.expectedRef || "—") + " · " + t("ui.next.boxset.image." + imageWord(image.state))));
  if (image.last) box.appendChild(el("p", "why", t("ui.next.boxset.last", { outcome: image.last.outcome, when: new Date(image.last.at).toLocaleString() }) + (image.last.detail ? " · " + image.last.detail : "")));
  if (image.running) {
    box.appendChild(el("div", "needbox", t("ui.next.boxset.updating")));
    var log = el("pre", "raw"); log.textContent = (image.progress || []).slice(-12).join(String.fromCharCode(10)); box.appendChild(log);
    return box;
  }
  backup.type = "checkbox"; backup.checked = true; keep.appendChild(backup); keep.appendChild(document.createTextNode(" " + t("ui.next.boxset.backup")));
  var check = el("button", "act", t("ui.next.boxset.check")), later = el("button", "act-primary", t("ui.next.boxset.whenIdle")), now = el("button", "act", t("ui.next.boxset.now"));
  var start = function (body) { postJson("/api/box/image/update", body).then(function () { boxSet.confirming = ""; loadBoxSet(); }, function (error) { failed(error); loadBoxSet(); }); };
  check.addEventListener("click", function () { check.disabled = true; postJson("/api/box/image/check", {}).then(function (got) { boxSet.image = got; render(); }, function (error) { check.disabled = false; failed(error); }); });
  later.addEventListener("click", function () { start({ whenIdle: true, backup: backup.checked }); });
  now.addEventListener("click", function () {
    // Interrupting running work is said, and asked for twice.
    if (boxSet.confirming !== "now") { boxSet.confirming = "now"; render(); return; }
    start({ interrupt: true, backup: backup.checked });
  });
  if (boxSet.confirming === "now") { now.className = "act-danger"; now.textContent = t("ui.next.boxset.nowSure"); }
  acts.appendChild(check);
  if (imageWord(image.state) !== "current") { acts.appendChild(later); acts.appendChild(now); box.appendChild(keep); }
  box.appendChild(acts);
  return box;
}

function limitsAndResetBlock() {
  var box = el("section", "setting"), limits2 = boxSet.limits;
  box.appendChild(el("h2", "group", t("ui.next.boxset.resources")));
  if (limits2) {
    var cpus = el("input"), save = el("button", "act", t("ui.next.settings.save")), row = el("div", "acts");
    cpus.value = limits2.chosen || ""; cpus.placeholder = limits2.default || ""; cpus.disabled = !!limits2.fromEnvironment; cpus.inputMode = "decimal";
    save.disabled = cpus.disabled;
    save.addEventListener("click", function () {
      postJson("/api/box/limits", { cpus: cpus.value.trim() || null }).then(function (got) { boxSet.limits = got; toast(t("ui.next.settings.saved2")); render(); }, failed);
    });
    row.appendChild(cpus); row.appendChild(save);
    box.appendChild(labelled(t("ui.next.boxset.cpus", { engine: limits2.engine === null || limits2.engine === undefined ? "?" : limits2.engine }), row));
    if (limits2.fromEnvironment) box.appendChild(el("p", "why", t("ui.next.boxset.cpusFromEnv")));
    if (limits2.notApplied) box.appendChild(el("p", "why", limits2.notApplied));
  }
  // Starting the box over throws away everything in it that is not in its work folder: its name must be typed.
  var fold = el("details", "fold"), body = el("div", "fold-body"), typed = el("input"), reset = el("button", "act-danger", t("ui.next.boxset.reset"));
  fold.appendChild(el("summary", "", t("ui.next.boxset.resetTitle")));
  body.appendChild(el("p", "why", t("ui.next.boxset.resetNote")));
  typed.placeholder = t("ui.next.boxset.resetPlaceholder");
  reset.addEventListener("click", function () {
    if (!typed.value.trim()) { typed.focus(); return; }
    postJson("/api/box/reset", { confirm: typed.value.trim() }).then(function () { toast(t("ui.next.boxset.resetStarted")); loadBoxSet(); }, failed);
  });
  body.appendChild(typed); body.appendChild(reset); fold.appendChild(body); box.appendChild(fold);
  return box;
}

/** Settings of this pane that are saved with the installation's configuration and take effect after a restart. */
function hostBlock() {
  var config = boxSet.config || {}, saved = config.config || {}, host = config.hostExec || {}, box = el("section", "setting");
  if (!(settings.me && settings.me.role === "admin")) return null;
  var on = el("input"), onLabel = el("label", "tool"), cwd = el("input"), startup = el("input"), startupLabel = el("label", "tool"), image = el("input"), save = el("button", "act-primary", t("ui.next.settings.save"));
  box.appendChild(el("h2", "group", t("ui.next.boxset.host")));
  on.type = "checkbox"; on.checked = !!host.enabled; onLabel.appendChild(on); onLabel.appendChild(document.createTextNode(" " + t("ui.next.boxset.hostOn")));
  cwd.value = host.cwd || ""; cwd.placeholder = t("ui.next.boxset.hostDir");
  startup.type = "checkbox"; startup.checked = !!saved.startupItem; startupLabel.appendChild(startup); startupLabel.appendChild(document.createTextNode(" " + t("ui.next.boxset.startup")));
  image.value = saved.boxImage || ""; image.placeholder = t("ui.next.boxset.imageDefault");
  box.appendChild(onLabel); box.appendChild(labelled(t("ui.next.boxset.hostDirLabel"), cwd));
  if (host.unavailableReason) box.appendChild(el("p", "why", host.unavailableReason));
  box.appendChild(startupLabel); box.appendChild(labelled(t("ui.next.boxset.imageOverride"), image));
  if (boxSet.note) box.appendChild(el("p", "why", boxSet.note));
  save.addEventListener("click", function () {
    if (on.checked && !cwd.value.trim()) { cwd.focus(); toast(t("ui.next.boxset.hostNeedsDir")); return; }
    // Only this pane's settings are sent: what is not named, the server leaves as it is.
    var body = { hostExec: { enabled: on.checked, cwd: cwd.value.trim() || null }, startupItem: startup.checked, boxImage: image.value.trim() || null };
    postJson("/api/config", body).then(function (got) { boxSet.note = got.restartNeeded ? t("ui.next.doors.restart") : (got.note || t("ui.next.settings.saved2")); loadBoxSet(); }, function (error) {
      // The model may be what is not in effect; this pane's own settings were saved and wait for a restart.
      if (error.data && error.data.saved) { boxSet.note = t("ui.next.doors.restart"); loadBoxSet(); } else failed(error);
    });
  });
  box.appendChild(save);
  if (boxSet.note === t("ui.next.doors.restart")) {
    var restart = el("button", "act", t("ui.next.boxset.restart"));
    restart.addEventListener("click", function () { postJson("/api/restart", {}).then(function () { toast(t("ui.next.boxset.restarting")); }, failed); });
    box.appendChild(restart);
  }
  return box;
}

/** Another computer attached to this installation, and who may use each one. */
function attachBlock() {
  if (!boxSet.list) return null;
  var box = el("section", "setting"), list = boxSet.list.boxes || [], own = boxSet.list.own;
  box.appendChild(el("h2", "group", t("ui.next.boxset.attached")));
  list.forEach(function (machine) {
    var line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts");
    text.appendChild(el("b", "", machine.name));
    text.appendChild(el("div", "why", [machine.kind, t(machine.connected ? "ui.next.box.on" : "ui.next.box.off"), t("ui.next.boxset.agents", { n: machine.agents || 0 }), machine.membersLabel || ""].filter(Boolean).join(" · ")));
    if (settings.me && settings.me.role === "admin") {
      var open = el("button", "act", t("ui.next.boxset.everyone"));
      open.addEventListener("click", function () { postJson("/api/boxes/update", { name: machine.name, members: "everyone" }).then(loadBoxSet, failed); });
      if (machine.members && machine.members !== "everyone") acts.appendChild(open);
    }
    if (machine.id !== own) {
      var detach = el("button", "act", t("ui.next.boxset.detach"));
      detach.disabled = (machine.agents || 0) > 0; detach.title = detach.disabled ? t("ui.next.boxset.detachBusy") : "";
      detach.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.boxset.detachSure"));
        sure.addEventListener("click", function () { postJson("/api/boxes/detach", { name: machine.name }).then(function () { loadBoxSet(); refreshSoon(); }, failed); });
        detach.replaceWith(sure);
      });
      acts.appendChild(detach);
    }
    line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  var fold = el("details", "fold"), body = el("div", "fold-body"), name = el("input"), url = el("input"), token = el("input"), go = el("button", "act", t("ui.next.boxset.attach"));
  fold.appendChild(el("summary", "", t("ui.next.boxset.attachTitle")));
  token.type = "password"; token.autocomplete = "off"; url.placeholder = t("ui.next.boxset.urlPlaceholder");
  go.addEventListener("click", function () {
    var missing = [name, url, token].filter(function (input) { return !input.value.trim(); })[0];
    if (missing) { missing.focus(); return; }
    go.disabled = true;
    postJson("/api/boxes/attach", { name: name.value.trim(), baseUrl: url.value.trim(), token: token.value.trim(), displayFloor: 1 }).then(function () {
      token.value = ""; toast(t("ui.next.boxset.attachedOk")); loadBoxSet(); refreshSoon();
    }, function (error) { token.value = ""; go.disabled = false; failed(error); });
  });
  [el("p", "why", t("ui.next.boxset.attachNote")), labelled(t("ui.next.member.name"), name), labelled(t("ui.next.boxset.url"), url), labelled(t("ui.next.boxset.token"), token), go].forEach(function (node) { body.appendChild(node); });
  fold.appendChild(body); box.appendChild(fold);
  return box;
}

function renderBoxesPane(view) {
  if (boxSet.config === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadBoxSet(); return; }
  if (boxSet.error) view.appendChild(el("p", "why", boxSet.error));
  [imageBlock(), limitsAndResetBlock(), hostBlock(), attachBlock(), quotaBlock(), nodesBlock(), diagnosticsBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
