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

  function number(id, value) { var input = el("input", { id: id, type: "number", min: "1", style: "width:90px" }); input.value = value === undefined ? "" : String(value); return input; }

  function mount() {
    var tabs = document.getElementById("settabs");
    var modal = document.querySelector("#settingswrap .modal");
    if (!tabs || !modal || document.getElementById("supwatchdog")) return;
    tabs.appendChild(el("a", { href: "#", class: "tab", "data-settab": "supervision" }, "Supervision"));
    var fields = modal.querySelectorAll(".field[data-settab]");
    var anchor = fields.length ? fields[fields.length - 1] : null;
    var after = anchor ? anchor.nextSibling : null;
    function add(node) { modal.insertBefore(node, after); }

    var intro = field();
    intro.appendChild(el("div", { class: "fieldnote" }, "Supervision runs beside LumenBox, outside its server: a watchdog that flags work which stops moving, and a supervisor you can give a goal to watch through to the end. Neither can touch the box, mark work done, resume what the system stopped, or raise a budget."));
    add(intro);

    var wd = field("Watchdog");
    ui.wdOn = el("input", { type: "checkbox", id: "supwatchdog" });
    ui.wdJudge = el("input", { type: "checkbox", id: "supjudge" });
    ui.stall = number("supstall"); ui.paused = number("suppaused");
    var row1 = el("div", { style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" });
    row1.appendChild(ui.wdOn); row1.appendChild(el("span", {}, "on"));
    row1.appendChild(el("span", { class: "dim" }, "flag work in hand after")); row1.appendChild(ui.stall); row1.appendChild(el("span", { class: "dim" }, "min still,"));
    row1.appendChild(el("span", { class: "dim" }, "a stopped goal after")); row1.appendChild(ui.paused); row1.appendChild(el("span", { class: "dim" }, "min unattended"));
    var row2 = el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" });
    row2.appendChild(ui.wdJudge); row2.appendChild(el("span", { class: "dim" }, "ask the decision model, once an hour per active goal, whether it is moving"));
    ui.flag = el("div", { class: "fieldnote" });
    wd.appendChild(row1); wd.appendChild(row2); wd.appendChild(ui.flag);
    add(wd);

    var sv = field("Supervisor model");
    ui.provider = el("select", { id: "supprovider", style: "max-width:260px" });
    ui.model = el("input", { id: "supmodel", spellcheck: "false", style: "width:200px" });
    ui.keyNote = el("div", { class: "fieldnote" });
    var row3 = el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" });
    row3.appendChild(ui.provider); row3.appendChild(ui.model);
    sv.appendChild(row3); sv.appendChild(ui.keyNote);
    ui.provider.addEventListener("change", function () { var p = providerNamed(ui.provider.value); if (p && !ui.model.value) ui.model.value = p.defaultModel; renderKey(); });
    add(sv);

    var lim = field("Runs, by default");
    ui.agent = el("select", { id: "supagent" });
    ui.budget = number("supbudget"); ui.budget.placeholder = "none";
    ui.maxMinutes = number("supmaxmin"); ui.maxCalls = number("supmaxcalls");
    var row4 = el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" });
    row4.appendChild(el("span", { class: "dim" }, "agent")); row4.appendChild(ui.agent);
    row4.appendChild(el("span", { class: "dim" }, "budget")); row4.appendChild(ui.budget);
    row4.appendChild(el("span", { class: "dim" }, "at most")); row4.appendChild(ui.maxMinutes); row4.appendChild(el("span", { class: "dim" }, "min and")); row4.appendChild(ui.maxCalls); row4.appendChild(el("span", { class: "dim" }, "model calls"));
    ui.save = el("button", { class: "btn" }, "Save supervision settings");
    ui.saveNote = el("span", { class: "dim", style: "margin-left:8px" });
    ui.save.addEventListener("click", save);
    lim.appendChild(row4); var row5 = el("div", { style: "margin-top:8px" }); row5.appendChild(ui.save); row5.appendChild(ui.saveNote); lim.appendChild(row5);
    add(lim);

    var runs = field("Supervisor runs");
    ui.objective = el("textarea", { id: "supobjective", rows: "2", placeholder: "What done looks like, e.g. \\"A summary of this week's support tickets is in reports/weekly.md\\"", style: "width:100%" });
    ui.start = el("button", { class: "btn" }, "Start a supervised goal");
    ui.startNote = el("span", { class: "dim", style: "margin-left:8px" });
    ui.start.addEventListener("click", start);
    ui.runs = el("div", { id: "supruns", style: "margin-top:8px" });
    ui.detail = el("pre", { id: "suprundetail", style: "display:none;max-height:260px;overflow:auto;font-size:11px;white-space:pre-wrap" });
    runs.appendChild(ui.objective); var row6 = el("div", { style: "margin-top:6px" }); row6.appendChild(ui.start); row6.appendChild(ui.startNote); runs.appendChild(row6);
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
    ui.keyNote.textContent = !p ? "" : p.hasKey ? "Uses the " + p.label + " key set in Settings → Model." : "No " + p.label + " key yet: add it in Settings → Model, or a run will not start.";
  }

  function load() {
    call("GET", "/api/supervision").then(function (d) {
      data = d;
      var s = d.settings;
      ui.wdOn.checked = s.watchdog.enabled; ui.wdJudge.checked = s.watchdog.judge;
      ui.stall.value = s.watchdog.stallMinutes; ui.paused.value = s.watchdog.pausedMinutes;
      ui.flag.textContent = d.lastFlag ? "Last flag: " + d.lastFlag : "No flag raised yet.";
      ui.provider.textContent = "";
      d.providers.forEach(function (p) { var o = el("option", { value: p.name }, p.label + (p.hasKey ? "" : " (no key)")); if (p.name === s.supervisor.provider) o.selected = true; ui.provider.appendChild(o); });
      ui.model.value = s.supervisor.model;
      ui.agent.textContent = ""; ui.agent.appendChild(el("option", { value: "" }, "the coordinator"));
      d.agents.forEach(function (name) { var o = el("option", { value: name }, name); if (name === s.supervisor.agent) o.selected = true; ui.agent.appendChild(o); });
      ui.budget.value = s.supervisor.budget === undefined ? "" : s.supervisor.budget;
      ui.maxMinutes.value = s.supervisor.maxMinutes; ui.maxCalls.value = s.supervisor.maxModelCalls;
      renderKey();
      refreshRuns();
      if (!runsTimer) runsTimer = setInterval(function () { if (!document.getElementById("supruns") || document.getElementById("supruns").offsetParent === null) return; refreshRuns(); }, 5000);
    }).catch(function (e) { ui.flag.textContent = e.message; });
  }

  function save() {
    ui.saveNote.textContent = "Saving…";
    call("POST", "/api/supervision/settings", {
      watchdog: { enabled: ui.wdOn.checked, judge: ui.wdJudge.checked, stallMinutes: ui.stall.value, pausedMinutes: ui.paused.value },
      supervisor: { provider: ui.provider.value, model: ui.model.value, agent: ui.agent.value, budget: ui.budget.value, maxMinutes: ui.maxMinutes.value, maxModelCalls: ui.maxCalls.value },
    }).then(function (d) { ui.saveNote.textContent = d.note; }).catch(function (e) { ui.saveNote.textContent = e.message; });
  }

  function start() {
    var objective = ui.objective.value.trim();
    if (!objective) { ui.startNote.textContent = "Write what done looks like first."; return; }
    if (!confirm("This creates a task on your board for " + (ui.agent.value || "the coordinator") + ", and both the supervisor's model and the agent's model will spend. Start?")) return;
    ui.startNote.textContent = "Starting…";
    call("POST", "/api/supervision/runs", { objective: objective, agent: ui.agent.value, budget: ui.budget.value })
      .then(function () { ui.objective.value = ""; ui.startNote.textContent = "Queued; the supervisor picks it up within seconds."; refreshRuns(); })
      .catch(function (e) { ui.startNote.textContent = e.message; });
  }

  function refreshRuns() {
    call("GET", "/api/supervision/runs").then(function (d) {
      watching = {};
      ui.runs.textContent = "";
      if (d.runs.length === 0) { ui.runs.appendChild(el("div", { class: "dim" }, "No runs yet.")); return; }
      d.runs.slice(0, 20).forEach(function (run) {
        if (run.state === "running" && run.goalId) watching[run.goalId] = run.id;
        var row = el("div", { style: "display:flex;gap:8px;align-items:center;font-size:12px;padding:3px 0;border-bottom:1px solid var(--border)" });
        row.appendChild(el("span", { style: "width:64px" }, run.state));
        row.appendChild(el("span", { style: "width:40px" }, run.goalId || "—"));
        row.appendChild(el("span", { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: run.objective }, run.objective));
        row.appendChild(el("span", { class: "dim" }, (run.outcome || "") + (run.modelCalls !== undefined ? " · " + run.modelCalls + " calls" : "") + (run.tokens ? " · " + (run.tokens.input + run.tokens.output) + " tokens" : "") + (run.error ? " · " + run.error : "")));
        var view = el("a", { href: "#" }, "view");
        view.addEventListener("click", function (event) { event.preventDefault(); show(run.id); });
        row.appendChild(view);
        if (run.state === "running" || run.state === "queued") {
          var stop = el("a", { href: "#" }, "stop");
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
      var lines = [d.summary || ("Run " + id + ": " + d.run.state)];
      d.transcript.forEach(function (e) {
        if (e.kind === "model") lines.push("model #" + e.n + ": " + (e.calls.length ? e.calls.map(function (c) { return c.name; }).join(", ") : "") + (e.text ? " — " + e.text : ""));
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
      if (watching[id] && !badge) links[i].parentNode.appendChild(el("span", { class: "supbadge dim", style: "margin-left:6px;font-size:11px", title: "A supervisor is watching this goal" }, "supervised"));
      if (!watching[id] && badge) badge.parentNode.removeChild(badge);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  setInterval(function () { if (Object.keys(watching).length) markWatched(); }, 3000);
  setInterval(function () { if (document.getElementById("supruns") && document.getElementById("supruns").offsetParent === null) call("GET", "/api/supervision/runs").then(function (d) { watching = {}; d.runs.forEach(function (r) { if (r.state === "running" && r.goalId) watching[r.goalId] = r.id; }); markWatched(); }).catch(function () {}); }, 15000);
})();
`;
