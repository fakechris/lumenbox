/**
 * The supervisor's setup wizard (INV-1529): five steps from "what is this" to a first supervised
 * goal, inside Settings → Supervision. Each step says what it costs and who can do what; the place
 * is kept on the server (supervisor/onboarding.json, not config.json, so stepping through does not
 * restart supervision); a missing piece — no key, no agent, a model that cannot call tools — is a
 * thing to do on that step, not an error later. English and Chinese, by the page's locale.
 */

export const SUPERVISION_WIZARD_JS = `(function () {
  var T = {
    open: "{{ui.wizard.open}}", close: "{{ui.wizard.close}}", back: "{{ui.wizard.back}}", next: "{{ui.wizard.next}}", step: "{{ui.wizard.step}}", s1: "{{ui.wizard.s1}}",
    s1body: "{{ui.wizard.s1body}}", s2: "{{ui.wizard.s2}}", s2body: "{{ui.wizard.s2body}}", nokey: "{{ui.wizard.nokey}}", savekey: "{{ui.wizard.savekey}}", test: "{{ui.wizard.test}}",
    testing: "{{ui.wizard.testing}}", tested: "{{ui.wizard.tested}}", needtest: "{{ui.wizard.needtest}}", s3: "{{ui.wizard.s3}}", agent: "{{ui.wizard.agent}}",
    coordinator: "{{ui.wizard.coordinator}}", budget: "{{ui.wizard.budget}}", minutes: "{{ui.wizard.minutes}}", calls: "{{ui.wizard.calls}}", estimate: "{{ui.wizard.estimate}}",
    nobudget: "{{ui.wizard.nobudget}}", withbudget: "{{ui.wizard.withbudget}}", noagent: "{{ui.wizard.noagent}}", s4: "{{ui.wizard.s4}}", s4body: "{{ui.wizard.s4body}}",
    ex: ["{{ui.wizard.ex-1}}", "{{ui.wizard.ex-2}}", "{{ui.wizard.ex-3}}"], s5: "{{ui.wizard.s5}}", s5body: "{{ui.wizard.s5body}}", understand: "{{ui.wizard.understand}}",
    start: "{{ui.wizard.start}}", started: "{{ui.wizard.started}}", waiting: "{{ui.wizard.waiting}}", firstwake: "{{ui.wizard.firstwake}}",
  };
  function fmt(text, vars) { return String(text).replace(/\\{(\\w+)\\}/g, function (w, k) { return vars && k in vars ? String(vars[k]) : w; }); }
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var box, openLink, info, state = { step: 1, choices: {}, done: false }, tested = false, poll = null;

  function others(show) {
    var fields = document.querySelectorAll('.field[data-settab="supervision"]');
    for (var i = 0; i < fields.length; i++) if (fields[i].id !== "supwizard") fields[i].style.display = show ? "" : "none";
  }
  function save() { return call("POST", "/api/supervision/onboarding", state).catch(function () {}); }
  function go(step) { state.step = step; save(); render(); }

  function open() {
    call("GET", "/api/supervision").then(function (d) {
      info = d;
      var s = d.settings.supervisor, c = state.choices;
      if (!c.provider) c.provider = s.provider; if (!c.model) c.model = s.model;
      if (c.agent === undefined) c.agent = s.agent || ""; if (c.budget === undefined) c.budget = s.budget === undefined ? "" : s.budget;
      if (!c.maxMinutes) c.maxMinutes = s.maxMinutes; if (!c.maxCalls) c.maxCalls = s.maxModelCalls;
      // The open button hides while the wizard is up: above the panel it read as its title, and clicking it changed nothing (INV-1547).
      box.style.display = "block"; openLink.style.display = "none"; others(false); render();
    });
  }
  function close() { box.style.display = "none"; openLink.style.display = ""; others(true); if (poll) { clearInterval(poll); poll = null; } }

  function nav(back, next, nextOk) {
    var row = el("div", { class: "ui-actions" });
    if (back) { var b = el("button", { class: "btn" }, T.back); b.onclick = function () { go(state.step - 1); }; row.appendChild(b); }
    if (next) { var n = el("button", { class: "btn" }, T.next); n.disabled = nextOk === false; n.onclick = function () { go(state.step + 1); }; row.appendChild(n); }
    var x = el("a", { href: "#", class: "ui-link ui-push" }, T.close); x.onclick = function (e) { e.preventDefault(); close(); }; row.appendChild(x);
    return row;
  }
  function provider(name) { for (var i = 0; i < info.providers.length; i++) if (info.providers[i].name === name) return info.providers[i]; return null; }

  function render() {
    var c = state.choices;
    box.textContent = "";
    box.appendChild(el("div", { class: "ui-step" }, fmt(T.step, { n: state.step })));
    var titles = [T.s1, T.s2, T.s3, T.s4, T.s5];
    box.appendChild(el("h4", { class: "ui-title" }, titles[state.step - 1] || ""));
    if (state.step === 1) {
      box.appendChild(el("p", {}, T.s1body));
      box.appendChild(nav(false, true));
    } else if (state.step === 2) {
      box.appendChild(el("p", { class: "dim" }, T.s2body));
      var sel = el("select", { id: "wizprovider" });
      info.providers.forEach(function (p) { var o = el("option", { value: p.name }, p.label + (p.hasKey ? "" : " —")); if (p.name === c.provider) o.selected = true; sel.appendChild(o); });
      var model = el("input", { id: "wizmodel", spellcheck: "false", class: "ui-w-md" }); model.value = c.model;
      sel.onchange = function () { c.provider = sel.value; var p = provider(sel.value); if (p) { c.model = sel.value === "openai" ? "gpt-6.1-sol" : p.defaultModel; } tested = false; save(); render(); };
      model.onchange = function () { c.model = model.value.trim(); tested = false; save(); render(); };
      var row = el("div", { class: "ui-row" }); row.appendChild(sel); row.appendChild(model); box.appendChild(row);
      var p = provider(c.provider);
      if (p && !p.hasKey) {
        box.appendChild(el("p", { class: "dim" }, T.nokey));
        var key = el("input", { id: "wizkey", type: "password", autocomplete: "off", class: "ui-w-lg" });
        var save1 = el("button", { class: "btn" }, T.savekey);
        var note1 = el("span", { class: "dim" });
        save1.onclick = function () { call("POST", "/api/supervision/key", { provider: c.provider, key: key.value }).then(function () { key.value = ""; p.hasKey = true; render(); }).catch(function (e) { note1.textContent = e.message; }); };
        var row2 = el("div", { class: "ui-row" }); row2.appendChild(key); row2.appendChild(save1); row2.appendChild(note1); box.appendChild(row2);
      }
      var test = el("button", { class: "btn ui-gap" }, T.test);
      var note = el("div", { class: "fieldnote", id: "wiztestnote" }, tested ? fmt(T.tested, { ms: c.testedMs }) : T.needtest);
      test.onclick = function () { note.textContent = T.testing; call("POST", "/api/supervision/test", { provider: c.provider, model: c.model }).then(function (r) { tested = r.ok; c.testedMs = r.ms; note.textContent = r.ok ? fmt(T.tested, { ms: r.ms }) : r.error; render(); }).catch(function (e) { note.textContent = e.message; }); };
      box.appendChild(test); box.appendChild(note);
      box.appendChild(nav(true, true, tested));
    } else if (state.step === 3) {
      if (info.agents.length === 0) { box.appendChild(el("p", {}, T.noagent)); box.appendChild(nav(true, false)); return; }
      function line(label, input) { var r = el("div", { class: "ui-row ui-gap" }); r.appendChild(el("span", { class: "ui-w-lg" }, label)); r.appendChild(input); box.appendChild(r); return input; }
      var agent = el("select", { id: "wizagent" }); agent.appendChild(el("option", { value: "" }, T.coordinator));
      info.agents.forEach(function (name) { var o = el("option", { value: name }, name); if (name === c.agent) o.selected = true; agent.appendChild(o); });
      line(T.agent, agent).onchange = function () { c.agent = agent.value; save(); render(); };
      var budget = el("input", { id: "wizbudget", type: "number", min: "1", class: "ui-w-sm" }); budget.value = c.budget;
      line(T.budget, budget).onchange = function () { c.budget = budget.value; save(); render(); };
      var minutes = el("input", { type: "number", min: "1", class: "ui-w-sm" }); minutes.value = c.maxMinutes;
      line(T.minutes, minutes).onchange = function () { c.maxMinutes = Number(minutes.value); save(); render(); };
      var calls = el("input", { type: "number", min: "1", class: "ui-w-sm" }); calls.value = c.maxCalls;
      line(T.calls, calls).onchange = function () { c.maxCalls = Number(calls.value); save(); render(); };
      box.appendChild(el("p", { class: "fieldnote", id: "wizestimate" }, fmt(T.estimate, { calls: c.maxCalls, tokens: (Number(c.maxCalls) * 1200).toLocaleString(), model: c.model, budget: c.budget ? fmt(T.withbudget, { budget: Number(c.budget).toLocaleString() }) : T.nobudget })));
      box.appendChild(nav(true, true));
    } else if (state.step === 4) {
      box.appendChild(el("p", { class: "dim" }, T.s4body));
      var area = el("textarea", { id: "wizobjective", rows: "3", class: "ui-w-full" }); area.value = c.objective || "";
      T.ex.forEach(function (text) { var a = el("a", { href: "#", class: "ui-link block" }, "→ " + text); a.onclick = function (e) { e.preventDefault(); c.objective = text; save(); render(); }; box.appendChild(a); });
      area.oninput = function () { c.objective = area.value; };
      area.onchange = function () { save(); render(); };
      box.appendChild(area);
      box.appendChild(nav(true, true, !!(c.objective && c.objective.trim())));
    } else if (state.step === 5) {
      var who = c.agent || T.coordinator;
      box.appendChild(el("p", {}, fmt(T.s5body, { agent: who })));
      var summary = el("pre", { class: "ui-log" }, [c.provider + "/" + c.model, who, c.budget ? fmt(T.withbudget, { budget: c.budget }) : T.nobudget, fmt("{{ui.wizard.min-calls}}", { min: c.maxMinutes, calls: c.maxCalls }), "", c.objective].join("\\n"));
      box.appendChild(summary);
      var agree = el("input", { type: "checkbox", id: "wizagree" });
      var start = el("button", { class: "btn", id: "wizstart" }, T.start); start.disabled = true;
      agree.onchange = function () { start.disabled = !agree.checked; };
      var row3 = el("label", { class: "ui-row ui-gap" }); row3.appendChild(agree); row3.appendChild(el("span", {}, T.understand)); box.appendChild(row3);
      var live = el("pre", { id: "wizlive", class: "ui-log" });
      start.onclick = function () {
        start.disabled = true;
        call("POST", "/api/supervision/settings", { supervisor: { provider: c.provider, model: c.model, agent: c.agent, budget: c.budget, maxMinutes: c.maxMinutes, maxModelCalls: c.maxCalls } })
          .then(function () { return call("POST", "/api/supervision/runs", { objective: c.objective, agent: c.agent, budget: c.budget }); })
          .then(function (d) { state.done = true; save(); live.textContent = T.started + "\\n" + T.waiting; watch(d.run.id, live); })
          .catch(function (e) { live.textContent = e.message; start.disabled = false; });
      };
      box.appendChild(start); box.appendChild(live);
      box.appendChild(nav(true, false));
    }
  }

  function watch(id, live) {
    if (poll) clearInterval(poll);
    poll = setInterval(function () {
      call("GET", "/api/supervision/runs/" + id).then(function (d) {
        var lines = [T.started, d.run.state + (d.run.goalId ? " · " + d.run.goalId : "") + (d.run.error ? " · " + d.run.error : "")];
        var woke = false;
        d.transcript.forEach(function (e) {
          if (e.kind === "model") { woke = true; lines.push(fmt("{{ui.wizard.model-n}}", { n: e.n }) + ": " + e.calls.map(function (x) { return x.name; }).join(", ") + (e.text ? " — " + e.text : "")); }
          else if (e.kind === "tool") lines.push("  " + e.name + ": " + String(e.reply || e.refused || "").split("\\n")[0]);
        });
        if (woke) lines.splice(1, 0, T.firstwake);
        live.textContent = lines.join("\\n");
        if (d.run.state === "done" || d.run.state === "failed" || d.run.state === "stopped") { clearInterval(poll); poll = null; }
      }).catch(function () {});
    }, 3000);
  }

  function mount() {
    var anchor = document.getElementById("supwatchdog");
    if (!anchor || document.getElementById("supwizard")) return false;
    var intro = anchor.closest(".field").previousSibling;
    var holder = el("div", { class: "field settab-off", "data-settab": "supervision", id: "supwizard" });
    openLink = el("button", { class: "btn", id: "supwizopen" }, T.open);
    box = el("div", { id: "supwizbox", class: "ui-panel", style: "display:none" });
    openLink.onclick = function () { open(); };
    holder.appendChild(openLink); holder.appendChild(box);
    anchor.closest(".field").parentNode.insertBefore(holder, intro ? intro.nextSibling : anchor.closest(".field"));
    document.getElementById("settabs").addEventListener("click", function (event) {
      var a = event.target.closest("a[data-settab]");
      if (!a || a.getAttribute("data-settab") !== "supervision") return;
      Promise.all([call("GET", "/api/supervision/onboarding"), call("GET", "/api/supervision/runs")]).then(function (r) {
        state = r[0]; if (!state.choices) state.choices = {};
        if (!state.done && r[1].runs.length === 0) open();
      }).catch(function () {});
    });
    return true;
  }
  var tries = 0, timer = setInterval(function () { if (mount() || ++tries > 40) clearInterval(timer); }, 250);
})();
`;
