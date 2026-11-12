/**
 * The team's settings on the rebuilt page (INV-1825), second half: the ceilings an admin puts on each
 * agent — how many unprompted messages it may send in a day, how much it may spend in a day and in
 * one waking — how many failures in a row pause an automation, and whether what agents want to share
 * as team memory waits for a person first.
 */
export const NEXT_SET_LIMITS_JS = `
var limits = { push: null, spend: null, pauseAfter: null, review: null };

function loadLimits() {
  var also = function (path, keep) { getJson(path).then(function (got) { keep(got); if (next.view === "settings") render(); }, function () {}); };
  also("/api/agents/push-budget", function (got) { limits.push = got.agents || {}; });
  also("/api/agents/spend-limits", function (got) { limits.spend = got; });
  also("/api/schedules/pause-after", function (got) { limits.pauseAfter = got.pauseAfter; });
  also("/api/memory/team-review", function (got) { limits.review = got; });
}

/** A number typed into a limit: empty means "no limit of its own" (null), anything else a number, and nonsense is refused before it is sent. */
function limitValue(text) {
  var trimmed = String(text || "").trim();
  if (trimmed === "") return { ok: true, value: null };
  var number = Number(trimmed);
  return isFinite(number) && number >= 0 ? { ok: true, value: number } : { ok: false };
}

function limitsBlock() {
  if (limits.push === null && limits.spend === null) return null;
  var box = el("section", "setting"), spend = (limits.spend && limits.spend.agents) || {}, push = limits.push || {};
  box.appendChild(el("h2", "group", t("ui.next.limits.title")));
  box.appendChild(el("p", "why", t("ui.next.limits.note")));
  Object.keys(next.agents).map(function (id) { return next.agents[id]; }).forEach(function (agent) {
    var fold = el("details", "fold"), body = el("div", "fold-body"), mine = spend[agent.id] || {}, sent = push[agent.id] || {}, caps = mine.limits || {};
    var said = t("ui.next.limits.today", { spent: (mine.spent || 0).toFixed(2), sent: sent.sent || 0 }) + (mine.pausedAt ? " · " + t("ui.next.limits.paused") : "");
    fold.appendChild(el("summary", "", agent.name + " · " + said));
    var field2 = function (said, value, send) {
      var input = el("input");
      input.value = value === null || value === undefined ? "" : String(value); input.inputMode = "decimal";
      input.addEventListener("change", function () {
        var read = limitValue(input.value);
        if (!read.ok) { input.focus(); toast(t("ui.next.limits.number")); return; }
        send(read.value).then(function () { toast(t("ui.next.settings.saved2")); loadLimits(); }, function (error) { failed(error); loadLimits(); });
      });
      body.appendChild(labelled(said, input));
    };
    field2(t("ui.next.limits.perDay"), caps.perDay, function (value) { return postJson("/api/agents/spend-limits", { id: agent.id, perDay: value }); });
    field2(t("ui.next.limits.perWake"), caps.perWake, function (value) { return postJson("/api/agents/spend-limits", { id: agent.id, perWake: value }); });
    field2(t("ui.next.limits.pushes"), sent.perDay, function (value) { return postJson("/api/agents/push-budget", { id: agent.id, perDay: value }); });
    if ((mine.unpricedModels || []).length) body.appendChild(el("p", "why", t("ui.next.spend.unpriced", { models: mine.unpricedModels.join(", ") })));
    fold.appendChild(body); box.appendChild(fold);
  });
  if (limits.pauseAfter !== null) {
    var after = el("input");
    after.value = String(limits.pauseAfter); after.inputMode = "numeric";
    after.addEventListener("change", function () {
      var read = limitValue(after.value);
      if (!read.ok || read.value === null) { after.focus(); toast(t("ui.next.limits.number")); return; }
      postJson("/api/schedules/pause-after", { pauseAfter: read.value }).then(function (got) { limits.pauseAfter = got.pauseAfter; toast(t("ui.next.settings.saved2")); }, failed);
    });
    box.appendChild(labelled(t("ui.next.limits.pauseAfter"), after));
  }
  return box;
}

/** What agents want every agent to remember: with the switch on, each line waits here for a person. */
function memoryReviewBlock() {
  if (!limits.review) return null;
  var box = el("section", "setting"), on = el("input"), label = el("label", "tool"), pending = limits.review.pending || [];
  box.appendChild(el("h2", "group", t("ui.next.limits.review")));
  on.type = "checkbox"; on.checked = !!limits.review.on;
  on.addEventListener("change", function () { postJson("/api/memory/team-review/setting", { on: on.checked }).then(loadLimits, function (error) { failed(error); loadLimits(); }); });
  label.appendChild(on); label.appendChild(document.createTextNode(" " + t("ui.next.limits.reviewOn"))); box.appendChild(label);
  pending.forEach(function (line) {
    var item = el("div", "fact"), text = el("span", ""), acts = el("span", "acts");
    text.appendChild(el("div", "", line.text)); text.appendChild(el("div", "why", (line.writerName || "") + " · " + new Date(line.at).toLocaleString()));
    [["approved", t("ui.next.act.approve")], ["rejected", t("ui.next.act.deny")]].forEach(function (pair) {
      var go = el("button", "act", pair[1]);
      go.addEventListener("click", function () {
        postJson("/api/memory/team-review/decide", { writer: line.writer, version: line.version, decision: pair[0] }).then(loadLimits, function (error) { failed(error); loadLimits(); });
      });
      acts.appendChild(go);
    });
    item.appendChild(text); item.appendChild(acts); box.appendChild(item);
  });
  return box;
}
`;
