/**
 * Settings → Model → Provider status (INV-1577): an account out of usage, until when, and Retry now.
 * Its own script, like the other settings sections. Shows nothing while every account answers.
 */

export const PROVIDER_REST_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var ui = {};
  function render(d) {
    ui.list.textContent = "";
    var rests = d.rests || [];
    if (!rests.length) { ui.list.appendChild(el("div", { class: "dim" }, "Every provider account is answering.")); return; }
    rests.forEach(function (r) {
      var row = el("div", { class: "ui-list-row" });
      row.appendChild(el("span", { class: "ui-w-md" }, r.label));
      row.appendChild(el("span", { class: "ui-grow dim" }, "Out of usage since " + new Date(r.since).toLocaleString() + "; resting until " + new Date(r.until).toLocaleString() + " (" + r.streak + " answer" + (r.streak === 1 ? "" : "s") + " in a row). " + r.reason));
      var b = el("button", { class: "btn", type: "button" }, "Retry now");
      b.onclick = function () { b.disabled = true; call("POST", "/api/provider/rests/retry", { account: r.account }).then(load).catch(function (e) { ui.line.textContent = e.message; b.disabled = false; }); };
      row.appendChild(b);
      ui.list.appendChild(row);
    });
  }
  function load() { call("GET", "/api/provider/rests").then(render).catch(function (e) { ui.line.textContent = e.message; }); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("providerrests")) return false;
    var wrap = el("div", { class: "field settab-off", "data-settab": "model", id: "providerrests" });
    wrap.appendChild(el("label", {}, "Provider status"));
    wrap.appendChild(el("div", { class: "fieldnote" }, "A provider whose plan is out of usage rests for every agent at once instead of being retried; one call checks when the rest ends."));
    ui.list = el("div", { id: "providerrestlist", class: "ui-gap" });
    ui.line = el("div", { class: "fieldnote" });
    wrap.appendChild(ui.list);
    wrap.appendChild(ui.line);
    // After the Model tab's last field, the way the other sections place themselves.
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
