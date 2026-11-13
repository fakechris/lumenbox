/**
 * Where the tokens went, on the rebuilt page (INV-1825): by day, by agent, by model, by piece of work.
 *
 * Detail, not default: the system view says what was used today, and this opens from there. Tokens
 * are printed whole, because a report a person may re-derive by hand should show the number it
 * counted; money is shown only when every model in the window has a rate, and a total that is only
 * a floor says so.
 */
export const NEXT_SPEND_JS = `
var spend = { open: false, day: "", data: null, error: "", loading: false };

function loadSpend(day) {
  spend.day = day; spend.loading = true; spend.error = "";
  getJson("/api/spend" + (day ? "?day=" + encodeURIComponent(day) : "")).then(function (got) { spend.data = got; }, function (error) { spend.data = null; spend.error = error.message; })
    .then(function () { spend.loading = false; if (next.view === "system") render(); });
}

function tokensOf(totals) {
  totals = totals || {};
  return t("ui.next.diag.tokens", { input: (totals.inputTokens || 0).toLocaleString(), output: (totals.outputTokens || 0).toLocaleString(), cache: (totals.cacheReadTokens || 0).toLocaleString() });
}

/** The share of input that came from cache rather than being paid for fresh; undefined when nothing was read. */
function cacheHit(totals) {
  var fresh = (totals && totals.inputTokens) || 0, cached = (totals && totals.cacheReadTokens) || 0;
  return fresh + cached > 0 ? Math.round(cached / (fresh + cached) * 100) : undefined;
}

function spendBlock() {
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.spend.title")));
  if (!spend.open) {
    var open = el("button", "act", t("ui.next.spend.open"));
    open.addEventListener("click", function () { spend.open = true; loadSpend(""); });
    box.appendChild(open);
    return box;
  }
  if (spend.error) { box.appendChild(el("p", "why", spend.error)); return box; }
  if (!spend.data) { box.appendChild(el("p", "why", t("ui.next.auto.reading"))); return box; }
  var data = spend.data, report = data.report || {}, days = el("div", "acts"), hit = cacheHit(report.totals);
  [{ day: "", label: t("ui.next.spend.all") }].concat((data.days || []).slice(-14).reverse().map(function (row) { return { day: row.day, label: row.day.slice(5) }; })).forEach(function (row) {
    var pick = el("button", "seg", row.label);
    pick.setAttribute("aria-pressed", String(row.day === spend.day));
    pick.addEventListener("click", function () { loadSpend(row.day); });
    days.appendChild(pick);
  });
  box.appendChild(days);
  box.appendChild(fact(report.scope || t("ui.next.spend.all"), tokensOf(report.totals)));
  // What went in with no request behind it, said next to the total: the figure to weigh against what anybody got for it.
  var loose = report.unrequested || {};
  if (loose.inputTokens || loose.outputTokens) { box.appendChild(fact(t("ui.next.spend.unrequested"), tokensOf(loose))); box.appendChild(el("p", "why", t("ui.next.spend.unrequestedWhy"))); }
  if (hit !== undefined && !(report.unmeasured || []).length) box.appendChild(fact(t("ui.next.spend.cache"), hit + "%"));
  if (typeof report.money === "number") box.appendChild(fact(t("ui.next.spend.money"), report.money.toFixed(2)));
  else if ((report.unpriced || []).length) box.appendChild(el("p", "why", t("ui.next.spend.unpriced", { models: report.unpriced.join(", ") })));
  if (report.compacted) box.appendChild(el("p", "why", t("ui.next.spend.floor")));
  [["agent", report.byAgent], ["model", report.byModel]].forEach(function (pair) {
    if (!(pair[1] || []).length) return;
    box.appendChild(el("h2", "group", t("ui.next.spend.by." + pair[0])));
    pair[1].slice(0, 12).forEach(function (row) { box.appendChild(fact(agentName(row[pair[0]]) || row[pair[0]], tokensOf(row.totals))); });
  });
  var costed = (data.tasks || []).filter(function (row) { return !row.unknown && (row.totals.inputTokens || row.totals.outputTokens); });
  if (costed.length) {
    box.appendChild(el("h2", "group", t("ui.next.spend.by.work")));
    costed.sort(function (a, b) { return (b.totals.outputTokens || 0) - (a.totals.outputTokens || 0); }).slice(0, 15).forEach(function (row) {
      var line = el("button", "fact"), cost = tokensOf(row.totals) + (typeof row.money === "number" ? " · " + row.money.toFixed(2) : "");
      line.appendChild(el("span", "why", clip(row.title, 60))); line.appendChild(el("span", "", cost));
      line.addEventListener("click", function () { openPanel(row.id); });
      box.appendChild(line);
    });
  }
  if (data.tasksHidden) box.appendChild(el("p", "why", t("ui.next.spend.hidden", { n: data.tasksHidden })));
  return box;
}
`;
