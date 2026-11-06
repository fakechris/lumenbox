/**
 * Settings → Team → Agents: each agent's spend today against its lines (INV-1615), and the lines
 * themselves to edit. Its own script, like the other settings sections: the page is at its size ceiling.
 */

export const SPEND_LIMIT_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  function money(n) { return n >= 100 ? n.toFixed(0) : n.toFixed(2); }
  var list, note, today = {};
  function render() {
    if (!list) return;
    list.textContent = "";
    (window.agents || []).forEach(function (a) {
      var t = today[a.id]; if (!t) return;
      var row = el("div", { class: "ui-list-row" });
      row.appendChild(el("span", { class: "ui-w-md" }, a.name));
      var spent = money(t.spent) + " {{ui.spend-limit.of}} " + money(t.limits.perDay) + " {{ui.spend-limit.today}}" + (t.unpricedTokens ? " · " + Math.round(t.unpricedTokens / 1000) + "{{ui.spend-limit.k-unpriced-tokens}}" + t.unpricedModels.join(", ") + ")" : "") + (t.pausedAt ? " {{ui.spend-limit.paused-at-the-line}}" : "");
      row.appendChild(el("span", { class: "ui-grow dim", title: spent }, spent));
      function field(key, label, step) {
        var input = el("input", { type: "number", min: "0", step: step, value: String(t.limits[key]), "aria-label": label + " {{ui.spend-limit.for}} " + a.name, title: label, class: "ui-w-xs" });
        input.onchange = function () {
          var body = { id: a.id }; body[key] = input.value === "" ? null : Number(input.value);
          call("POST", "/api/agents/spend-limits", body)
            .then(function (d) { today[a.id] = d; note.textContent = a.name + ": " + money(d.limits.perDay) + " {{ui.spend-limit.a-day}} " + money(d.limits.perWake) + " {{ui.spend-limit.a-wake}}"; render(); })
            .catch(function (e) { note.textContent = e.message; });
        };
        return input;
      }
      row.appendChild(el("span", { class: "dim" }, "{{ui.spend-limit.day}}"));
      row.appendChild(field("perDay", "{{ui.spend-limit.daily-spend-line}}", "1"));
      row.appendChild(el("span", { class: "dim" }, "{{ui.spend-limit.wake}}"));
      row.appendChild(field("perWake", "{{ui.spend-limit.spend-line-for-one-wake}}", "0.5"));
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/agents/spend-limits").then(function (d) { today = d.agents || {}; render(); }).catch(function () {}); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("spendlimits")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "spendlimits" });
    field.appendChild(el("label", {}, "{{ui.spend-limit.spend}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.spend-limit.what-each-agent-may-spend}}"));
    list = el("div", { id: "spendlimitlist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "spendlimitnote" }, "");
    field.appendChild(list); field.appendChild(note);
    modal.insertBefore(field, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "team") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
