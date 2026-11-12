/**
 * The less common things done to a piece of work, on the rebuilt page (INV-1825): what it waits on
 * and what waits on it, setting its status or level by hand, keeping what it found as the
 * organisation's knowledge, and — under diagnostics — what the policy gate decided at each step.
 * Detail and diagnostics only: none of it is on a row or a card.
 */
export const NEXT_PANEL_MORE_JS = `
var gate = { forId: "", data: null, error: "" };
var TASK_STATUSES = ["open", "doing", "blocked", "review", "done", "dropped"];

/** What it waits on and what waits on it; each opens that work. The list it waits on can be rewritten. */
function dependsBlock(task) {
  var waits = task.blockers || [], held = task.blocks || [];
  if (!waits.length && !held.length) return null;
  var box = section(t("ui.next.deps.title")), line = function (label, ids) {
    if (!ids.length) return;
    var row = el("div", "fact"), links = el("span", "acts");
    ids.forEach(function (id) { var open = el("button", "act", id); open.addEventListener("click", function () { openPanel(id); }); links.appendChild(open); });
    row.appendChild(el("span", "why", label)); row.appendChild(links); box.appendChild(row);
  };
  line(t("ui.next.deps.waitsOn"), waits.map(function (row) { return row.id; }));
  line(t("ui.next.deps.heldBy"), held);
  return box;
}

/** Set by hand: the status, the level, what it waits on. A fold, because the agent normally moves these itself. */
function manageBlock(task) {
  var fold = el("details", "fold"), body = el("div", "fold-body"), status = el("select"), waits = el("input"), save = el("button", "act", t("ui.next.settings.save"));
  var option = function (select, value, text, chosen) { var node = el("option", "", text); node.value = value; node.selected = chosen; select.appendChild(node); };
  var labelled = function (text, control) { var label = el("label", "", text); label.appendChild(control); return label; };
  fold.appendChild(el("summary", "", t("ui.next.manage.title"))); fold.appendChild(body);
  fold.open = panel.managing === task.id;
  fold.addEventListener("toggle", function () { panel.managing = fold.open ? task.id : ""; });
  TASK_STATUSES.forEach(function (value) { option(status, value, t("ui.next.status." + value), value === task.status); });
  body.appendChild(labelled(t("ui.next.manage.status"), status));
  var level = null;
  if (task.level) {
    level = el("select");
    [1, 2, 3, 4, 5].forEach(function (value) { option(level, String(value), "L" + value, value === task.level); });
    body.appendChild(labelled(t("ui.next.manage.level"), level));
  }
  waits.value = (task.blockedBy || []).join(", "); waits.placeholder = t("ui.next.deps.placeholder");
  body.appendChild(labelled(t("ui.next.deps.waitsOn"), waits));
  save.addEventListener("click", function () {
    var change = {};
    if (status.value !== task.status) change.status = status.value;
    if (level && Number(level.value) !== task.level) change.level = Number(level.value);
    if (waits.value.trim() !== (task.blockedBy || []).join(", ")) change.blockedBy = waits.value;
    if (Object.keys(change).length) updateTask(change, t("ui.next.settings.saved2"));
  });
  body.appendChild(save);
  if (task.status === "done") {
    // What a finished piece of work found, proposed as something the whole organisation knows; an admin's to do, reviewed before anybody reads it.
    var keep = el("button", "act", t("ui.next.manage.promote"));
    keep.addEventListener("click", function () {
      keep.disabled = true;
      postJson("/api/org-knowledge/promote", { scope: "org", task: task.id }).then(function () { toast(t("ui.next.manage.promoted")); }, function (error) { keep.disabled = false; failed(error); });
    });
    body.appendChild(keep);
  }
  return fold;
}

/** What the policy gate decided, step by step: counts first, the steps it stopped or asked about under them. */
function gateBlock(task) {
  var box = section(t("ui.next.gate.title"));
  if (gate.forId !== task.id) {
    gate.forId = task.id; gate.data = null; gate.error = "";
    getJson("/api/tasks/gate?task=" + encodeURIComponent(task.id)).then(function (got) { if (gate.forId === task.id) { gate.data = got; renderPanel(); } }, function (error) {
      if (gate.forId === task.id) { gate.error = error.message; renderPanel(); }
    });
  }
  if (gate.error) { box.appendChild(el("p", "why", gate.error)); return box; }
  if (!gate.data) { box.appendChild(el("p", "why", t("ui.next.auto.reading"))); return box; }
  var counts = gate.data.counts || {};
  box.appendChild(el("div", "ids", t("ui.next.gate.counts", { allowed: counts.allowed || 0, asked: counts.asked || 0, waiting: counts.waiting || 0, refused: counts.refused || 0, unchecked: gate.data.unchecked || 0 })));
  (gate.data.steps || []).filter(function (step) { return step.gate && step.gate.verdict !== "allowed"; }).slice(0, 40).forEach(function (step) {
    var row = el("div", "fact");
    row.appendChild(el("span", "why", (step.at ? clock(step.at) + " · " : "") + step.name + " · " + clip(step.detail, 80)));
    row.appendChild(el("span", step.gate.verdict === "refused" ? "bad" : "", step.gate.verdict + (step.gate.basis ? " · " + step.gate.basis : "")));
    box.appendChild(row);
  });
  if (gate.data.earlier) box.appendChild(el("p", "why", t("ui.next.more", { n: gate.data.earlier })));
  return box;
}
`;
