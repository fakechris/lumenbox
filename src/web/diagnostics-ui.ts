/**
 * Settings → Boxes → Resources (INV-1559): what this app and its box are holding right now, read-only,
 * and a heap snapshot on request. Its own script, like the other settings sections.
 */

export const DIAGNOSTICS_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  function mb(bytes) { return typeof bytes === "number" ? Math.round(bytes / 1048576) + " MB" : "—"; }
  var ui = {};
  function row(label, value) { var r = el("div", { class: "ui-list-row" }); r.appendChild(el("span", { class: "ui-w-md" }, label)); r.appendChild(el("span", { class: "ui-grow dim" }, value)); ui.list.appendChild(r); }
  function render(d) {
    ui.list.textContent = "";
    var p = d.process || {}, loop = d.eventLoop || {}, box = d.box || {};
    row("This app", mb(p.rss) + " resident; JavaScript heap " + mb(p.heapUsed) + " of " + mb(p.heapTotal) + "; buffers " + mb(p.arrayBuffers));
    row("Responsiveness", "event-loop delay p99 " + loop.p99Ms + " ms, worst " + loop.maxMs + " ms" + (loop.sinceStart ? " (since this panel first asked)" : " (since the last refresh)"));
    row("Open pages", String(d.eventSubscribers) + " event stream(s)");
    if (box.error) row("Box", "not readable: " + box.error);
    else {
      var ev = box.memoryEvents || {}, cpu = box.cpu || {};
      row("Box memory", mb(box.memoryCurrent) + " of " + (box.memoryMax === "max" ? "no limit" : mb(box.memoryMax)) + (ev.oom_kill ? "; the kernel has stopped " + ev.oom_kill + " process(es) for memory" : ""));
      row("Box CPU", cpu.usage_usec !== undefined ? Math.round(cpu.usage_usec / 1e6) + " CPU-seconds used" + (cpu.nr_throttled ? "; held back " + cpu.nr_throttled + " time(s) by its limit" : "") : "—");
    }
    (d.agents || []).filter(function (a) { return a.activeTurns || a.queued || a.watchedJobs; }).forEach(function (a) {
      row(a.name, a.activeTurns + " turn(s) running, " + a.queued + " message(s) waiting, " + a.watchedJobs + " background job(s) watched");
    });
    ui.line.textContent = "As of " + new Date(d.at).toLocaleTimeString() + ".";
  }
  function load() { call("GET", "/api/diagnostics/resources").then(render).catch(function (e) { ui.line.textContent = e.message; }); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("diagnostics")) return false;
    var wrap = el("div", { class: "field settab-off", "data-settab": "boxes", id: "diagnostics" });
    wrap.appendChild(el("label", {}, "Resources"));
    wrap.appendChild(el("div", { class: "fieldnote" }, "What this app and its box are holding now. Read-only: nothing here changes anything."));
    ui.list = el("div", { id: "diagnosticslist", class: "ui-gap" });
    ui.line = el("div", { class: "fieldnote", id: "diagnosticsline" }, "…");
    var actions = el("div", { class: "ui-row ui-gap" });
    var refresh = el("button", { class: "btn", id: "diagnosticsrefresh" }, "Refresh");
    var snap = el("a", { href: "#", class: "ui-link", id: "diagnosticssnapshot" }, "Write a heap snapshot…");
    refresh.onclick = function () { load(); };
    snap.onclick = function (event) {
      event.preventDefault();
      window.askInline(snap, "A heap snapshot is a copy of everything this app holds in memory, conversations included. It is written to the diagnostics folder in the app's data directory, can be hundreds of megabytes, and the app pauses while it is written. Type yes to write one:", "").then(function (answer) {
        if (answer === null || String(answer).trim().toLowerCase() !== "yes") return;
        ui.line.textContent = "Writing…";
        call("POST", "/api/diagnostics/heap-snapshot").then(function (d) { ui.line.textContent = "Written: " + d.path + " (" + mb(d.bytes) + "). " + d.note; }).catch(function (e) { ui.line.textContent = e.message; });
      });
    };
    actions.appendChild(refresh); actions.appendChild(snap);
    wrap.appendChild(ui.list); wrap.appendChild(actions); wrap.appendChild(ui.line);
    var fields = modal.querySelectorAll('.field[data-settab="boxes"]');
    var anchor = fields.length ? fields[fields.length - 1] : modal.querySelector(".actions");
    if (fields.length) anchor.parentNode.insertBefore(wrap, anchor.nextSibling); else modal.insertBefore(wrap, anchor);
    tabs.addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "boxes") load(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
})();
`;
