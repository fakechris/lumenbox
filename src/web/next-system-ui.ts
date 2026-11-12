/**
 * The system page of the rebuilt view (INV-1825, docs/99 §6): what is running this installation and
 * what went wrong in it. Nothing here asks for attention — what needs a person is in their inbox —
 * so it is one click into Settings and never on a default surface.
 */
export const NEXT_SYSTEM_JS = `
var system = { state: null, exceptions: null, history: null, archive: null, archived: null, failed: false, loading: false };

function loadSystem() {
  if (system.loading) return;
  system.loading = true;
  var none = function () { return null; };
  Promise.all([
    getJson("/api/state").catch(none),
    getJson("/api/exceptions").catch(none),
    getJson("/api/tasks/list?records=internal&limit=1").catch(none),
    getJson("/api/tasks/archive").catch(none),
  ]).then(function (got) {
    system.loading = false;
    // A read that failed is kept as "not known", never shown as an empty, healthy answer.
    system.failed = got[0] === null;
    if (got[0] !== null) system.state = got[0];
    system.exceptions = got[1]; system.history = got[2]; system.archive = got[3];
    if (next.view === "system") render();
  });
}

function fact(label, value) {
  var row = el("div", "fact");
  row.appendChild(el("span", "why", label)); row.appendChild(el("span", "", value));
  return row;
}

function exceptionRow(entry) {
  var row = el("div", "row"), body = el("span", "body"), acts = el("span", "acts");
  body.appendChild(el("div", "title", entry.subject));
  body.appendChild(el("div", "why", entry.reason + (entry.attempt > 1 ? " ×" + entry.attempt : "") + (entry.handedAt ? " · " + t("ui.next.system.handed", { name: entry.handedBy || "" }) : "")));
  row.appendChild(el("span", "who", initial(agentName(entry.agent))));
  row.appendChild(body);
  // Taking it on yourself is offered once: an entry somebody already took says who.
  [["retry", t("ui.next.system.retry")]].concat(entry.handedAt ? [] : [["hand", t("ui.next.system.hand")]]).concat([["dismiss", t("ui.next.card.dismiss")]]).forEach(function (pair) {
    var button = el("button", "act", pair[1]);
    button.addEventListener("click", function () {
      // One press, one request: the row's buttons stay off until this one has answered.
      acts.querySelectorAll("button").forEach(function (other) { other.disabled = true; });
      postJson("/api/exceptions/" + pair[0], { id: entry.id }).then(loadSystem, function (error) { failed(error); loadSystem(); });
    });
    acts.appendChild(button);
  });
  row.appendChild(acts);
  row.appendChild(el("span", "when", agoText(entry.at)));
  return row;
}

function renderSystem(view) {
  if (!system.state) {
    // Asked for once; a failure is said, with the way to ask again, rather than asked for on every redraw.
    if (!system.failed) { loadSystem(); return; }
    var again = el("button", "act", t("ui.next.system.retry"));
    again.addEventListener("click", function () { system.failed = false; loadSystem(); });
    view.appendChild(el("p", "empty", t("ui.next.system.unreadable"))); view.appendChild(again);
    return;
  }
  var state = system.state, health = el("section", "setting"), usage = state.usageToday || {};
  health.appendChild(el("h2", "group", t("ui.next.system.health")));
  health.appendChild(fact(t("ui.next.system.model"), String(state.provider || "")));
  boxes.list.forEach(function (box) { health.appendChild(fact(box.name, t(box.connected ? "ui.next.box.on" : "ui.next.box.off"))); });
  health.appendChild(fact(t("ui.next.system.today"), t("ui.next.diag.tokens", { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cache: usage.cacheReadTokens || 0 })));
  if (state.build) health.appendChild(fact(t("ui.next.system.version"), [state.build.version, state.build.commit].filter(Boolean).join(" · ")));
  view.appendChild(health);

  var open = [];
  ((system.exceptions && system.exceptions.groups) || []).forEach(function (group) {
    group.entries.forEach(function (entry) { if (!entry.resolvedAt) open.push(entry); });
  });
  var wrong = el("div", "list");
  wrong.appendChild(el("h2", "group", t("ui.next.system.wrong", { n: open.length })));
  if (system.exceptions === null) wrong.appendChild(el("p", "why", t("ui.next.system.unreadable")));
  else if (open.length === 0) wrong.appendChild(el("p", "why", t("ui.next.system.nothingWrong")));
  open.slice(0, 30).forEach(function (entry) { wrong.appendChild(exceptionRow(entry)); });
  view.appendChild(wrong);

  var kept = el("section", "setting"), total = (system.history && system.history.total) || 0;
  kept.appendChild(el("h2", "group", t("ui.next.system.history")));
  kept.appendChild(el("p", "", system.history === null ? t("ui.next.system.unreadable") : t("ui.next.system.historyNote", { n: total })));
  var ended = (system.archive && system.archive.ended) || 0;
  if (ended > 0 || system.archived) kept.appendChild(archiveActs(ended));
  view.appendChild(kept);
}

/** Ended internal records go to an archive file, not away: asked twice, and undone with one press. */
function archiveActs(ended) {
  var acts = el("div", "acts"), move = function (action, done) {
    acts.querySelectorAll("button").forEach(function (other) { other.disabled = true; });
    postJson("/api/tasks/archive", { action: action }).then(function (got) { system.archived = action === "archive" ? got : null; toast(done(got)); loadSystem(); }, function (error) { failed(error); loadSystem(); });
  };
  if (ended > 0) {
    var ask = el("button", "act", t("ui.next.system.archive", { n: ended }));
    ask.addEventListener("click", function () {
      var sure = el("button", "act-danger", t("ui.next.system.archiveSure", { n: ended }));
      sure.addEventListener("click", function () { move("archive", function (got) { return t("ui.next.system.archived", { n: got.archived, file: got.file || "" }); }); });
      acts.replaceChildren(sure);
    });
    acts.appendChild(ask);
  }
  if (system.archived) {
    var undo = el("button", "act", t("ui.next.system.restore", { n: system.archived.archived }));
    undo.addEventListener("click", function () { move("restore", function (got) { return t("ui.next.system.restored", { n: got.restored }); }); });
    acts.appendChild(undo);
  }
  return acts;
}
`;
