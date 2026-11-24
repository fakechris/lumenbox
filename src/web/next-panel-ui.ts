/**
 * The work panel, overview level (INV-1825, docs/99 §6): what is asked of the person, the result,
 * how far it is, and what happened — in that order, because that is the order a person needs them.
 *
 * The record itself is the diagnostics tab (next-diagnostics-ui.ts), one explicit click away.
 */
export const NEXT_PANEL_JS = `
var panel = { taskId: "", task: null, steps: [], total: 0, snapshot: "", coverage: "", tab: "overview" };

function section(title) { var box = el("section"); box.appendChild(el("h2", "group", title)); return box; }
function duration(ms) {
  var minutes = Math.round(ms / 60000);
  return minutes >= 60 ? t("ui.next.panel.hours", { n: Math.round(minutes / 6) / 10 }) : t("ui.next.panel.minutes", { n: minutes });
}
function bytes(size) { return size >= 1048576 ? (size / 1048576).toFixed(1) + " MB" : size >= 1024 ? Math.round(size / 1024) + " KB" : size + " B"; }
function clock(iso) { var at = new Date(iso || ""); return isNaN(at.getTime()) ? "" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

function updateTask(change, done) {
  postJson("/api/tasks/update", Object.assign({ id: panel.taskId }, change)).then(function () { toast(done); loadPanel(); refreshSoon(); }, failed);
}

function modelAuthBlock(task) {
  if (task.reading?.blocker?.kind !== "model_auth_rejected" || nextStateOf(task).key !== "stuck") return null;
  var admin = canOperateInstallation(), box = el("div", "needbox");
  box.appendChild(el("b", "", t("ui.wr.blocker.model_auth_rejected")));
  box.appendChild(el("div", "", t(admin ? "ui.next.panel.modelAuthAdmin" : "ui.next.panel.modelAuthMember")));
  if (admin) {
    var acts = el("div", "acts"), button = el("button", "act-primary", t("ui.next.composer.modelSettings"));
    button.addEventListener("click", function () { if (canOperateInstallation()) { closePanel(); openSettingsPane("model"); } });
    acts.appendChild(button); box.appendChild(acts);
  }
  return box;
}

/** What the person is asked on this work, with the buttons that answer it. */
function needBlock(task) {
  var stage = task.stage || "", box = el("div", "needbox"), acts = el("div", "acts"), last = (task.history || [])[task.history.length - 1] || {};
  (task.needsApprovals || []).forEach(function (approval) {
    var line = el("div", "", approval.description), row = el("div", "acts");
    var approve = el("button", "act-primary", t("ui.next.act.approve")), deny = el("button", "act", t("ui.next.act.deny"));
    approve.addEventListener("click", function () { postJson("/api/approve", { id: approval.id, scope: "once" }).then(function () { toast(t("ui.next.done.approved")); loadPanel(); refreshSoon(); }, failed); });
    deny.addEventListener("click", function () { postJson("/api/deny", { id: approval.id }).then(function () { toast(t("ui.next.done.denied")); loadPanel(); refreshSoon(); }, failed); });
    row.appendChild(approve); row.appendChild(deny); box.appendChild(line); box.appendChild(row);
  });
  if (task.reading && task.reading.phase === "proposal") {
    box.appendChild(el("div", "", t("ui.next.panel.proposal", { name: agentName(task.proposedBy || task.requester) })));
    var commit = el("button", "act-primary", t("ui.next.act.commit")), dismiss = el("button", "act", t("ui.next.act.dismiss"));
    commit.addEventListener("click", function () { postJson("/api/tasks/commit", { id: task.id }).then(function () { toast(t("ui.next.done.committed")); loadPanel(); refreshSoon(); }, failed); });
    dismiss.addEventListener("click", function () { updateTask({ status: "dropped", note: t("ui.next.note.dismissed") }, t("ui.next.done.dismissed")); });
    acts.appendChild(commit); acts.appendChild(dismiss);
  } else if (stage === "person/review") {
    box.appendChild(el("div", "", task.ask ? task.ask.title : t("ui.next.panel.review")));
    if (task.ask && (task.ask.said || []).length) box.appendChild(askBlock(task.ask));
    signOffLines(task).forEach(function (line) { box.appendChild(line); });
    box.appendChild(el("div", "why", t("ui.next.chat.reviewHint", { name: agentName(task.assigneeId) })));
    var accept = el("button", "act-primary", t("ui.next.act.accept")), changes = el("button", "act", t("ui.next.act.changes"));
    accept.addEventListener("click", function () { updateTask({ status: "done" }, t("ui.next.done.accepted")); });
    changes.addEventListener("click", function () {
      var input = el("textarea"), send = el("button", "act-primary", t("ui.next.act.send"));
      input.placeholder = t("ui.next.panel.changesPlaceholder");
      send.addEventListener("click", function () {
        if (!input.value.trim()) return;
        updateTask({ status: "doing", note: input.value.trim() }, t("ui.next.done.sent", { name: agentName(task.assigneeId) }));
      });
      acts.replaceChildren(send); box.insertBefore(input, acts); input.focus();
    });
    acts.appendChild(accept); acts.appendChild(changes);
  } else if (nextNeedOf(task)) {
    // The agent's request and its buttons, drawn by the same code as the card in the conversation (next-need-ui.ts).
    if (task.ask) box.appendChild(el("b", "", task.ask.title));
    needInto(box, task, true);
  } else if ((stage === "person/answer" || stage === "person/blocked") && last.note) box.appendChild(el("div", "", last.note));
  if (acts.childNodes.length) box.appendChild(acts);
  return box.childNodes.length ? box : null;
}

/** Who writes a note to keep the books rather than to say what was done (task-board-record.ts lastReport). */
var HOST_NOTES = { aging: 1, "audit-guard": 1, "review-guard": 1, restart: 1, host: 1, channel: 1 };
function resultBlock(task) {
  var box = section(t("ui.next.panel.result")), files = task.deliverables || [], evidence = (task.reading && task.reading.evidence) || [];
  files.forEach(function (file) {
    var link = el("a", "file");
    link.href = "/api/tasks/deliverable?task=" + encodeURIComponent(task.id) + "&id=" + encodeURIComponent(file.id);
    var name = el("span", "", file.name + (file.note ? " — " + file.note : ""));
    link.appendChild(name); link.appendChild(el("span", "", bytes(file.size)));
    box.appendChild(link);
  });
  evidence.forEach(function (line) { box.appendChild(el("div", "file", line)); });
  // What was said about the work, newest first: for work with no file this is the result.
  var said = (task.history || []).filter(function (change, index) { return change.note && !HOST_NOTES[change.by] && !(index === 0 && change.at === task.createdAt); }).slice(-3).reverse();
  said.forEach(function (change) {
    // The newest report comes read into its parts when it was written as a delivery; here every part is shown.
    var report = task.report && task.report.at === change.at && task.report.by === change.by ? task.report : { note: change.note };
    if (!report.parts && !report.note) return; // all of it was the request to the person, which stands above
    box.appendChild(el("div", "why", (agentName(change.by) === change.by ? originOf({ requester: change.by }) : agentName(change.by)) + " · " + agoText(change.at)));
    box.appendChild(reportBlock(report, REPORT_ORDER));
  });
  if (files.length === 0 && evidence.length === 0 && said.length === 0) box.appendChild(el("p", "why", t("ui.next.panel.noResult")));
  return box;
}

var SOURCE_KEY = { "agent-reported": "agent", "host-observed": "host", "independent-verifier": "verifier" };

function progressBlock(task) {
  var sources = ((task.progress && task.progress.sources) || []).filter(function (row) { return !row.stale; });
  var pursuit = task.pursuit;
  if (sources.length === 0 && !pursuit) return null;
  var box = section(t("ui.next.panel.progress")), counts = el("div", "tallies");
  function count(value, label, source) {
    if (typeof value !== "number") return;
    var cell = el("div", "tally");
    cell.appendChild(el("b", "", value)); cell.appendChild(el("span", "", t("ui.next.count." + label)));
    cell.appendChild(el("small", "", t("ui.next.source." + (SOURCE_KEY[source] || "agent"))));
    counts.appendChild(cell);
  }
  var main = sources.filter(function (row) { return row.source !== "independent-verifier"; })[0];
  if (main) {
    var stage = processText(main.stage), unit = processText(main.unit);
    var tally = typeof main.total === "number" ? main.processed + " / " + main.total + (unit ? " " + unit : "") : "";
    box.appendChild(el("div", "why", [stage, tally].filter(Boolean).join(" · ")));
    count(main.processed, "processed", main.source); count(main.succeeded, "succeeded", main.source);
    if (main.failed) count(main.failed, "failed", main.source);
    if (main.unknown) count(main.unknown, "unknown", main.source);
  }
  var verifier = sources.filter(function (row) { return row.source === "independent-verifier"; })[0];
  if (verifier) count(verifier.verified, "verified", verifier.source);
  if (counts.childNodes.length) box.appendChild(counts);
  if (pursuit) {
    var budget = el("div", "budget");
    budget.appendChild(el("span", "", t("ui.next.panel.slice", { n: pursuit.spent.continuations + 1, max: pursuit.limits.continuations + 1 })));
    budget.appendChild(el("span", "", t("ui.next.panel.active", { used: duration(pursuit.spent.activeMs), max: duration(pursuit.limits.activeMs) })));
    box.appendChild(budget);
  }
  return box;
}

function processText(value) {
  return typeof value === "string" && value !== "[object Object]" ? value : "";
}

function processBlock(task) {
  if (panel.steps.length === 0) return null; // nothing ran on record: no heading over an empty space
  var box = section(t("ui.next.panel.process"));
  var list = el("ul", "steps");
  var hasFiles = (task.deliverables || []).length > 0, submitted = task.delivery && task.delivery.submitted;
  if (hasFiles || submitted) box.appendChild(el("p", "why", t(hasFiles ? "ui.next.step.filesDelivered" : "ui.next.step.resultSubmitted")));
  panel.steps.slice(-12).forEach(function (step) {
    var line = el("li"), flagged = step.outcome !== "succeeded" && MSG["ui.next.step." + step.outcome];
    var updateFailed = step.metadataUpdate && (step.outcome === "failed" || step.outcome === "refused");
    var label = updateFailed
      ? t("ui.next.step.metadataFailed") + " " + t(hasFiles || submitted ? "ui.next.step.metadataDeliveryIntact" : "ui.next.step.metadataRetry")
      : [processText(step.name), processText(step.detail)].filter(Boolean).join(" ");
    line.appendChild(el("b", "", agentName(step.agentId)));
    line.appendChild(el("span", "what", label));
    if (flagged && !updateFailed) line.appendChild(el("span", "flag" + (step.outcome === "failed" || step.outcome === "refused" ? " bad" : ""), t("ui.next.step." + step.outcome)));
    line.appendChild(el("time", "", clock(step.endedAt || step.startedAt)));
    list.appendChild(line);
  });
  box.appendChild(list);
  if (panel.total > 12) box.appendChild(el("p", "why", t("ui.next.more", { n: panel.total - 12 })));
  return box;
}

/** Stopping is two steps on purpose: the first shows what stops, the second does it. */
function stopBlock(task) {
  var links = el("div", "foot-links");
  if (task.assigneeId && (!task.conversation || task.conversation === "main")) { // another conversation is linked from the line that says where it was asked
    var chat = el("a", "", t("ui.next.act.openChat"));
    chat.href = "/?agent=" + encodeURIComponent(task.assigneeId);
    links.appendChild(chat);
  }
  var record = el("a", "", t("ui.next.act.fullRecord"));
  // The classic page's task view, for one look: the page the person uses stays the one they chose.
  record.href = "/?ui=classic&once=1&agent=" + encodeURIComponent(task.assigneeId || "") + "&task=" + encodeURIComponent(task.id);
  links.appendChild(record);
  if (task.status === "done" || task.status === "dropped") return links;
  // Put off: nobody is reminded of it until then. Said back with the day, and undone from the same place.
  var later = Date.parse(task.snoozeUntil || "") > Date.now();
  var snooze = el("button", "", later ? t("ui.next.act.unsnooze", { when: new Date(task.snoozeUntil).toLocaleDateString() }) : t("ui.next.act.snooze"));
  snooze.addEventListener("click", function () {
    if (later) { updateTask({ snoozeUntil: "" }, t("ui.next.done.unsnoozed")); return; }
    var pick = el("span", "acts");
    nextLaterTimes(new Date()).forEach(function (time) {
      var day = el("button", "act", t("ui.next.later." + time.key));
      day.addEventListener("click", function () { updateTask({ snoozeUntil: time.at }, t("ui.next.done.snoozed", { when: new Date(time.at).toLocaleDateString() })); });
      pick.appendChild(day);
    });
    snooze.replaceWith(pick);
  });
  links.appendChild(snooze);
  var stop = el("button", "", t("ui.next.act.stop"));
  stop.addEventListener("click", function () {
    getJson("/api/work-control/preview?taskId=" + encodeURIComponent(task.id)).then(function (preview) {
      var confirm = el("button", "act-danger", t("ui.next.act.stopConfirm")), note = el("span", "", t("ui.next.panel.stopNote"));
      confirm.addEventListener("click", function () {
        var done = function () { toast(t("ui.next.done.stopped")); loadPanel(); refreshSoon(); };
        if (preview.token) postJson("/api/work-control/cancel", { taskId: task.id, token: preview.token }).then(done, failed);
        else updateTask({ status: "dropped" }, t("ui.next.done.stopped"));
      });
      links.replaceChildren(note, confirm);
    }, function () {
      // Without the admin's preview the board's own rule still applies: the requester may drop their task.
      updateTask({ status: "dropped" }, t("ui.next.done.stopped"));
    });
  });
  links.appendChild(stop);
  return links;
}

function renderPanel() {
  var task = panel.task, inner = $("panel-inner"), state = nextStateOf(task);
  $("panel-chip").className = "chip " + state.tone; $("panel-chip").textContent = t("ui.next.state." + state.key);
  $("panel-who").textContent = agentName(task.assigneeId) + " · " + agoText(task.updatedAt);
  inner.replaceChildren();
  document.querySelectorAll("[data-tab]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.tab === panel.tab)); });
  inner.appendChild(el("h3", "", task.title));
  if (panel.tab === "diagnostics") { renderDiagnostics(inner, task); inner.appendChild(gateBlock(task)); return; }
  var from = el("p", "why", originOf(task));
  if (task.assigneeId && task.conversation && task.conversation !== "main") {
    var there = el("button", "elsewhere", t("ui.next.panel.where", { where: conversationLabel(task.conversation) }));
    there.addEventListener("click", function () { showConversation(task.assigneeId, task.conversation); });
    nameConversation(task.assigneeId, task.conversation, function () { there.textContent = t("ui.next.panel.where", { where: conversationLabel(task.conversation) }); }); // the label alone: a redraw would drop a note being typed
    from.appendChild(document.createTextNode(" · ")); from.appendChild(there);
  }
  inner.appendChild(from);
  if (task.description && task.description !== task.title) {
    // The request as it was written, links and lists intact; a long one is folded so the result is not pushed off the screen.
    var asked = rich(task.description, "report");
    if (task.description.length > 600) { var fold = el("details", "fold"); fold.appendChild(el("summary", "", t("ui.next.panel.askedFold"))); fold.appendChild(asked); inner.appendChild(fold); }
    else inner.appendChild(asked);
  }
  [modelAuthBlock(task), needBlock(task), resultBlock(task), progressBlock(task), processBlock(task),
    dependsBlock(task), manageBlock(task), stopBlock(task)].forEach(function (block) { if (block) inner.appendChild(block); });
}

function loadPanel() {
  var id = panel.taskId;
  if (!id) return;
  getJson("/api/tasks/item?task=" + encodeURIComponent(id)).then(function (got) {
    if (panel.taskId !== id) return;
    panel.task = got.task;
    renderPanel();
    // The process is a second read: the panel is already useful without it, and a viewer may not have it.
    return getJson("/api/tasks/execution?task=" + encodeURIComponent(id) + "&limit=50").then(function (page) {
      if (panel.taskId !== id) return;
      panel.steps = (page.steps || []).filter(function (step) { return step.kind === "tool"; });
      panel.total = page.total || panel.steps.length; panel.snapshot = page.snapshot || ""; panel.coverage = page.coverage || "";
      renderPanel();
    }, function () {});
  }, failed);
}

function openPanel(taskId) {
  panel.taskId = taskId; panel.task = null; panel.steps = []; panel.total = 0; panel.tab = "overview"; diag.open = ""; diag.detail = null;
  $("panel-inner").replaceChildren(); $("panel-chip").textContent = ""; $("panel-who").textContent = "";
  $("panel").hidden = false; $("scrim").hidden = false;
  loadPanel();
}
function closePanel() { panel.taskId = ""; $("panel").hidden = true; $("scrim").hidden = true; }
var panelTimer = 0;
function panelChanged(taskId) { if (panel.taskId === taskId) { clearTimeout(panelTimer); panelTimer = setTimeout(loadPanel, 500); } }
function panelStart() {
  $("panel-close").addEventListener("click", closePanel);
  $("scrim").addEventListener("click", closePanel);
  document.querySelectorAll("[data-tab]").forEach(function (button) {
    button.addEventListener("click", function () { panel.tab = button.dataset.tab; if (panel.task) renderPanel(); });
  });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape" && panel.taskId) closePanel(); });
}
`;
