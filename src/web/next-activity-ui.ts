/**
 * What has been happening, on the rebuilt page (INV-1825): the recent activity of the agents, and —
 * for an admin — the audit record of commands and windows on a computer. Both are folds in the
 * system view, read when opened; the audit record keeps reading while it is open.
 */
export const NEXT_ACTIVITY_JS = `
var activity = { open: "", events: null, error: "", audit: [], auditError: "", next: 0, risk: false, box: "", timer: 0, probes: false };

/** One activity event as a line: who, what, and whether it went wrong. Null for what the feed does not show. */
function activityLine(event, locale, nameOf, words) {
  var who = event.agentName || nameOf(event.agentId) || "";
  if (event.type === "prompt") return { who: words.you, text: "→ " + nameOf(event.agentId), tone: "" };
  if (event.type === "turn_started") return { who: who, text: words.started, tone: "" };
  if (event.type === "tool_start") return { who: who, text: (event.phrase && (event.phrase[locale] || event.phrase.en)) || "→ " + event.tool, tone: "" };
  if (event.type === "turn_failed") return { who: who, text: words.failed + " " + (event.error || ""), tone: "bad" };
  if (event.type === "turn_interrupted") return { who: who, text: words.interrupted + (event.reason ? " (" + event.reason + ")" : ""), tone: "warn" };
  if (event.type === "error") return { who: "", text: String(event.message || ""), tone: "bad" };
  if (event.type === "question") return { who: who, text: words.asked + " " + String(event.question || "").slice(0, 90), tone: "warn" };
  if (event.type === "surface") return { who: who, text: words.card + " " + String(event.title || event.surfaceId || "").slice(0, 90), tone: "" };
  if (event.type === "template_import") return { who: who, text: "← " + String(event.summary || ""), tone: "" };
  return null;
}

/** One audit event as what ran or what was looked at. */
function auditLine(event) {
  var detail = event.detail || {};
  if (event.type === "exec") return (detail.user ? detail.user + " " : "") + (detail.pwd ? detail.pwd + " $ " : "$ ") + (detail.cmd || "");
  if (event.type === "window_focus") return String(event.window || detail.title || detail.window || "");
  return String(detail.action || detail.message || event.type);
}

function systemFold(title, key, draw) {
  var fold = el("details", "fold"), body = el("div", "fold-body");
  fold.appendChild(el("summary", "", title)); fold.appendChild(body);
  fold.open = activity.open === key;
  fold.addEventListener("toggle", function () {
    if (fold.open === (activity.open === key)) return;
    activity.open = fold.open ? key : ""; clearTimeout(activity.timer);
    render();
  });
  if (fold.open) draw(body);
  return fold;
}

function readAudit() {
  clearTimeout(activity.timer);
  if (activity.open !== "audit" || next.view !== "system" || !activity.box) return;
  var first = activity.next === 0, query = "boxId=" + encodeURIComponent(activity.box) + (first ? "&tail=1&limit=200" : "&since=" + activity.next + "&limit=200");
  getJson("/api/xwatchdog/events?" + query).then(function (got) {
    activity.audit = activity.audit.concat(got.events || []).slice(-400); activity.next = got.next_seq || activity.next;
    activity.risk = !!got.at_risk; activity.auditError = "";
    if ((got.events || []).length || first) render();
    activity.timer = setTimeout(readAudit, 4000);
  }, function (error) { activity.auditError = error.message; render(); });
}

function activityBlock() {
  var box = el("section", "setting");
  box.appendChild(systemFold(t("ui.next.activity.title"), "activity", function (body) {
    if (activity.events === null && !activity.error) {
      body.appendChild(el("p", "why", t("ui.next.auto.reading")));
      getJson("/api/activity").then(function (got) { activity.events = got || []; }, function (error) { activity.error = error.message; })
        .then(function () { if (next.view === "system") render(); });
      return;
    }
    if (activity.error) { body.appendChild(el("p", "why", activity.error)); return; }
    var words = { you: t("ui.next.thread.you"), started: t("ui.next.activity.started"), failed: t("ui.next.activity.failed") };
    words.interrupted = t("ui.next.activity.interrupted"); words.asked = t("ui.next.activity.asked"); words.card = t("ui.next.activity.card");
    var lines = activity.events.slice(-80).reverse().map(function (event) {
      return { at: event.at, line: activityLine(event, "{{@locale}}", agentName, words) };
    }).filter(function (row) { return row.line; });
    if (!lines.length) body.appendChild(el("p", "why", t("ui.next.activity.none")));
    lines.forEach(function (row) {
      var item = el("div", "fact");
      item.appendChild(el("span", "why", clock(row.at) + (row.line.who ? " · " + row.line.who : "")));
      item.appendChild(el("span", row.line.tone, row.line.text));
      body.appendChild(item);
    });
  }));
  box.appendChild(systemFold(t("ui.next.audit.title"), "audit", function (body) {
    var places = boxes.list || [];
    if (!activity.box && places[0]) activity.box = chat.box || places[0].id;
    if (places.length > 1) {
      var pick = el("select");
      places.forEach(function (place) { var node = el("option", "", place.name); node.value = place.id; node.selected = place.id === activity.box; pick.appendChild(node); });
      pick.addEventListener("change", function () { activity.box = pick.value; activity.audit = []; activity.next = 0; readAudit(); });
      body.appendChild(pick);
    }
    if (activity.next === 0 && !activity.auditError && !activity.timer) readAudit();
    if (activity.auditError) { body.appendChild(el("p", "why", activity.auditError)); return; }
    if (activity.risk) body.appendChild(el("div", "needbox", t("ui.next.audit.risk")));
    var probes = el("button", "act", t(activity.probes ? "ui.next.audit.hideProbes" : "ui.next.audit.showProbes"));
    probes.addEventListener("click", function () { activity.probes = !activity.probes; render(); });
    body.appendChild(probes);
    var shown = activity.audit.filter(function (event) { return activity.probes || !event.probe; }).slice(-120).reverse();
    if (!shown.length) body.appendChild(el("p", "why", t("ui.next.audit.none")));
    shown.forEach(function (event) {
      var item = el("div", "fact");
      item.appendChild(el("span", "why", clock(event.time) + " · " + (event.source || event.type)));
      item.appendChild(el("code", "", clip(auditLine(event), 200)));
      body.appendChild(item);
    });
  }));
  return box;
}
`;
