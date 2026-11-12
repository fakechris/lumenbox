/**
 * What the agents remember, on the rebuilt page (INV-1825): each agent's own memory and what it
 * shares with its team, line by line, with a way to correct or withdraw a line; what waits to become
 * the organisation's knowledge; and what the organisation already holds, which can be marked
 * unverified, withdrawn or replaced. Nothing here is deleted without a second press.
 */
export const NEXT_SET_MEMORY_JS = `
var memory = { agents: null, error: "", open: "", lines: null, review: null, items: null, editing: "" };

function loadMemory() {
  getJson("/api/memory").then(function (got) { memory.agents = got.agents || []; memory.error = ""; }, function (error) { memory.agents = []; memory.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  getJson("/api/org-knowledge/review").then(function (got) { memory.review = got.pending || []; if (next.view === "settings") render(); }, function () { memory.review = null; });
  getJson("/api/memory/org/items").then(function (got) { memory.items = got.items || []; if (next.view === "settings") render(); }, function () { memory.items = null; });
}
function loadMemoryOf(agentId) {
  getJson("/api/memory/agent?agent=" + encodeURIComponent(agentId)).then(function (got) { if (memory.open === agentId) { memory.lines = got; render(); } }, function (error) {
    if (memory.open === agentId) { memory.lines = { error: error.message }; render(); }
  });
}

/** One remembered line with what can be done to it. A line that was withdrawn or is held is shown as that, and left alone. */
function memoryLine(agentId, scope, line) {
  var item = el("div", "fact"), text = el("span", ""), acts = el("span", "acts"), id = scope + ":" + line.key + ":" + line.version;
  var note = [line.kind, new Date(line.at).toLocaleDateString(), line.source || "", line.status !== "live" ? t("ui.next.memory.status." + line.status) : ""].filter(Boolean).join(" · ");
  var change = function (body, done) {
    postJson("/api/memory/change", Object.assign({ agent: agentId, scope: scope, key: line.key, version: line.version }, body)).then(function (got) {
      memory.lines = { own: got.own || [], shared: got.shared || [] }; memory.editing = ""; toast(done); render();
    }, function (error) { failed(error); loadMemoryOf(agentId); });
  };
  if (memory.editing === id) {
    var area = el("textarea"), save = el("button", "act-primary", t("ui.next.settings.save")), no = el("button", "act", t("ui.next.auto.cancel"));
    area.value = line.text; area.rows = 3;
    save.addEventListener("click", function () { if (area.value.trim()) change({ text: area.value.trim() }, t("ui.next.settings.saved2")); });
    no.addEventListener("click", function () { memory.editing = ""; render(); });
    text.appendChild(area); acts.appendChild(save); acts.appendChild(no);
  } else {
    text.appendChild(el("div", "", line.text)); text.appendChild(el("div", "why", note));
    if (line.status === "live") {
      var edit = el("button", "act", t("ui.next.memory.correct")), gone = el("button", "act", t("ui.next.mine.retract")), up = el("button", "act", t("ui.next.memory.promote"));
      edit.addEventListener("click", function () { memory.editing = id; render(); });
      gone.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.memory.withdrawSure"));
        sure.addEventListener("click", function () { change({}, t("ui.next.memory.withdrawn")); });
        gone.replaceWith(sure);
      });
      up.addEventListener("click", function () {
        up.disabled = true;
        postJson("/api/org-knowledge/promote", { agent: agentId, tier: scope, version: line.version, scope: "org" }).then(function () { toast(t("ui.next.manage.promoted")); loadMemory(); }, function (error) {
          up.disabled = false; failed(error);
        });
      });
      acts.appendChild(edit); acts.appendChild(gone); acts.appendChild(up);
    }
  }
  item.appendChild(text); item.appendChild(acts);
  return item;
}

function agentMemoryBlock() {
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.memory.agents")));
  if (memory.error) { box.appendChild(el("p", "why", memory.error)); return box; }
  if (!memory.agents.length) box.appendChild(el("p", "why", t("ui.next.memory.none")));
  memory.agents.forEach(function (row) {
    var head = el("button", "fact");
    head.appendChild(el("span", "", row.agentName));
    head.appendChild(el("span", "why", t("ui.next.memory.counts", { live: row.live || 0, withdrawn: row.retracted || 0, held: row.held || 0 })));
    head.addEventListener("click", function () {
      memory.open = memory.open === row.agentId ? "" : row.agentId; memory.lines = null; memory.editing = "";
      if (memory.open) loadMemoryOf(row.agentId);
      render();
    });
    box.appendChild(head);
    if (memory.open !== row.agentId) return;
    var body = el("div", "fold-body");
    if (!memory.lines) body.appendChild(el("p", "why", t("ui.next.auto.reading")));
    else if (memory.lines.error) body.appendChild(el("p", "why", memory.lines.error));
    else [["own", t("ui.next.memory.own")], ["shared", t("ui.next.memory.shared")]].forEach(function (pair) {
      var lines = memory.lines[pair[0]] || [];
      if (!lines.length) return;
      body.appendChild(el("h2", "group", pair[1] + " · " + lines.length));
      lines.forEach(function (line) { body.appendChild(memoryLine(row.agentId, pair[0], line)); });
    });
    box.appendChild(body);
  });
  return box;
}

/** What somebody proposed the whole organisation should know: read, then let in or refused. */
function orgReviewBlock() {
  if (!memory.review || !memory.review.length) return null;
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.memory.review", { n: memory.review.length })));
  memory.review.forEach(function (item) {
    var line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts");
    text.appendChild(el("div", "", item.text));
    text.appendChild(el("div", "why", [item.ownerName, item.source, (item.evidence || []).join("; "), item.replaces ? t("ui.next.memory.replaces", { text: clip(item.replaces.text, 60) }) : ""].filter(Boolean).join(" · ")));
    [["approved", t("ui.next.act.approve")], ["rejected", t("ui.next.act.deny")]].forEach(function (pair) {
      var go = el("button", "act", pair[1]);
      go.addEventListener("click", function () {
        postJson("/api/org-knowledge/review/decide", { version: item.version, decision: pair[0], pinned: false }).then(loadMemory, function (error) { failed(error); loadMemory(); });
      });
      acts.appendChild(go);
    });
    line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  return box;
}

/** What the organisation holds. A correction needs its reason; replacing a line needs the new words. */
function orgItemsBlock() {
  if (!memory.items || !memory.items.length) return null;
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.memory.org", { n: memory.items.length })));
  memory.items.forEach(function (item) {
    var line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts"), under = el("div", "under"), may = item.may || {};
    var state = MSG["ui.next.memory.state." + item.state] ? t("ui.next.memory.state." + item.state) : item.state;
    text.appendChild(el("div", "", item.text));
    text.appendChild(el("div", "why", [state, item.ownerName, item.scopeName, item.correction ? item.correction.byName + ": " + item.correction.reason : ""].filter(Boolean).join(" · ")));
    var correct = function (verb, label, withText) {
      var open = el("button", "act", label);
      open.addEventListener("click", function () {
        var reason = el("input"), words = el("textarea"), go = el("button", "act-danger", label);
        reason.placeholder = t("ui.next.memory.reason"); words.value = item.text;
        go.addEventListener("click", function () {
          var body = withText ? { verb: verb, id: item.id, reason: "", text: words.value.trim(), evidence: [] } : { verb: verb, id: item.id, reason: reason.value.trim() };
          if (withText ? !body.text : !body.reason) { (withText ? words : reason).focus(); return; }
          postJson("/api/memory/org/correct", body).then(function (got) { memory.items = got.items || memory.items; toast(t("ui.next.settings.saved2")); render(); }, function (error) { failed(error); loadMemory(); });
        });
        under.replaceChildren(withText ? words : reason, go);
      });
      acts.appendChild(open);
    };
    if (may.unverify) correct("unverify", t("ui.next.memory.unverify"), false);
    if (may.supersede) correct("supersede", t("ui.next.memory.supersede"), true);
    if (may.retract) correct("retract", t("ui.next.mine.retract"), false);
    line.className = "row"; line.appendChild(text); line.appendChild(acts); line.appendChild(under); box.appendChild(line);
  });
  return box;
}

function renderMemoryPane(view) {
  if (memory.agents === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadMemory(); return; }
  [orgReviewBlock(), agentMemoryBlock(), orgItemsBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
