/**
 * The work panel's third level (INV-1825, docs/99 §6): the record as it is.
 *
 * Reached only through an explicit tab, never shown by default. Steps with their raw input and output,
 * what the work has used, its identifiers, and an export — for the day something went wrong and
 * somebody has to find out what.
 */
export const NEXT_DIAGNOSTICS_JS = `
var diag = { open: "", detail: null, usage: null, usageFor: "" };

function raw(value) {
  var text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return el("pre", "raw", text === undefined || text === null ? "" : text);
}

function stepDetail(detail) {
  var cell = el("td");
  cell.colSpan = 4;
  if (detail.sourceExpired) cell.appendChild(el("div", "why", t("ui.next.diag.expired")));
  cell.appendChild(el("div", "why", t("ui.next.diag.input") + (detail.inputTruncated ? " " + t("ui.next.diag.truncated") : "")));
  cell.appendChild(raw(detail.input));
  cell.appendChild(el("div", "why", t("ui.next.diag.output") + (detail.resultTruncated ? " " + t("ui.next.diag.truncated") : "")));
  cell.appendChild(raw(detail.result));
  var row = el("tr"); row.appendChild(cell);
  return row;
}

function openStep(task, step) {
  if (diag.open === step.id) { diag.open = ""; diag.detail = null; renderPanel(); return; }
  diag.open = step.id; diag.detail = null; renderPanel();
  getJson("/api/tasks/execution/step?task=" + encodeURIComponent(task.id) + "&snapshot=" + encodeURIComponent(panel.snapshot) + "&step=" + encodeURIComponent(step.id)).then(function (detail) {
    if (diag.open === step.id) { diag.detail = detail; renderPanel(); }
  }, failed);
}

function usageBlock(task) {
  var box = section(t("ui.next.diag.usage"));
  if (diag.usageFor !== task.id) {
    diag.usageFor = task.id; diag.usage = null;
    // Admins only; for anybody else the section simply has nothing to add.
    getJson("/api/tasks/execution/costs?task=" + encodeURIComponent(task.id)).then(function (got) { if (diag.usageFor === task.id) { diag.usage = got.report; renderPanel(); } }, function () {});
  }
  var report = diag.usage;
  if (!report || !report.records) return null; // nothing metered is nothing to show
  var totals = report.totals || {};
  box.appendChild(el("div", "ids", t("ui.next.diag.turns", { n: report.turns }) + " · " + t("ui.next.diag.tokens", { input: totals.inputTokens || 0, output: totals.outputTokens || 0, cache: totals.cacheReadTokens || 0 })));
  if (typeof report.money === "number") box.appendChild(el("div", "ids", "$" + report.money.toFixed(2)));
  else if ((report.unpriced || []).length) box.appendChild(el("div", "why", t("ui.next.diag.unpriced")));
  return box;
}

function exportBlock(task) {
  var box = el("div", "foot-links"), button = el("button", "act", t("ui.next.diag.export"));
  button.addEventListener("click", function () {
    postJson("/api/tasks/export?task=" + encodeURIComponent(task.id), {}).then(function (bundle) {
      toast(t("ui.next.diag.exported", { n: (bundle.files || []).length }));
      (bundle.files || []).forEach(function (file) {
        var link = el("a", "", file.name);
        link.href = "/api/tasks/export/file?task=" + encodeURIComponent(task.id) + "&id=" + encodeURIComponent(bundle.id) + "&file=" + encodeURIComponent(file.name);
        box.appendChild(link);
      });
    }, failed);
  });
  box.appendChild(button);
  return box;
}

function renderDiagnostics(inner, task) {
  inner.appendChild(el("div", "diag-note", t("ui.next.diag.note")));
  var steps = section(t("ui.next.diag.steps", { shown: panel.steps.length, total: panel.total }));
  if (panel.coverage === "partial") steps.appendChild(el("div", "why", t("ui.next.diag.partial")));
  var table = el("table", "diag");
  panel.steps.forEach(function (step) {
    var row = el("tr", "step");
    row.appendChild(el("td", "", clock(step.startedAt || step.endedAt)));
    row.appendChild(el("td", "", step.name));
    row.appendChild(el("td", "", step.detail));
    row.appendChild(el("td", step.outcome === "failed" || step.outcome === "refused" ? "bad" : "", step.outcome));
    row.addEventListener("click", function () { openStep(task, step); });
    table.appendChild(row);
    if (diag.open === step.id && diag.detail) table.appendChild(stepDetail(diag.detail));
  });
  steps.appendChild(table);
  inner.appendChild(steps);
  var usage = usageBlock(task);
  if (usage) inner.appendChild(usage);
  var ids = section(t("ui.next.diag.ids")), work = task.work || {};
  ids.appendChild(el("div", "ids", [task.id, work.id, work.phase, task.conversation, task.assigneeId].filter(Boolean).join(" · ")));
  inner.appendChild(ids);
  inner.appendChild(exportBlock(task));
}
`;
