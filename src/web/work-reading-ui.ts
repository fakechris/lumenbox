/** Shared language and navigation for list, detail, attention, search and conversation work. */
export const WORK_READING_STYLE = String.raw`
.wr-summary{min-width:0;overflow-wrap:anywhere}.wr-summary p{margin:var(--sp-2) 0;line-height:1.65}.wr-meta{font-size:var(--fs-sm);color:var(--muted)}.wr-references{list-style:none;padding:0;margin:var(--sp-3) 0}.wr-references li{margin:var(--sp-2) 0}.wr-references a,.wr-open{color:var(--accent-2);overflow-wrap:anywhere}.wr-check{border-top:1px solid var(--border);padding-top:var(--sp-3);margin-top:var(--sp-4)}.wr-check>summary{cursor:pointer;font-size:var(--fs-md)}.wr-search{margin-top:var(--sp-3)}.wr-search input{width:100%;min-width:0;box-sizing:border-box}.wr-check pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:var(--fs-sm)}.wr-evidence{padding-left:var(--sp-4);font-size:var(--fs-sm);overflow-wrap:anywhere}
`;
export const WORK_READING_JS = String.raw`
function workReadingPhase(reading) { return t("ui.wr.phase." + reading.phase); }
function workReadingReason(reading) { return reading.blocker ? t("ui.wr.blocker." + reading.blocker.kind) + (reading.blocker.tools.length ? " · " + reading.blocker.tools.join(", ") : "") : t("ui.wr.reason." + reading.reason); }
function workReadingLink(reading) { return '<a class="wr-open" href="?task=' + encodeURIComponent(reading.id) + '" data-wr-work="' + esc(reading.id) + '">' + esc(reading.title) + '</a>'; }
function workReadingHtml(reading, detail) {
  if (!reading) return "";
  var html = '<div class="wr-summary"><p>' + esc(workReadingReason(reading)) + '</p><p class="wr-meta">' + esc(t("ui.wr.source." + reading.source)) + ' · ' + esc(t("ui.wr.boundary." + reading.boundary)) + '</p>';
  if (!detail) return html + '</div>';
  if (reading.references.length) html += '<ul class="wr-references">' + reading.references.map(function (ref) {
    return '<li><span class="wr-meta">' + esc(t("ui.wr.relation." + ref.relation)) + ' · </span>' + (ref.availability === "available" ? workReadingLink(ref) : '<span class="wr-meta">' + esc(t("ui.wr.unavailable")) + '</span>') + '</li>';
  }).join('') + '</ul>';
  if (reading.moreReferences) html += '<p class="wr-meta">' + esc(t("ui.wr.moreRelations",{count:reading.moreReferences})) + '</p>';
  var checks = reading.checks;
  html += '<details class="wr-check"><summary>' + esc(t("ui.wr.checks")) + ' · ' + esc(t("ui.wr.check." + checks.state)) + '</summary><p>' + esc(t("ui.wr.result." + checks.result)) + '</p>' + (checks.purpose ? '<p>' + esc(checks.purpose) + '</p>' : '') + (checks.reason ? '<pre>' + esc(checks.reason) + '</pre>' : '') + '<p class="wr-meta">' + esc(t("ui.wr.checkUse",{rounds:checks.rounds,calls:checks.calls,cost:Number(checks.reservedCost).toFixed(4)})) + '</p><p class="wr-meta">' + esc(t("ui.wr.acceptanceSeparate")) + '</p></details>';
  if (reading.evidence.length) html += '<h2>' + esc(t("ui.wr.evidence")) + '</h2><ul class="wr-evidence">' + reading.evidence.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>';
  return html + '</div>';
}
document.addEventListener("click",function (event) {
  var link = event.target.closest("[data-wr-work]"); if (!link) return;
  event.preventDefault(); window.openTaskFocus(link.getAttribute("data-wr-work"));
});
`;
