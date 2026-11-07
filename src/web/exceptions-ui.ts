/**
 * The right pane's Issues tab (INV-1741): what failed, grouped by task, with how many times and
 * why, and Retry / Hand to me / Dismiss on each; the last week's resolved entries under them.
 * Also the Retry on a task's card (`exceptionRetryHtml(task)`, called from the board's row) and
 * the attention strip's buttons for a handed entry. Its own script, like the other sections: the
 * page is at its size ceiling, so the tab and its view are mounted from here.
 */

export const EXCEPTIONS_JS = `(function () {
  function esc(text) { return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var KIND = { turn: "{{ui.exceptions.kind-turn}}", job: "{{ui.exceptions.kind-job}}", delivery: "{{ui.exceptions.kind-delivery}}", routine: "{{ui.exceptions.kind-routine}}", box: "{{ui.exceptions.kind-box}}" };
  var data = { groups: [], open: 0, byTask: {} }, tab, view, list, note, shown = false;
  function when(iso) { return iso ? new Date(iso).toLocaleString() : ""; }
  function row(e) {
    var open = !e.resolvedAt;
    var state = open
      ? (e.handedAt ? '<span class="warn">{{ui.exceptions.handed-to}} ' + esc(e.handedBy || "") + "</span>" : '<span class="danger">{{ui.exceptions.open}}</span>')
      : '<span class="dim">' + (e.resolution === "dismissed" ? "{{ui.exceptions.dismissed}}" : "{{ui.exceptions.resolved}}") + " " + esc(when(e.resolvedAt)) + "</span>";
    var acts = open
      ? '<button class="btn sm" data-exc-retry="' + esc(e.id) + '">{{ui.exceptions.retry}}</button>' +
        (e.handedAt ? "" : '<button class="btn sm ghost" data-exc-hand="' + esc(e.id) + '">{{ui.exceptions.hand-to-me}}</button>') +
        '<button class="btn sm ghost" data-exc-dismiss="' + esc(e.id) + '">{{ui.exceptions.dismiss}}</button>'
      : "";
    return '<div data-exc-row="' + esc(e.id) + '" style="padding:5px 0;font-size:12.5px' + (open ? "" : ";opacity:.65") + '">' +
      '<div style="display:flex;gap:8px;align-items:baseline"><span class="chip" style="font-size:10px">' + esc(KIND[e.kind] || e.kind) + "</span>" +
      '<span data-exc-count style="font-weight:600" title="{{ui.exceptions.times-it-failed}}">×' + e.attempt + "</span>" +
      '<span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px" title="' + esc(e.subject) + '">' + esc(String(e.subject).slice(0, 160)) + "</span>" + state + "</div>" +
      '<div style="display:flex;gap:6px;align-items:baseline;padding-left:2px"><span class="dim" style="flex:1;min-width:0">' + esc(e.reason) + " · " + esc(when(e.at)) + "</span>" + acts + "</div></div>";
  }
  function render() {
    if (tab) tab.innerHTML = "{{ui.exceptions.issues}}" + (data.open ? ' <span class="chip" style="font-size:10px;color:var(--danger)">' + data.open + "</span>" : "");
    if (!list) return;
    if (!data.groups.length) { list.innerHTML = '<div class="dim" style="padding:12px 16px;font-size:13px">{{ui.exceptions.nothing-has-failed}}</div>'; return; }
    list.innerHTML = data.groups.map(function (g) {
      var title = g.task ? esc(g.title) : esc(KIND[g.title] || g.title);
      return '<div style="padding:10px 16px;border-bottom:1px solid var(--border)"><div style="display:flex;gap:8px;align-items:baseline;margin-bottom:4px">' +
        (g.task ? '<a href="#" data-att-task="' + esc(g.task) + '" style="flex:1;font-weight:500;text-decoration:none;color:var(--text)">' + title + "</a>" : '<span style="flex:1;font-weight:500">' + title + "</span>") +
        '<span class="dim" style="font-size:11px">' + g.open + " {{ui.exceptions.open}}</span></div>" + g.entries.map(row).join("") + "</div>";
    }).join("");
  }
  function refresh() {
    return call("GET", "/api/exceptions").then(function (d) {
      var before = JSON.stringify(data.byTask);
      data = d; render();
      if (before !== JSON.stringify(d.byTask) && typeof refreshTasks === "function" && document.getElementById("tasksview") && document.getElementById("tasksview").style.display !== "none") refreshTasks();
    }).catch(function () {});
  }
  window.exceptionRetryHtml = function (task) {
    var id = data.byTask && data.byTask[task.id];
    return id ? ' <button class="btn sm" data-exc-retry="' + esc(id) + '" title="{{ui.exceptions.retry-what-failed-on-this}}">{{ui.exceptions.retry}}</button>' : "";
  };
  function show(on) {
    shown = on;
    if (view) view.style.display = on ? "flex" : "none";
    var feed = document.getElementById("feed"); if (on && feed) feed.classList.add("yields"); // the activity feed gives the view its height, as it does for Tasks
    if (tab) tab.className = "tab" + (on ? " on" : "");
    if (on) refresh();
  }
  function mount() {
    var lead = document.querySelector("#rightpane .paneheader .lead"), audit = document.getElementById("auditview");
    if (!lead || !audit || document.getElementById("tabissues")) return false;
    tab = document.createElement("a"); tab.href = "#"; tab.id = "tabissues"; tab.className = "tab";
    lead.appendChild(tab);
    view = document.createElement("div"); view.id = "issuesview"; view.style.cssText = "display:none;flex:1;min-height:0;flex-direction:column";
    view.innerHTML = '<div class="bar" style="display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--border)"><span class="dim" style="flex:1;font-size:12px">{{ui.exceptions.what-failed-grouped-by-task}}</span><span class="dim" id="issuesnote" style="font-size:12px"></span><a href="#" id="issuesrefresh" class="dim" style="font-size:12px">{{ui.exceptions.refresh}}</a></div><div class="scroll" id="issueslist"></div>';
    audit.parentNode.insertBefore(view, audit.nextSibling);
    list = document.getElementById("issueslist"); note = document.getElementById("issuesnote");
    lead.addEventListener("click", function (event) {
      var a = event.target.closest ? event.target.closest("a.tab") : null;
      if (!a) return;
      if (a !== tab) return;
      event.preventDefault();
      // The page's own switch hides its views and clears its tabs; this view is the one none of them names.
      if (typeof showTab === "function") showTab("issues");
      show(true);
    });
    // Every other way the pane switches (a tab, a task link, the strip) goes through showTab: that is where this view is hidden.
    var pageShowTab = window.showTab;
    if (typeof pageShowTab === "function") window.showTab = function (which) { pageShowTab(which); if (which !== "issues" && shown) show(false); };
    document.getElementById("issuesrefresh").addEventListener("click", function (event) { event.preventDefault(); refresh(); });
    render();
    return true;
  }
  document.addEventListener("click", function (event) {
    var t = event.target && event.target.closest ? event.target : null;
    if (!t) return;
    var b = t.closest("[data-exc-retry]") || t.closest("[data-exc-hand]") || t.closest("[data-exc-dismiss]");
    if (!b) return;
    event.preventDefault();
    var action = b.hasAttribute("data-exc-retry") ? "retry" : b.hasAttribute("data-exc-hand") ? "hand" : "dismiss";
    var id = b.getAttribute("data-exc-" + action);
    b.disabled = true;
    call("POST", "/api/exceptions/" + action, { id: id })
      .then(function (d) { if (note) note.textContent = d.detail || ""; })
      .catch(function (e) { if (note) note.textContent = e.message; })
      .then(function () { return refresh(); })
      .then(function () { if (typeof renderAttention === "function") renderAttention(); });
  });
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setInterval(refresh, 20000);
  setTimeout(refresh, 1500);
})();
`;
