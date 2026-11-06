/**
 * The agent configuration's versions on the page (INV-1669), in its own script like the other
 * sections — the page is at its size ceiling:
 *
 * - **Configure → History**: a tab beside the settings. Every version newest first, with when, who
 *   and what it changed; two ticked versions compare; "Go back to this version" makes a new version
 *   with that one's settings. The boundary is said where the change is made: a change applies from
 *   the agent's next turn, and a turn already running keeps the version it started with.
 * - **The conversation header**: "config v3" beside Configure — the version this conversation last
 *   ran under — and, on a click, each version it ran under and from when.
 * - **The task detail**: the version in effect and, when the task spans more than one, each switch.
 *   A version opens the agent's History at that version.
 */

export const CONFIG_HISTORY_JS = `(function () {
  var style = document.createElement("style");
  style.textContent = [
    "#agentwrap .modal.cvhist > .field { display: none !important; }",
    ".cvtabs { display: flex; gap: 4px; margin: -4px 0 12px; border-bottom: 1px solid var(--border); }",
    ".cvtabs button { font: inherit; font-size: 12.5px; padding: 5px 10px; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); cursor: pointer; margin-bottom: -1px; }",
    ".cvtabs button.sel { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }",
    ".cvnote { font-size: 12px; color: var(--muted); margin: 0 0 10px; }",
    ".cvrow { padding: 7px 0; border-top: 1px solid var(--border); font-size: 12.5px; }",
    ".cvrow:first-child { border-top: 0; }",
    ".cvrow.open { background: var(--accent-soft); margin: 0 -8px; padding: 7px 8px; border-radius: var(--radius-md); }",
    ".cvhead { display: flex; gap: 8px; align-items: center; }",
    ".cvhead b { font-weight: 600; }",
    ".cvchanges { margin: 3px 0 0 22px; font-size: 11.5px; color: var(--muted); }",
    ".cvchanges div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".cvchanges .mono { color: var(--text); }",
    ".cvconfig { margin: 4px 0 0 22px; font-size: 11.5px; }",
    ".cvchip { font-size: 11px; padding: 1px 7px; border: 1px solid var(--border); border-radius: var(--radius-pill); color: var(--muted); text-decoration: none; flex: none; white-space: nowrap; }",
    ".cvpop { position: absolute; z-index: 30; margin-top: 4px; min-width: 260px; max-width: 360px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-md); box-shadow: var(--shadow, 0 4px 16px rgba(0,0,0,.12)); font-size: 12px; }"
  ].join("\\n");
  document.head.appendChild(style);

  var BOUNDARY = "A change applies from the agent's next turn. A turn already running keeps the version it started with; to stop it now, use Stop.";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function when(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return iso; } }
  function changesHtml(changes) {
    if (!changes || !changes.length) return "";
    return '<div class="cvchanges">' + changes.map(function (c) {
      return "<div>" + esc(c.field) + ": " + esc(c.before) + " → <span class=\\"mono\\">" + esc(c.after) + "</span></div>";
    }).join("") + "</div>";
  }
  function configHtml(config) {
    var perms = config.toolPermissions || {};
    var asks = Object.keys(perms.tools || {}).filter(function (t) { return perms.tools[t] === "ask"; });
    var groups = Object.keys(perms.groups || {}).map(function (g) { return g + " " + (perms.groups[g] === "ask" ? "{{ui.config-history.ask-me}}" : "allowed"); });
    var standing = Object.keys(config.standing || {}).map(function (n) { return n + ".md " + String(config.standing[n]).slice(0, 8); });
    var rows = [
      ["Tools", config.tools ? config.tools.join(", ") : "all"],
      ["Ask me", asks.length ? asks.join(", ") : "—"],
      ["Groups", groups.length ? groups.join(", ") : "defaults"],
      ["Runtime", (config.provider || "installation default") + (config.model ? " · " + config.model : "")],
      ["Scope", config.scopeId || "none"],
      ["Persona", config.description ? config.description.slice(0, 160) + (config.description.length > 160 ? "…" : "") : "empty"],
      ["Standing files", standing.length ? standing.join(", ") : "not read yet"]
    ];
    return '<div class="cvconfig">' + rows.map(function (r) { return '<div><span class="dim">' + esc(r[0]) + ":</span> " + esc(r[1]) + "</div>"; }).join("") + "</div>";
  }

  // ── Configure → History ──────────────────────────────────────────────────
  var state = { agent: null, data: null, open: null, picked: [], diff: null };
  function modal() { var w = document.getElementById("agentwrap"); return w ? w.querySelector(".modal") : null; }
  function ensureTabs() {
    var m = modal();
    if (!m || document.getElementById("cvtabs")) return;
    var tabs = document.createElement("div");
    tabs.id = "cvtabs"; tabs.className = "cvtabs";
    tabs.innerHTML = '<button type="button" data-cvtab="settings" class="sel">{{ui.config-history.settings}}</button><button type="button" data-cvtab="history">{{ui.config-history.history}}</button>';
    var panel = document.createElement("div");
    panel.id = "aghistory"; panel.style.display = "none";
    var title = document.getElementById("agenttitle");
    title.parentNode.insertBefore(tabs, title.nextSibling);
    tabs.parentNode.insertBefore(panel, tabs.nextSibling);
    tabs.onclick = function (event) {
      var button = event.target.closest("[data-cvtab]");
      if (button) show(button.getAttribute("data-cvtab"));
    };
    panel.onclick = onPanelClick;
  }
  function show(tab) {
    var m = modal();
    var history = tab === "history";
    var buttons = document.querySelectorAll("#cvtabs [data-cvtab]");
    for (var i = 0; i < buttons.length; i++) buttons[i].className = buttons[i].getAttribute("data-cvtab") === tab ? "sel" : "";
    // A class, not each field's display: the dialog sets those itself as it opens, and History must not undo them.
    m.classList.toggle("cvhist", history);
    document.getElementById("aghistory").style.display = history ? "" : "none";
    var save = document.getElementById("agsave");
    if (save) save.style.display = history ? "none" : "";
    if (history) load();
  }
  function load() {
    var panel = document.getElementById("aghistory");
    if (!state.agent) return;
    panel.innerHTML = '<div class="cvnote">{{ui.config-history.loading}}</div>';
    fetch("/api/agents/config-versions?agent=" + encodeURIComponent(state.agent))
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error || r.statusText); }); })
      .then(function (d) { state.data = d; render(); })
      .catch(function (error) { panel.innerHTML = '<div class="cvnote">' + esc(error.message || error) + "</div>"; });
  }
  function render() {
    var panel = document.getElementById("aghistory");
    var d = state.data, diff = state.diff;
    var versions = (d && d.versions) || [];
    var html = '<div class="cvnote">' + esc(BOUNDARY) + "</div>";
    if (!versions.length) {
      panel.innerHTML = html + '<div class="cvnote">{{ui.config-history.no-versions-yet-the-first}}</div>';
      return;
    }
    html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><button type="button" class="btn sm" data-cvcompare' + (state.picked.length === 2 ? "" : " disabled") + '>{{ui.config-history.compare-ticked}}</button><span class="dim" style="font-size:11px">{{ui.config-history.tick-two-versions-to-see}}</span></div>';
    if (diff) html += '<div class="cvnote" data-cvdiff style="color:var(--text)"><b>v' + diff.from + " → v" + diff.to + "</b>" + (diff.changes.length ? changesHtml(diff.changes) : " {{ui.config-history.the-same-settings}}") + "</div>";
    html += versions.slice().reverse().map(function (v) {
      var current = v.n === d.current;
      var open = state.open === v.n;
      return '<div class="cvrow' + (open ? " open" : "") + '" data-cvversion="' + v.n + '">' +
        '<div class="cvhead"><input type="checkbox" data-cvpick="' + v.n + '"' + (state.picked.indexOf(v.n) >= 0 ? " checked" : "") + ">" +
          "<b>v" + v.n + "</b>" + (current ? ' <span class="cvchip">{{ui.config-history.in-effect}}</span>' : "") +
          '<span class="dim" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(when(v.at)) + " · " + esc(v.by) + (v.restoredFrom ? " {{ui.config-history.back-to-v}}" + v.restoredFrom : "") + "</span>" +
          '<a href="#" data-cvview="' + v.n + '" style="font-size:11.5px">' + (open ? "{{ui.config-history.hide}}" : "{{ui.config-history.view}}") + "</a>" +
          (current ? "" : '<button type="button" class="btn sm ghost" data-cvrestore="' + v.n + '">{{ui.config-history.go-back-to-this-version}}</button>') +
        "</div>" +
        (v.n === 1 && !v.changes.length ? "" : changesHtml(v.changes)) +
        (open ? configHtml(v.config) : "") +
      "</div>";
    }).join("");
    panel.innerHTML = html;
  }
  function onPanelClick(event) {
    var pick = event.target.closest("[data-cvpick]");
    if (pick) {
      var n = Number(pick.getAttribute("data-cvpick"));
      state.picked = state.picked.filter(function (x) { return x !== n; });
      if (pick.checked) state.picked.push(n);
      if (state.picked.length > 2) state.picked.shift();
      state.diff = null;
      render();
      return;
    }
    var view = event.target.closest("[data-cvview]");
    if (view) { event.preventDefault(); var v = Number(view.getAttribute("data-cvview")); state.open = state.open === v ? null : v; render(); return; }
    if (event.target.closest("[data-cvcompare]") && state.picked.length === 2) {
      var pair = state.picked.slice().sort(function (a, b) { return a - b; });
      fetch("/api/agents/config-versions/diff?agent=" + encodeURIComponent(state.agent) + "&from=" + pair[0] + "&to=" + pair[1])
        .then(function (r) { return r.json(); })
        .then(function (d) { state.diff = d; render(); });
      return;
    }
    var restore = event.target.closest("[data-cvrestore]");
    if (restore) {
      var target = Number(restore.getAttribute("data-cvrestore"));
      restore.disabled = true;
      fetch("/api/agents/config-versions/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: state.agent, version: target }) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || r.statusText); return d; }); })
        .then(function (d) {
          var agentId = state.agent;
          // The settings tab shows the restored values: the roster is reloaded, then the dialog reopened on History.
          var again = function () { if (typeof agentById === "function" && typeof openAgentModal === "function") { var a = agentById(agentId); if (a) { openAgentModal("edit", a); state.open = d.version; show("history"); } } };
          if (typeof refresh === "function") Promise.resolve(refresh()).then(again); else again();
          if (window.configVersionChip && typeof current !== "undefined" && current === agentId) window.configVersionChip(agentId, currentConversation);
        })
        .catch(function (error) { restore.disabled = false; var status = document.getElementById("agstatus"); if (status) status.textContent = String(error.message || error); });
    }
  }

  window.configHistory = {
    /** Called as the Configure dialog opens: the tabs for an existing agent, none for a new one. */
    mount: function (agent) {
      ensureTabs();
      state = { agent: agent ? agent.id : null, data: null, open: null, picked: [], diff: null };
      var tabs = document.getElementById("cvtabs");
      if (tabs) tabs.style.display = agent ? "" : "none";
      show("settings");
    },
    /** Opens an agent's Configure dialog on History, with one version shown. */
    open: function (agentId, n) {
      if (typeof agentById !== "function" || typeof openAgentModal !== "function") return;
      var agent = agentById(agentId);
      if (!agent) return;
      openAgentModal("edit", agent);
      state.open = n;
      show("history");
    }
  };

  // ── the conversation header ──────────────────────────────────────────────
  function switchesHtml(switches) {
    return switches.map(function (s, i) {
      return '<div style="padding:2px 0"><a href="#" data-cvopen="' + esc(s.agentId) + '" data-cvn="' + s.n + '"><b>v' + s.n + "</b></a>" +
        (s.agentName && s.multi ? " " + esc(s.agentName) : "") +
        ' <span class="dim">' + (i === 0 ? "{{ui.config-history.from}} " : "{{ui.config-history.switched}} ") + esc(when(s.from)) + " · " + esc(s.by) + "</span></div>";
    }).join("");
  }
  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("[data-cvopen]");
    if (link) { event.preventDefault(); var pop = document.getElementById("cvpop"); if (pop) pop.remove(); window.configHistory.open(link.getAttribute("data-cvopen"), Number(link.getAttribute("data-cvn"))); return; }
    var pop2 = document.getElementById("cvpop");
    if (pop2 && !pop2.contains(event.target) && event.target.id !== "cvchip") pop2.remove();
  });
  window.configVersionChip = function (agentId, conversation) {
    var anchor = document.getElementById("agentcfg");
    if (!anchor) return;
    var chip = document.getElementById("cvchip");
    if (!chip) {
      chip = document.createElement("a");
      chip.id = "cvchip"; chip.href = "#"; chip.className = "cvchip";
      anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    }
    chip.style.display = "none";
    fetch("/api/agents/config-versions?agent=" + encodeURIComponent(agentId) + "&conversation=" + encodeURIComponent(conversation || "main"))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.current || typeof current === "undefined" || current !== agentId) return;
        var switches = d.switches || [];
        var last = switches[switches.length - 1];
        var shown = last ? last.n : d.current;
        chip.textContent = "{{ui.config-history.config-v}}" + shown + (last && last.n !== d.current ? " · v" + d.current + " {{ui.config-history.next-turn}}" : "");
        chip.title = last ? "{{ui.config-history.this-conversation-runs-on-configuration}} " + last.n + " {{ui.config-history.since}} " + when(last.from) + (last.n !== d.current ? "{{ui.config-history.version}} " + d.current + " {{ui.config-history.was-saved-since-and-applies}}" : "") : "{{ui.config-history.configuration-version}} " + d.current + "{{ui.config-history.this-conversation-has-not-run}}";
        chip.style.display = "";
        chip.onclick = function (event) {
          event.preventDefault();
          var old = document.getElementById("cvpop");
          if (old) { old.remove(); return; }
          var pop = document.createElement("div");
          pop.id = "cvpop"; pop.className = "cvpop";
          pop.innerHTML = '<div style="font-weight:600;margin-bottom:4px">{{ui.config-history.configuration-in-this-conversation}}</div>' +
            (switches.length ? switchesHtml(switches) : '<div class="dim">{{ui.config-history.no-turn-here-has-run}}</div>') +
            '<div class="dim" style="margin-top:6px;font-size:11px">' + esc(BOUNDARY) + "</div>" +
            '<div style="margin-top:6px"><a href="#" data-cvopen="' + esc(agentId) + '" data-cvn="' + d.current + '">{{ui.config-history.all-versions}}</a></div>';
          chip.parentNode.appendChild(pop);
        };
      })
      .catch(function () {});
  };

  // ── the task detail ──────────────────────────────────────────────────────
  window.configVersionsHtml = function (task) {
    var switches = (task && task.configVersions) || [];
    if (!switches.length) return "";
    var agents = {};
    switches.forEach(function (s) { agents[s.agentId] = true; });
    var multi = Object.keys(agents).length > 1;
    var last = switches[switches.length - 1];
    var rows = switches.map(function (s) { return { agentId: s.agentId, agentName: s.agentName, n: s.n, from: s.from, by: s.by, multi: multi }; });
    return '<div data-config-versions style="margin:0 0 8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md);font-size:12px">' +
      '<div style="font-weight:600;margin-bottom:2px">{{ui.config-history.configuration}} <a href="#" data-cvopen="' + esc(last.agentId) + '" data-cvn="' + last.n + '" style="font-weight:400">' + esc((multi ? last.agentName + " " : "") + "v" + last.n) + "</a>" +
        ' <span class="dim" style="font-weight:400">(' + esc(when(last.savedAt)) + ")</span></div>" +
      (switches.length > 1 ? '<div class="dim" style="font-size:11px;margin-bottom:2px">{{ui.config-history.this-task-ran-under}} ' + switches.length + " {{ui.config-history.versions-each-from-the-first}}</div>" + switchesHtml(rows) : "") +
    "</div>";
  };
})();
`;
