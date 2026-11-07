/**
 * Settings → Team → Guests (INV-1708, docs/97): who each agent answers in group chats, the daily
 * guest turns per group chat, and the knowledge public to guests. Drawn only on an organisation:
 * a personal installation answers no guests, so it has nothing here to set.
 */

export const GUEST_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var field, list, cap, entries, note, state = null;
  function post(path, body) { return call("POST", path, body).then(function (d) { state = d; note.textContent = "{{ui.guests.saved}}"; render(); }).catch(function (e) { note.textContent = e.message; }); }
  function render() {
    if (!field) return;
    if (!state || !state.available) { field.style.display = "none"; return; }
    field.style.display = "";
    list.textContent = "";
    (window.agents || []).forEach(function (a) {
      var row = el("div", { class: "ui-list-row" });
      row.appendChild(el("span", { class: "ui-w-md" }, a.name));
      var pick = el("select", { "aria-label": "{{ui.guests.answers-in-group-chats}} " + a.name });
      [["members", "{{ui.guests.members-only}}"], ["guests", "{{ui.guests.members-and-guests}}"]].forEach(function (o) {
        var opt = el("option", { value: o[0] }, o[1]); if ((state.agents[a.id] || "members") === o[0]) opt.selected = true; pick.appendChild(opt);
      });
      pick.onchange = function () { post("/api/guests/answers", { id: a.id, mode: pick.value }); };
      row.appendChild(pick);
      list.appendChild(row);
    });
    cap.value = String(state.perGroupPerDay);
    entries.textContent = "";
    (state.knowledge || []).forEach(function (k) {
      var row = el("div", { class: "ui-list-row" });
      row.appendChild(el("span", { class: "ui-grow", title: k.text }, k.title));
      var remove = el("button", { class: "btn sm ghost", type: "button" }, "{{ui.guests.remove}}");
      remove.onclick = function () { post("/api/guests/knowledge/remove", { id: k.id }); };
      row.appendChild(remove);
      entries.appendChild(row);
    });
    if (!state.knowledge || state.knowledge.length === 0) entries.appendChild(el("div", { class: "dim" }, "{{ui.guests.no-public-knowledge}}"));
  }
  function refresh() { return call("GET", "/api/guests").then(function (d) { state = d; render(); }).catch(function () {}); }
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
    cap = el("input", { type: "number", min: "1", step: "1", class: "ui-w-xs", "aria-label": "{{ui.guests.turns-per-group-chat-per-day}}" });
    cap.onchange = function () { post("/api/guests/cap", { perGroupPerDay: Number(cap.value) }); };
    capRow.appendChild(cap);
    field.appendChild(capRow);
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.guests.public-to-guests}}"));
    entries = el("div", { id: "guestknowledge", class: "ui-gap" });
    field.appendChild(entries);
    var title = el("input", { type: "text", placeholder: "{{ui.guests.title}}", "aria-label": "{{ui.guests.title}}" });
    var text = el("textarea", { rows: "3", placeholder: "{{ui.guests.text}}", "aria-label": "{{ui.guests.text}}" });
    var add = el("button", { class: "btn sm", type: "button" }, "{{ui.guests.add}}");
    add.onclick = function () { post("/api/guests/knowledge", { title: title.value, text: text.value }).then(function () { if (state && note.textContent === "{{ui.guests.saved}}") { title.value = ""; text.value = ""; } }); };
    field.appendChild(title); field.appendChild(text); field.appendChild(add);
    note = el("div", { class: "fieldnote", id: "guestnote" }, "");
    field.appendChild(note);
    modal.insertBefore(field, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "team") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
