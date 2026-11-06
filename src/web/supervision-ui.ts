/**
 * Settings → Supervision (INV-1528): the watchdog's switches, the supervisor's model and limits,
 * and its runs — start one, watch it, read it, stop it.
 *
 * Served at /app/supervision.js and loaded by the page, like the decision-model section: the page
 * is one inlined document at its size ceiling, and this tab is self-contained. It adds its own tab
 * link and fields (each carrying data-settab="supervision", so the page's tab switch shows and hides
 * them) and talks only to /api/supervision. It also marks a goal that a running supervisor is
 * watching, wherever the page shows that task. ES5 and string building, like the page it joins.
 */

export const SUPERVISION_JS = `(function () {
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function field(label) {
    var wrap = el("div", { class: "field settab-off", "data-settab": "supervision" });
    if (label) wrap.appendChild(el("label", {}, label));
    return wrap;
  }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var ui = {}, data = null, runsTimer = null, watching = {};

  function number(id, value) { var input = el("input", { id: id, type: "number", min: "1", class: "ui-w-sm" }); input.value = value === undefined ? "" : String(value); return input; }

  function mount() {
    var tabs = document.getElementById("settabs");
    var modal = document.querySelector("#settingswrap .modal");
    if (!tabs || !modal || document.getElementById("supwatchdog")) return;
    tabs.appendChild(el("a", { href: "#", class: "tab", "data-settab": "supervision" }, "{{ui.pane.supervision}}"));
    var fields = modal.querySelectorAll(".field[data-settab]");
    var anchor = fields.length ? fields[fields.length - 1] : null;
    var after = anchor ? anchor.nextSibling : null;
    function add(node) { modal.insertBefore(node, after); }

    var intro = field();
    intro.appendChild(el("div", { class: "fieldnote" }, "{{ui.supervision.supervision-runs-beside-lumenbox-outside}}"));
    add(intro);

    var wd = field("{{ui.supervision.watchdog}}");
    ui.wdOn = el("input", { type: "checkbox", id: "supwatchdog" });
    ui.wdJudge = el("input", { type: "checkbox", id: "supjudge" });
    ui.stall = number("supstall"); ui.paused = number("suppaused");
    var row1 = el("div", { class: "ui-row" });
    row1.appendChild(ui.wdOn); row1.appendChild(el("span", {}, "{{ui.supervision.on}}"));
    row1.appendChild(el("span", { class: "dim" }, "{{ui.supervision.flag-work-in-hand-after}}")); row1.appendChild(ui.stall); row1.appendChild(el("span", { class: "dim" }, "{{ui.supervision.min-still}}"));
    row1.appendChild(el("span", { class: "dim" }, "{{ui.supervision.a-stopped-goal-after}}")); row1.appendChild(ui.paused); row1.appendChild(el("span", { class: "dim" }, "{{ui.supervision.min-unattended}}"));
    var row2 = el("div", { class: "ui-row ui-gap" });
    row2.appendChild(ui.wdJudge); row2.appendChild(el("span", { class: "dim" }, "{{ui.supervision.ask-the-decision-model-once}}"));
    ui.flag = el("div", { class: "fieldnote" });
    wd.appendChild(row1); wd.appendChild(row2); wd.appendChild(ui.flag);
    add(wd);

    var sv = field("{{ui.supervision.supervisor-model}}");
    ui.provider = el("select", { id: "supprovider" });
    ui.model = el("input", { id: "supmodel", spellcheck: "false", class: "ui-w-md" });
    ui.keyNote = el("div", { class: "fieldnote" });
    var row3 = el("div", { class: "ui-row" });
    row3.appendChild(ui.provider); row3.appendChild(ui.model);
    sv.appendChild(row3); sv.appendChild(ui.keyNote);
    ui.provider.addEventListener("change", function () { var p = providerNamed(ui.provider.value); if (p && !ui.model.value) ui.model.value = p.defaultModel; renderKey(); });
    add(sv);

    var lim = field("{{ui.supervision.runs-by-default}}");
    ui.agent = el("select", { id: "supagent" });
    ui.budget = number("supbudget"); ui.budget.placeholder = "{{ui.supervision.none}}";
    ui.maxMinutes = number("supmaxmin"); ui.maxCalls = number("supmaxcalls");
    var row4 = el("div", { class: "ui-row" });
    row4.appendChild(el("span", { class: "dim" }, "agent")); row4.appendChild(ui.agent);
    row4.appendChild(el("span", { class: "dim" }, "{{ui.supervision.budget}}")); row4.appendChild(ui.budget);
    row4.appendChild(el("span", { class: "dim" }, "{{ui.supervision.at-most}}")); row4.appendChild(ui.maxMinutes); row4.appendChild(el("span", { class: "dim" }, "{{ui.supervision.min-and}}")); row4.appendChild(ui.maxCalls); row4.appendChild(el("span", { class: "dim" }, "{{ui.supervision.model-calls}}"));
    ui.save = el("button", { class: "btn" }, "{{ui.supervision.save-supervision-settings}}");
    ui.saveNote = el("span", { class: "dim" });
    ui.save.addEventListener("click", save);
    lim.appendChild(row4); var row5 = el("div", { class: "ui-actions" }); row5.appendChild(ui.save); row5.appendChild(ui.saveNote); lim.appendChild(row5);
    add(lim);

    var runs = field("{{ui.supervision.supervisor-runs}}");
    ui.objective = el("textarea", { id: "supobjective", rows: "2", placeholder: "{{ui.supervision.what-done-looks-like-e}}", class: "ui-w-full" });
    ui.start = el("button", { class: "btn" }, "{{ui.supervision.start-a-supervised-goal}}");
    ui.startNote = el("span", { class: "dim" });
    ui.start.addEventListener("click", start);
    ui.runs = el("div", { id: "supruns", class: "ui-gap" });
    ui.detail = el("pre", { id: "suprundetail", class: "ui-log", style: "display:none" });
    runs.appendChild(ui.objective); var row6 = el("div", { class: "ui-row ui-gap" }); row6.appendChild(ui.start); row6.appendChild(ui.startNote); runs.appendChild(row6);
    runs.appendChild(ui.runs); runs.appendChild(ui.detail);
    add(runs);

    tabs.addEventListener("click", function (event) {
      var a = event.target.closest("a[data-settab]");
      if (a && a.getAttribute("data-settab") === "supervision") load();
    });
  }

  function providerNamed(name) { if (!data) return null; for (var i = 0; i < data.providers.length; i++) if (data.providers[i].name === name) return data.providers[i]; return null; }
  function renderKey() {
    var p = providerNamed(ui.provider.value);
    ui.keyNote.textContent = !p ? "" : p.hasKey ? "{{ui.supervision.uses-the}} " + p.label + " {{ui.supervision.key-set-in-settings-model}}" : "{{ui.supervision.no}} " + p.label + " {{ui.supervision.key-yet-add-it-in}}";
  }

  function load() {
    call("GET", "/api/supervision").then(function (d) {
      data = d;
      var s = d.settings;
      ui.wdOn.checked = s.watchdog.enabled; ui.wdJudge.checked = s.watchdog.judge;
      ui.stall.value = s.watchdog.stallMinutes; ui.paused.value = s.watchdog.pausedMinutes;
      ui.flag.textContent = d.lastFlag ? "{{ui.supervision.last-flag}} " + d.lastFlag : "{{ui.supervision.no-flag-raised-yet}}";
      ui.provider.textContent = "";
      d.providers.forEach(function (p) { var o = el("option", { value: p.name }, p.label + (p.hasKey ? "" : " {{ui.supervision.no-key}}")); if (p.name === s.supervisor.provider) o.selected = true; ui.provider.appendChild(o); });
      ui.model.value = s.supervisor.model;
      ui.agent.textContent = ""; ui.agent.appendChild(el("option", { value: "" }, "{{ui.supervision.the-coordinator}}"));
      d.agents.forEach(function (name) { var o = el("option", { value: name }, name); if (name === s.supervisor.agent) o.selected = true; ui.agent.appendChild(o); });
      ui.budget.value = s.supervisor.budget === undefined ? "" : s.supervisor.budget;
      ui.maxMinutes.value = s.supervisor.maxMinutes; ui.maxCalls.value = s.supervisor.maxModelCalls;
      renderKey();
      refreshRuns();
      if (!runsTimer) runsTimer = setInterval(function () { if (!document.getElementById("supruns") || document.getElementById("supruns").offsetParent === null) return; refreshRuns(); }, 5000);
    }).catch(function (e) { ui.flag.textContent = e.message; });
  }

  function save() {
    ui.saveNote.textContent = "{{ui.supervision.saving}}";
    call("POST", "/api/supervision/settings", {
      watchdog: { enabled: ui.wdOn.checked, judge: ui.wdJudge.checked, stallMinutes: ui.stall.value, pausedMinutes: ui.paused.value },
      supervisor: { provider: ui.provider.value, model: ui.model.value, agent: ui.agent.value, budget: ui.budget.value, maxMinutes: ui.maxMinutes.value, maxModelCalls: ui.maxCalls.value },
    }).then(function (d) { ui.saveNote.textContent = d.note; }).catch(function (e) { ui.saveNote.textContent = e.message; });
  }

  function start() {
    var objective = ui.objective.value.trim();
    if (!objective) { ui.startNote.textContent = "{{ui.supervision.write-what-done-looks-like}}"; return; }
    if (!confirm("{{ui.supervision.this-creates-a-task-on}} " + (ui.agent.value || "{{ui.supervision.the-coordinator}}") + "{{ui.supervision.and-both-the-supervisors-model}}")) return;
    ui.startNote.textContent = "{{ui.supervision.starting}}";
    call("POST", "/api/supervision/runs", { objective: objective, agent: ui.agent.value, budget: ui.budget.value })
      .then(function () { ui.objective.value = ""; ui.startNote.textContent = "{{ui.supervision.queued-the-supervisor-picks-it}}"; refreshRuns(); })
      .catch(function (e) { ui.startNote.textContent = e.message; });
  }

  function refreshRuns() {
    call("GET", "/api/supervision/runs").then(function (d) {
      watching = {};
      ui.runs.textContent = "";
      if (d.runs.length === 0) { ui.runs.appendChild(el("div", { class: "dim" }, "{{ui.supervision.no-runs-yet}}")); return; }
      d.runs.slice(0, 20).forEach(function (run) {
        if (run.state === "running" && run.goalId) watching[run.goalId] = run.id;
        var row = el("div", { class: "ui-list-row" });
        row.appendChild(el("span", { class: "ui-w-xs" }, run.state));
        row.appendChild(el("span", { class: "ui-w-xs" }, run.goalId || "—"));
        row.appendChild(el("span", { class: "ui-grow", title: run.objective }, run.objective));
        row.appendChild(el("span", { class: "dim" }, (run.outcome || "") + (run.modelCalls !== undefined ? " · " + run.modelCalls + " {{ui.supervision.calls}}" : "") + (run.tokens ? " · " + (run.tokens.input + run.tokens.output) + " {{ui.supervision.tokens}}" : "") + (run.error ? " · " + run.error : "")));
        var view = el("a", { href: "#" }, "{{ui.supervision.view}}");
        view.addEventListener("click", function (event) { event.preventDefault(); show(run.id); });
        row.appendChild(view);
        if (run.state === "running" || run.state === "queued") {
          var stop = el("a", { href: "#" }, "{{ui.supervision.stop}}");
          stop.addEventListener("click", function (event) { event.preventDefault(); call("POST", "/api/supervision/runs/" + run.id + "/stop").then(refreshRuns); });
          row.appendChild(stop);
        }
        ui.runs.appendChild(row);
      });
      markWatched();
    }).catch(function () {});
  }

  function show(id) {
    call("GET", "/api/supervision/runs/" + id).then(function (d) {
      var lines = [d.summary || ("{{ui.supervision.run}} " + id + ": " + d.run.state)];
      d.transcript.forEach(function (e) {
        if (e.kind === "model") lines.push("{{ui.supervision.model}}" + e.n + ": " + (e.calls.length ? e.calls.map(function (c) { return c.name; }).join(", ") : "") + (e.text ? " — " + e.text : ""));
        else if (e.kind === "tool") lines.push("  " + e.name + (e.isError || e.refused ? " REFUSED: " : ": ") + String(e.reply || e.refused || "").split("\\n")[0]);
      });
      ui.detail.textContent = lines.join("\\n");
      ui.detail.style.display = "block";
    });
  }

  /** A goal a running supervisor watches is marked wherever the page lists that task. */
  function markWatched() {
    var links = document.querySelectorAll("[data-task]");
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute("data-task");
      var badge = links[i].parentNode && links[i].parentNode.querySelector(".supbadge");
      if (watching[id] && !badge) links[i].parentNode.appendChild(el("span", { class: "supbadge dim ui-badge", title: "{{ui.supervision.a-supervisor-is-watching-this}}" }, "{{ui.supervision.supervised}}"));
      if (!watching[id] && badge) badge.parentNode.removeChild(badge);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  setInterval(function () { if (Object.keys(watching).length) markWatched(); }, 3000);
  setInterval(function () { if (document.getElementById("supruns") && document.getElementById("supruns").offsetParent === null) call("GET", "/api/supervision/runs").then(function (d) { watching = {}; d.runs.forEach(function (r) { if (r.state === "running" && r.goalId) watching[r.goalId] = r.id; }); markWatched(); }).catch(function () {}); }, 15000);
})();
`;
