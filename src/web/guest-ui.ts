/**
 * Settings → Team → Guests and Settings → Guests (INV-1708, INV-1713, docs/97). In Team: who each
 * agent answers in group chats and which knowledge collections it may use, the daily guest turns
 * per group chat, the short window, and the collections with their entries. In its own pane: the
 * audit list of guest turns by group chat, agent and time, the red flag, the held answers an
 * Admin approves or discards, and which group chats hold answers until the review passes.
 * Drawn only on an organisation: a personal installation answers no guests, so it has nothing here.
 */

export const GUEST_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var CATEGORY = { PASS: "{{ui.guests.cat-pass}}", PROMISE: "{{ui.guests.cat-promise}}", NOT_IN_KNOWLEDGE: "{{ui.guests.cat-not-in-knowledge}}", NON_ANSWER: "{{ui.guests.cat-non-answer}}", PROCESS_OVER_RESULT: "{{ui.guests.cat-process}}", CONTEXT_BLEED: "{{ui.guests.cat-context-bleed}}", UNKNOWN: "{{ui.guests.cat-unknown}}" };
  var STATUS = { shadow: "{{ui.guests.status-shadow}}", sent: "{{ui.guests.status-sent}}", held: "{{ui.guests.status-held}}", approved: "{{ui.guests.status-approved}}", discarded: "{{ui.guests.status-discarded}}" };
  var field, list, cap, winTurns, winMinutes, sets, setPick, note, state = null;
  var pane, tab, filters = {}, rowsBox, groupsBox, auditNote, audit = null;
  function nameOf(c) { return c.name || "{{ui.guests.general-collection}}"; }
  function post(path, body) { return call("POST", path, body).then(function (d) { state = d; note.textContent = "{{ui.guests.saved}}"; render(); }).catch(function (e) { note.textContent = e.message; }); }
  function agentRow(a) {
    var row = el("div", { class: "ui-list-row", style: "flex-wrap:wrap" });
    row.appendChild(el("span", { class: "ui-w-md" }, a.name));
    var pick = el("select", { "aria-label": "{{ui.guests.answers-in-group-chats}} " + a.name });
    [["members", "{{ui.guests.members-only}}"], ["guests", "{{ui.guests.members-and-guests}}"]].forEach(function (o) {
      var opt = el("option", { value: o[0] }, o[1]); if ((state.agents[a.id] || "members") === o[0]) opt.selected = true; pick.appendChild(opt);
    });
    pick.onchange = function () { post("/api/guests/answers", { id: a.id, mode: pick.value }); };
    row.appendChild(pick);
    var ticks = el("span", { class: "dim", style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" });
    ticks.appendChild(el("span", {}, "{{ui.guests.may-use}}"));
    var ticked = (state.ticks && state.ticks[a.id]) || [];
    (state.collections || []).forEach(function (c) {
      var label = el("label", { style: "display:inline-flex;gap:4px;align-items:center" });
      var box = el("input", { type: "checkbox", "data-tick": a.id + ":" + c.id, "aria-label": nameOf(c) + " " + a.name });
      box.checked = ticked.indexOf(c.id) !== -1;
      box.onchange = function () {
        var now = Array.prototype.slice.call(ticks.querySelectorAll("input[data-tick]")).filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute("data-tick").split(":")[1]; });
        post("/api/guests/ticks", { id: a.id, collections: now });
      };
      label.appendChild(box); label.appendChild(document.createTextNode(nameOf(c)));
      ticks.appendChild(label);
    });
    row.appendChild(ticks);
    return row;
  }
  function render() {
    if (!field) return;
    var on = !!(state && state.available);
    field.style.display = on ? "" : "none";
    if (tab) tab.style.display = on ? "" : "none";
    if (!on) return;
    list.textContent = "";
    (window.agents || []).forEach(function (a) { list.appendChild(agentRow(a)); });
    cap.value = String(state.perGroupPerDay);
    winTurns.value = String(state.window.exchanges); winMinutes.value = String(state.window.minutes);
    sets.textContent = "";
    setPick.textContent = "";
    (state.collections || []).forEach(function (c) {
      setPick.appendChild(el("option", { value: c.id }, nameOf(c)));
      var head = el("div", { class: "ui-list-row", "data-collection": c.id });
      var name = el("input", { type: "text", value: nameOf(c), "aria-label": "{{ui.guests.collection-name}}", class: "ui-grow" });
      name.onchange = function () { post("/api/guests/collections/rename", { id: c.id, name: name.value }); };
      head.appendChild(name);
      if (c.id !== "general") {
        var drop = el("button", { class: "btn sm ghost", type: "button" }, "{{ui.guests.remove-collection}}");
        drop.onclick = function () { if (drop.getAttribute("data-sure") !== "1") { drop.setAttribute("data-sure", "1"); drop.textContent = "{{ui.guests.remove-collection-sure}}"; return; } post("/api/guests/collections/remove", { id: c.id }); };
        head.appendChild(drop);
      }
      sets.appendChild(head);
      var inside = (state.knowledge || []).filter(function (k) { return (k.collection || "general") === c.id; });
      inside.forEach(function (k) {
        var row = el("div", { class: "ui-list-row", style: "padding-left:16px" });
        row.appendChild(el("span", { class: "ui-grow", title: k.text }, k.title));
        var remove = el("button", { class: "btn sm ghost", type: "button" }, "{{ui.guests.remove}}");
        remove.onclick = function () { post("/api/guests/knowledge/remove", { id: k.id }); };
        row.appendChild(remove);
        sets.appendChild(row);
      });
      if (inside.length === 0) sets.appendChild(el("div", { class: "dim", style: "padding-left:16px" }, "{{ui.guests.no-public-knowledge}}"));
    });
  }
  function renderAudit() {
    if (!pane || !audit) return;
    var pickGroup = filters.group, pickAgent = filters.agent;
    var g = pane.querySelector("#guestauditgroup"), ag = pane.querySelector("#guestauditagent");
    g.textContent = ""; g.appendChild(el("option", { value: "" }, "{{ui.guests.every-group}}"));
    (audit.groups || []).forEach(function (x) { var o = el("option", { value: x.chatKey }, x.chatKey); if (x.chatKey === pickGroup) o.selected = true; g.appendChild(o); });
    ag.textContent = ""; ag.appendChild(el("option", { value: "" }, "{{ui.guests.every-agent}}"));
    (window.agents || []).forEach(function (a) { var o = el("option", { value: a.id }, a.name); if (a.id === pickAgent) o.selected = true; ag.appendChild(o); });
    groupsBox.textContent = "";
    groupsBox.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.hold-note}}"));
    (audit.groups || []).forEach(function (x) {
      var label = el("label", { class: "ui-list-row", style: "gap:6px" });
      var box = el("input", { type: "checkbox", "data-hold": x.chatKey, "aria-label": "{{ui.guests.hold}} " + x.chatKey }); box.checked = !!x.hold;
      box.onchange = function () { call("POST", "/api/guests/hold", { door: x.door, chatKey: x.chatKey, hold: box.checked }).then(loadAudit).catch(function (e) { auditNote.textContent = e.message; }); };
      label.appendChild(box); label.appendChild(el("span", {}, x.chatKey + " · {{ui.guests.hold}}"));
      groupsBox.appendChild(label);
    });
    if (!audit.groups || audit.groups.length === 0) groupsBox.appendChild(el("div", { class: "dim" }, "{{ui.guests.no-groups}}"));
    rowsBox.textContent = "";
    (audit.rows || []).forEach(function (r) {
      var flagged = r.review && r.review.flagged;
      var row = el("div", { class: "ui-stack", "data-turn": r.turnId, "data-flagged": flagged ? "1" : "0", style: "border-left:3px solid " + (flagged ? "var(--danger)" : "var(--border)") + ";padding:6px 10px;margin:6px 0" + (flagged ? ";background:var(--danger-soft)" : "") });
      row.appendChild(el("div", { class: "dim", style: "font-size:12px" }, new Date(r.at).toLocaleString() + " · " + r.chatKey + " · " + r.agentName + " · " + (r.senderLabel || r.identity)));
      row.appendChild(el("div", {}, "{{ui.guests.asked}} " + r.question));
      row.appendChild(el("div", {}, "{{ui.guests.answered}} " + (r.answer || "—")));
      if (r.review) {
        var verdict = el("div", { style: "font-size:12px" + (flagged ? ";color:var(--danger);font-weight:600" : "") }, (CATEGORY[r.review.category] || r.review.category) + " · " + (STATUS[r.review.status] || r.review.status) + (r.review.by ? " · " + r.review.by : ""));
        verdict.title = r.review.reason || "";
        row.appendChild(verdict);
        if (r.review.status === "held") {
          var acts = el("div", { class: "ui-row ui-gap" });
          var ok = el("button", { class: "btn sm", type: "button", "data-approve": r.turnId }, "{{ui.guests.approve-send}}");
          var no = el("button", { class: "btn sm ghost", type: "button", "data-discard": r.turnId }, "{{ui.guests.discard}}");
          ok.onclick = function () { call("POST", "/api/guests/audit/approve", { turnId: r.turnId }).then(loadAudit).catch(function (e) { auditNote.textContent = e.message; }); };
          no.onclick = function () { call("POST", "/api/guests/audit/discard", { turnId: r.turnId }).then(loadAudit).catch(function (e) { auditNote.textContent = e.message; }); };
          acts.appendChild(ok); acts.appendChild(no); row.appendChild(acts);
        }
      }
      rowsBox.appendChild(row);
    });
    if (!audit.rows || audit.rows.length === 0) rowsBox.appendChild(el("div", { class: "dim" }, "{{ui.guests.no-turns}}"));
  }
  function loadAudit() {
    var q = [];
    if (filters.group) q.push("chat=" + encodeURIComponent(filters.group));
    if (filters.agent) q.push("agent=" + encodeURIComponent(filters.agent));
    if (filters.days) q.push("days=" + filters.days);
    if (filters.flagged) q.push("flagged=1");
    if (filters.held) q.push("held=1");
    return call("GET", "/api/guests/audit" + (q.length ? "?" + q.join("&") : "")).then(function (d) { audit = d; auditNote.textContent = ""; renderAudit(); }).catch(function (e) { auditNote.textContent = e.message; });
  }
  function refresh() { return call("GET", "/api/guests").then(function (d) { state = d; render(); }).catch(function () {}); }
  function numberInput(label, min, max) { return el("input", { type: "number", min: String(min), max: String(max), step: "1", class: "ui-w-xs", "aria-label": label }); }
  function mountPane(modal, actions) {
    var tabs = document.getElementById("settabs");
    tab = el("a", { href: "#", class: "tab", "data-settab": "guests" }, "{{ui.pane.guests}}");
    tab.style.display = "none";
    tabs.appendChild(tab);
    pane = el("div", { class: "field settab-off", "data-settab": "guests", id: "guestaudit" });
    pane.appendChild(el("label", {}, "{{ui.guests.audit}}"));
    pane.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.audit-note}}"));
    var bar = el("div", { class: "ui-row ui-gap", style: "flex-wrap:wrap" });
    var g = el("select", { id: "guestauditgroup", "aria-label": "{{ui.guests.group}}" });
    var ag = el("select", { id: "guestauditagent", "aria-label": "{{ui.guests.agent}}" });
    var when = el("select", { id: "guestauditdays", "aria-label": "{{ui.guests.when}}" });
    [["", "{{ui.guests.any-time}}"], ["1", "{{ui.guests.last-day}}"], ["7", "{{ui.guests.last-week}}"], ["30", "{{ui.guests.last-month}}"]].forEach(function (o) { when.appendChild(el("option", { value: o[0] }, o[1])); });
    var red = el("label", { style: "display:inline-flex;gap:4px;align-items:center" }); var redBox = el("input", { type: "checkbox", id: "guestauditflagged" }); red.appendChild(redBox); red.appendChild(document.createTextNode("{{ui.guests.flagged-only}}"));
    var wait = el("label", { style: "display:inline-flex;gap:4px;align-items:center" }); var waitBox = el("input", { type: "checkbox", id: "guestauditheld" }); wait.appendChild(waitBox); wait.appendChild(document.createTextNode("{{ui.guests.held-only}}"));
    function change() { filters = { group: g.value, agent: ag.value, days: when.value, flagged: redBox.checked, held: waitBox.checked }; loadAudit(); }
    g.onchange = change; ag.onchange = change; when.onchange = change; redBox.onchange = change; waitBox.onchange = change;
    [g, ag, when, red, wait].forEach(function (n) { bar.appendChild(n); });
    pane.appendChild(bar);
    rowsBox = el("div", { id: "guestauditrows" }); pane.appendChild(rowsBox);
    groupsBox = el("div", { id: "guestauditgroups", class: "ui-gap" }); pane.appendChild(groupsBox);
    auditNote = el("div", { class: "fieldnote" }, ""); pane.appendChild(auditNote);
    modal.insertBefore(pane, actions);
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("guestanswers")) return false;
    var actions = modal.querySelector(".actions");
    field = el("div", { class: "field settab-off", "data-settab": "team", id: "guestanswers" });
    field.style.display = "none";
    field.appendChild(el("label", {}, "{{ui.guests.guests}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.what-a-guest-turn-holds}}"));
    list = el("div", { id: "guestanswerlist", class: "ui-gap" });
    field.appendChild(list);
    var capRow = el("div", { class: "ui-list-row" });
    capRow.appendChild(el("span", { class: "ui-w-md" }, "{{ui.guests.turns-per-group-chat-per-day}}"));
    cap = numberInput("{{ui.guests.turns-per-group-chat-per-day}}", 1, 100000);
    cap.onchange = function () { post("/api/guests/cap", { perGroupPerDay: Number(cap.value) }); };
    capRow.appendChild(cap);
    field.appendChild(capRow);
    var winRow = el("div", { class: "ui-list-row", style: "flex-wrap:wrap" });
    winRow.appendChild(el("span", { class: "ui-w-md" }, "{{ui.guests.window}}"));
    winTurns = numberInput("{{ui.guests.window-exchanges}}", 0, 20); winMinutes = numberInput("{{ui.guests.window-minutes}}", 1, 1440);
    function saveWindow() { post("/api/guests/window", { exchanges: Number(winTurns.value), minutes: Number(winMinutes.value) }); }
    winTurns.onchange = saveWindow; winMinutes.onchange = saveWindow;
    winRow.appendChild(winTurns); winRow.appendChild(el("span", { class: "dim" }, "{{ui.guests.window-exchanges}}"));
    winRow.appendChild(winMinutes); winRow.appendChild(el("span", { class: "dim" }, "{{ui.guests.window-minutes}}"));
    field.appendChild(winRow);
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.window-note}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.public-to-guests}}"));
    sets = el("div", { id: "guestknowledge", class: "ui-gap" });
    field.appendChild(sets);
    var newSet = el("input", { type: "text", placeholder: "{{ui.guests.new-collection}}", "aria-label": "{{ui.guests.new-collection}}" });
    var addSet = el("button", { class: "btn sm", type: "button" }, "{{ui.guests.add-collection}}");
    addSet.onclick = function () { post("/api/guests/collections", { name: newSet.value }).then(function () { if (note.textContent === "{{ui.guests.saved}}") newSet.value = ""; }); };
    var setRow = el("div", { class: "ui-list-row" }); setRow.appendChild(newSet); setRow.appendChild(addSet); field.appendChild(setRow);
    setPick = el("select", { "aria-label": "{{ui.guests.collection}}" });
    var title = el("input", { type: "text", placeholder: "{{ui.guests.title}}", "aria-label": "{{ui.guests.title}}" });
    var text = el("textarea", { rows: "3", placeholder: "{{ui.guests.text}}", "aria-label": "{{ui.guests.text}}" });
    var add = el("button", { class: "btn sm", type: "button" }, "{{ui.guests.add}}");
    add.onclick = function () { post("/api/guests/knowledge", { title: title.value, text: text.value, collection: setPick.value }).then(function () { if (state && note.textContent === "{{ui.guests.saved}}") { title.value = ""; text.value = ""; } }); };
    field.appendChild(setPick); field.appendChild(title); field.appendChild(text); field.appendChild(add);
    note = el("div", { class: "fieldnote", id: "guestnote" }, "");
    field.appendChild(note);
    modal.insertBefore(field, actions);
    mountPane(modal, actions);
    document.getElementById("settabs").addEventListener("click", function (event) {
      var a = event.target.closest("a[data-settab]"); if (!a) return;
      if (a.getAttribute("data-settab") === "team") refresh();
      if (a.getAttribute("data-settab") === "guests") loadAudit();
    });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
