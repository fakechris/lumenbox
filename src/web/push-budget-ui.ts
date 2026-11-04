/**
 * Settings → Team → Pushes (INV-1576): how much each agent said to people on its own today, and
 * its daily allowance. Its own script, like the other settings sections: the page is at its size
 * ceiling.
 */

export const PUSH_BUDGET_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var list, note, counts = {};
  function render() {
    if (!list) return;
    list.textContent = "";
    (window.agents || []).forEach(function (a) {
      var c = counts[a.id] || { sent: 0, held: 0, exempt: 0, perDay: 8 };
      var row = el("div", { class: "ui-list-row", "data-pushes": a.id });
      row.appendChild(el("span", { class: "ui-w-md" }, a.name));
      var said = c.sent + " of " + c.perDay + " sent today" + (c.held ? " · " + c.held + " held for the digest" : "") + (c.exempt ? " · " + c.exempt + " needing a person" : "");
      row.appendChild(el("span", { class: "ui-grow dim", title: said }, said));
      var input = el("input", { type: "number", min: "0", max: "1000", value: String(c.perDay), "aria-label": "Daily allowance for " + a.name, class: "ui-w-xs" });
      input.onchange = function () {
        call("POST", "/api/agents/push-budget", { id: a.id, perDay: input.value === "" ? null : Number(input.value) })
          .then(function (d) { counts[a.id] = d; note.textContent = a.name + ": " + d.perDay + " a day."; render(); })
          .catch(function (e) { note.textContent = e.message; });
      };
      row.appendChild(input);
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/agents/push-budget").then(function (d) { counts = d.agents || {}; render(); }).catch(function () {}); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("pushbudgets")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "pushbudgets" });
    field.appendChild(el("label", {}, "Pushes"));
    field.appendChild(el("div", { class: "fieldnote" }, "What each agent sends people on its own, like a routine's result. Past its daily allowance, the rest are held and go out once, in the chat's daily briefing or at 18:00. Anything that needs a person is never held."));
    list = el("div", { id: "pushbudgetlist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "pushbudgetnote" }, "");
    field.appendChild(list); field.appendChild(note);
    modal.insertBefore(field, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "team") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
