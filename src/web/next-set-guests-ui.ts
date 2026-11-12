/**
 * Guests on the rebuilt page (INV-1825): people in a group chat who are not members of the
 * organisation. An organisation's admin decides which agents answer them, from which collections of
 * knowledge, how often, and whether an answer waits for a person before it is sent; and reads what
 * was asked and answered. A personal installation has no guests, and the pane says so.
 */
export const NEXT_SET_GUESTS_JS = `
var guests = { data: null, error: "", audit: null, days: "7", held: false };

function loadGuests() {
  getJson("/api/guests").then(function (got) { guests.data = got; guests.error = ""; }, function (error) { guests.data = {}; guests.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  loadGuestAudit();
}
function loadGuestAudit() {
  getJson("/api/guests/audit?days=" + encodeURIComponent(guests.days) + (guests.held ? "&held=1" : "")).then(function (got) { guests.audit = got; if (next.view === "settings") render(); }, function () {
    guests.audit = null;
  });
}
/** Every write answers with the whole state, which replaces what is shown. */
function guestWrite(path, body) { return postJson(path, body).then(function (got) { guests.data = got; render(); }, function (error) { failed(error); loadGuests(); }); }

function guestAnswersBlock() {
  var data = guests.data, box = el("section", "setting"), cap = el("input"), exchanges = el("input"), minutes = el("input");
  box.appendChild(el("h2", "group", t("ui.next.guests.answers")));
  box.appendChild(el("p", "why", t("ui.next.guests.answersNote")));
  Object.keys(next.agents).map(function (id) { return next.agents[id]; }).forEach(function (agent) {
    var line = el("div", "fact"), mode = selectOf([["members", t("ui.next.guests.members")], ["guests", t("ui.next.guests.guests")]], (data.agents || {})[agent.id] || "members");
    mode.addEventListener("change", function () { guestWrite("/api/guests/answers", { id: agent.id, mode: mode.value }); });
    line.appendChild(el("span", "", agent.name)); line.appendChild(mode); box.appendChild(line);
    if (mode.value !== "guests" || !(data.collections || []).length) return;
    // Which collections this agent may answer guests from.
    var ticks = el("div", "toolgrid"), mine = (data.ticks || {})[agent.id] || [];
    (data.collections || []).forEach(function (collection) {
      var label = el("label", "tool"), tick = el("input");
      tick.type = "checkbox"; tick.checked = mine.indexOf(collection.id) >= 0;
      tick.addEventListener("change", function () {
        var chosen = (data.collections || []).filter(function (row) { return row.id === collection.id ? tick.checked : mine.indexOf(row.id) >= 0; }).map(function (row) { return row.id; });
        guestWrite("/api/guests/ticks", { id: agent.id, collections: chosen });
      });
      label.appendChild(tick); label.appendChild(document.createTextNode(" " + collection.name)); ticks.appendChild(label);
    });
    box.appendChild(ticks);
  });
  cap.value = String(data.perGroupPerDay || ""); cap.inputMode = "numeric";
  cap.addEventListener("change", function () { var value = Number(cap.value); if (Number.isInteger(value) && value >= 1) guestWrite("/api/guests/cap", { perGroupPerDay: value }); else cap.focus(); });
  box.appendChild(labelled(t("ui.next.guests.cap"), cap));
  var window2 = data.window || {}, limit = data.windowLimit || { exchanges: 20, minutes: 1440 }, keep = el("button", "act", t("ui.next.settings.save")), row = el("div", "acts");
  exchanges.value = String(window2.exchanges === undefined ? "" : window2.exchanges); minutes.value = String(window2.minutes === undefined ? "" : window2.minutes);
  keep.addEventListener("click", function () {
    var said = Number(exchanges.value), within = Number(minutes.value);
    if (!(Number.isInteger(said) && said >= 0 && said <= limit.exchanges)) { exchanges.focus(); return; }
    if (!(Number.isInteger(within) && within >= 1 && within <= limit.minutes)) { minutes.focus(); return; }
    guestWrite("/api/guests/window", { exchanges: said, minutes: within });
  });
  row.appendChild(exchanges); row.appendChild(minutes); row.appendChild(keep);
  box.appendChild(labelled(t("ui.next.guests.window", { exchanges: limit.exchanges, minutes: limit.minutes }), row));
  return box;
}

function guestKnowledgeBlock() {
  var data = guests.data, box = el("section", "setting"), collections = data.collections || [];
  box.appendChild(el("h2", "group", t("ui.next.guests.knowledge")));
  collections.forEach(function (collection) {
    var fold = el("details", "fold"), body = el("div", "fold-body"), entries = (data.knowledge || []).filter(function (entry) { return (entry.collection || "general") === collection.id; });
    fold.appendChild(el("summary", "", collection.name + " · " + entries.length));
    entries.forEach(function (entry) {
      var line = el("div", "fact"), text = el("span", ""), gone = el("button", "act", t("ui.next.doors.remove"));
      text.appendChild(el("b", "", entry.title)); text.appendChild(el("div", "why", clip(entry.text, 160)));
      gone.addEventListener("click", function () { guestWrite("/api/guests/knowledge/remove", { id: entry.id }); });
      line.appendChild(text); line.appendChild(gone); body.appendChild(line);
    });
    var title = el("input"), words = el("textarea"), add = el("button", "act", t("ui.next.mine.add"));
    title.placeholder = t("ui.next.guests.entryTitle"); words.placeholder = t("ui.next.guests.entryText"); words.rows = 3;
    add.addEventListener("click", function () {
      if (!title.value.trim() || !words.value.trim()) { (title.value.trim() ? words : title).focus(); return; }
      guestWrite("/api/guests/knowledge", { title: title.value.trim(), text: words.value.trim(), collection: collection.id });
    });
    body.appendChild(title); body.appendChild(words); body.appendChild(add);
    if (collection.id !== "general") {
      var away = el("button", "act", t("ui.next.guests.removeCollection"));
      away.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.doors.removeSure"));
        sure.addEventListener("click", function () { guestWrite("/api/guests/collections/remove", { id: collection.id }); });
        away.replaceWith(sure);
      });
      body.appendChild(away);
    }
    fold.appendChild(body); box.appendChild(fold);
  });
  var name = el("input"), make = el("button", "act", t("ui.next.guests.addCollection")), row = el("div", "acts");
  name.placeholder = t("ui.next.guests.collectionName");
  make.addEventListener("click", function () { if (name.value.trim()) guestWrite("/api/guests/collections", { name: name.value.trim() }); else name.focus(); });
  row.appendChild(name); row.appendChild(make); box.appendChild(row);
  return box;
}

/** What guests asked and were told. An answer that was held is sent or thrown away here; a group can be set to hold every answer. */
function guestAuditBlock() {
  var audit = guests.audit;
  if (!audit) return null;
  var box = el("section", "setting"), days = selectOf([["", t("ui.next.spend.all")], ["1", "1"], ["7", "7"], ["30", "30"]], guests.days), held = el("input"), heldLabel = el("label", "tool"), top = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.guests.audit")));
  days.setAttribute("aria-label", t("ui.next.guests.days"));
  days.addEventListener("change", function () { guests.days = days.value; loadGuestAudit(); });
  held.type = "checkbox"; held.checked = guests.held; held.addEventListener("change", function () { guests.held = held.checked; loadGuestAudit(); });
  heldLabel.appendChild(held); heldLabel.appendChild(document.createTextNode(" " + t("ui.next.guests.onlyHeld")));
  top.appendChild(labelled(t("ui.next.guests.days"), days)); top.appendChild(heldLabel); box.appendChild(top);
  (audit.groups || []).forEach(function (group) {
    var label = el("label", "tool"), hold = el("input");
    hold.type = "checkbox"; hold.checked = !!group.hold;
    hold.addEventListener("change", function () {
      postJson("/api/guests/hold", { door: group.door, chatKey: group.chatKey, hold: hold.checked }).then(loadGuestAudit, function (error) { failed(error); loadGuestAudit(); });
    });
    label.appendChild(hold); label.appendChild(document.createTextNode(" " + t("ui.next.guests.hold", { group: group.door + " · " + group.chatKey })));
    box.appendChild(label);
  });
  if (!(audit.rows || []).length) box.appendChild(el("p", "why", t("ui.next.guests.noRows")));
  (audit.rows || []).slice(0, 60).forEach(function (row) {
    var line = el("div", "row"), text = el("span", "body"), acts = el("span", "acts"), review = row.review || {};
    text.appendChild(el("div", "title", (row.senderLabel || row.identity || "") + " → " + (row.agentName || "") + " · " + new Date(row.at).toLocaleString()));
    text.appendChild(el("div", "why", clip(row.question, 200)));
    text.appendChild(el("div", review.flagged ? "bad" : "", clip(review.answer || row.answer, 300)));
    if (review.reason && review.flagged) text.appendChild(el("div", "why", review.category + " · " + review.reason));
    if (review.status === "held") {
      [["approve", t("ui.next.guests.send")], ["discard", t("ui.next.guests.discard")]].forEach(function (pair) {
        var go = el("button", "act", pair[1]);
        go.addEventListener("click", function () {
          postJson("/api/guests/audit/" + pair[0], { turnId: row.turnId }).then(function (got) { guests.audit = got; render(); }, function (error) { failed(error); loadGuestAudit(); });
        });
        acts.appendChild(go);
      });
    }
    line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  return box;
}

function renderGuestsPane(view) {
  if (guests.data === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadGuests(); return; }
  if (guests.error) { view.appendChild(el("p", "why", guests.error)); return; }
  if (!guests.data.available) { view.appendChild(el("p", "empty", t("ui.next.guests.personal"))); return; }
  [guestAnswersBlock(), guestKnowledgeBlock(), guestAuditBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
