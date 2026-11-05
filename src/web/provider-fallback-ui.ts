/**
 * Settings → Model → Fallback providers (INV-1578): up to three presets, in order, to go on with when
 * the default provider is out of usage, and what they spent standing in over the last day.
 */

export const PROVIDER_FALLBACK_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var ui = {};
  function render(d) {
    ui.picks.textContent = "";
    ui.selects = [];
    for (var i = 0; i < 3; i++) {
      var s = el("select", { "data-fallback": String(i) });
      s.appendChild(el("option", { value: "" }, i === 0 ? "No fallback" : "—"));
      (d.presets || []).forEach(function (p) {
        var o = el("option", { value: p.name }, p.label + " · " + p.model + (p.hasKey ? "" : " (no key: left out)"));
        if ((d.names || [])[i] === p.name) o.selected = true;
        s.appendChild(o);
      });
      ui.picks.appendChild(s);
      ui.selects.push(s);
    }
    ui.spend.textContent = "";
    var spent = d.lastDay || [];
    if (!spent.length) ui.spend.appendChild(el("div", { class: "dim" }, "No fallback has answered in the last day."));
    spent.forEach(function (e) { ui.spend.appendChild(el("div", { class: "dim" }, e.provider + " stood in for " + e.standingInFor + ": " + e.rounds + " round(s), " + e.inputTokens + " tokens in, " + e.outputTokens + " out.")); });
  }
  function load() { call("GET", "/api/provider/fallbacks").then(render).catch(function (e) { ui.line.textContent = e.message; }); }
  function save() {
    var names = ui.selects.map(function (s) { return s.value; }).filter(Boolean);
    call("POST", "/api/provider/fallbacks", { names: names }).then(function (d) { render(d); ui.line.textContent = names.length ? "Saved. A turn whose provider is out of usage goes on with these, in order." : "Saved: no fallback."; }).catch(function (e) { ui.line.textContent = e.message; });
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("providerfallbacks")) return false;
    var wrap = el("div", { class: "field settab-off", "data-settab": "model", id: "providerfallbacks" });
    wrap.appendChild(el("label", {}, "Fallback providers"));
    wrap.appendChild(el("div", { class: "fieldnote" }, "When the provider above is out of usage, a turn goes on with these, in order, each tried once. The chat says which one answered and at what price; the next turn tries your provider again. An agent can have its own list."));
    ui.picks = el("div", { class: "ui-row ui-gap", id: "providerfallbackpicks" });
    var actions = el("div", { class: "ui-row ui-gap" });
    var b = el("button", { class: "btn", type: "button", id: "providerfallbacksave" }, "Save fallbacks");
    b.onclick = save;
    actions.appendChild(b);
    ui.spend = el("div", { class: "ui-gap", id: "providerfallbackspend" });
    ui.line = el("div", { class: "fieldnote" });
    wrap.appendChild(ui.picks); wrap.appendChild(actions); wrap.appendChild(ui.spend); wrap.appendChild(ui.line);
    var fields = modal.querySelectorAll('.field[data-settab="model"]');
    var anchor = fields.length ? fields[fields.length - 1] : modal.querySelector(".actions");
    if (fields.length) anchor.parentNode.insertBefore(wrap, anchor.nextSibling); else modal.insertBefore(wrap, anchor);
    tabs.addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "model") load(); });
    load();
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
})();
`;
