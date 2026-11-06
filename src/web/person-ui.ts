/**
 * Settings → Mine → About me (INV-1653): the host's record of the person, by field, each line
 * with who wrote it and a way to retract it; a row to add one. Its own script, like the other
 * settings sections: the page is at its size ceiling.
 */

export const PERSON_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var LABEL = { responsibilities: "{{ui.person.responsibilities}}", projects: "{{ui.person.projects-under-way}}", goals: "{{ui.person.long-term-goals}}", interests: "{{ui.person.interests}}", habits: "{{ui.person.habits-and-working-hours}}", preferences: "{{ui.person.preferences}}" };
  var list, note, pick, input, data = { fields: [], entries: [] };
  function render() {
    if (!list) return;
    list.textContent = "";
    data.fields.forEach(function (field) {
      var lines = data.entries.filter(function (e) { return e.field === field; });
      if (!lines.length) return;
      list.appendChild(el("div", { class: "dim", style: "font-size:11px;letter-spacing:.04em;text-transform:uppercase;margin-top:6px" }, LABEL[field] || field));
      lines.forEach(function (e) {
        var row = el("div", { class: "ui-list-row" });
        row.appendChild(el("span", { class: "ui-grow" }, e.text));
        var who = e.source === "person" ? "{{ui.person.you}}" : e.source.indexOf("agent:") === 0 ? "{{ui.person.learned-by}} " + e.source.slice(6) : "{{ui.person.sensed}}";
        row.appendChild(el("span", { class: "dim", title: e.at }, who + (e.expiresAt ? " {{ui.person.until}} " + e.expiresAt.slice(0, 10) : "")));
        var x = el("button", { class: "btn sm ghost", title: "{{ui.person.retract-this-line}}", "aria-label": "{{ui.person.retract}} " + e.text }, "×");
        x.onclick = function () { call("POST", "/api/person/retract", { id: e.id }).then(function (d) { data = d; render(); }).catch(function (err) { note.textContent = err.message; }); };
        row.appendChild(x);
        list.appendChild(row);
      });
    });
    if (!data.entries.length) list.appendChild(el("div", { class: "dim", style: "font-size:12px;padding:4px" }, "{{ui.person.nothing-on-the-record-yet}}"));
  }
  function refresh() { return call("GET", "/api/person").then(function (d) { data = d; render(); }).catch(function () {}); }
  function add() {
    var text = input.value.trim(); if (!text) return;
    call("POST", "/api/person", { field: pick.value, text: text }).then(function (d) { data = d; input.value = ""; note.textContent = ""; render(); }).catch(function (err) { note.textContent = err.message; });
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("aboutme")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "mine", id: "aboutme" });
    field.appendChild(el("label", {}, "{{ui.person.about-me}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.person.one-record-of-you-that}}"));
    list = el("div", { id: "aboutmelist", class: "ui-gap" });
    var row = el("div", { class: "ui-list-row" });
    pick = el("select", { "aria-label": "{{ui.person.which-part-of-the-record}}" });
    Object.keys(LABEL).forEach(function (k) { pick.appendChild(el("option", { value: k }, LABEL[k])); });
    input = el("input", { type: "text", class: "ui-grow", placeholder: "{{ui.person.one-line-e-g-replies}}", "aria-label": "{{ui.person.a-line-about-you}}" });
    input.onkeydown = function (ev) { if (ev.key === "Enter") { ev.preventDefault(); add(); } };
    var btn = el("button", { class: "btn sm" }, "{{ui.person.add}}"); btn.onclick = add;
    row.appendChild(pick); row.appendChild(input); row.appendChild(btn);
    note = el("div", { class: "fieldnote", id: "aboutmenote" }, "");
    field.appendChild(list); field.appendChild(row); field.appendChild(note);
    modal.insertBefore(field, document.getElementById("setmcptokenswrap") || actions); // first on the tab: the person is what "Mine" is about
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "mine") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
