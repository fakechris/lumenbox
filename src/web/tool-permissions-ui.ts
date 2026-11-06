/**
 * The Configure dialog's three-state tool chips and the chat's gate marks (INV-1664). Its own
 * script, like the other sections: the page is at its size ceiling.
 *
 * A chip cycles allowed → ask me → off. "Off" is the page's own tool list (agentModal.tools);
 * "ask me" is kept here and sent with the save as `toolPermissions`. A row above the chips sets
 * a whole group at once — allow and ask become the group's default, which a single chip then
 * overrides; off turns the group's chips off. A tool the organisation already asks about (an
 * operator rule, the approval list, the side-effect gate, a host command) is greyed at "ask me"
 * with its source, because nothing here can set it lower; a tool a rule refuses says so.
 *
 * In the chat, each tool step carries a small mark — allowed, asked, waiting, refused — and a
 * click on it shows why: which rule, whose setting, which floor.
 */

export const TOOL_PERMS_JS = `(function () {
  var style = document.createElement("style");
  style.textContent = [
    ".toolchip.on.ask { background: var(--surface); color: var(--warn); border: 1px solid var(--warn); }",
    ".toolchip.ask::after { content: ' · ask me'; font-size: 10px; }",
    ".toolchip.floor { border-style: dashed; }",
    ".toolchip.denied { text-decoration: line-through; }",
    ".tpgroups { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0 0 8px; font-size: 11.5px; }",
    ".tpgroup { display: inline-flex; align-items: center; gap: 4px; }",
    ".tpgroup b { font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-size: 10.5px; }",
    ".tpgroup button { font: inherit; font-size: 11px; padding: 1px 7px; border-radius: var(--radius-pill); border: 1px solid var(--border); background: none; color: var(--muted); cursor: pointer; }",
    ".tpgroup button.sel { background: var(--accent-soft); color: var(--accent); border-color: transparent; }",
    ".gatemark { display: inline-block; font-size: 10px; line-height: 1.5; padding: 0 6px; margin-left: 6px; border-radius: var(--radius-pill); border: 1px solid var(--border); color: var(--muted); cursor: help; vertical-align: 1px; }",
    ".gatemark.g-allowed { color: var(--success); border-color: var(--success-soft); }",
    ".gatemark.g-asked { color: var(--accent); border-color: var(--accent); }",
    ".gatemark.g-waiting { color: var(--warn); border-color: var(--warn); }",
    ".gatemark.g-refused { color: var(--danger); border-color: var(--danger); }",
    ".gatebasis { font-size: 11px; color: var(--muted); padding: 2px 0 4px 18px; }"
  ].join("\\n");
  document.head.appendChild(style);

  var LABEL = { allowed: "{{ui.tool-permissions.allowed}}", asked: "{{ui.tool-permissions.asked-you}}", waiting: "{{ui.tool-permissions.waiting-for-you}}", refused: "{{ui.tool-permissions.refused}}" };
  var GROUP = { desk: "{{ui.tool-permissions.desk}}", web: "{{ui.tool-permissions.web}}", code: "{{ui.tool-permissions.code}}", team: "{{ui.tool-permissions.team}}", other: "{{ui.tool-permissions.other}}" };
  var state = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function groupOf(tool) { for (var g in state.groups) if (state.groups[g].indexOf(tool) >= 0) return g; return "other"; }
  /** The effective ask setting for a tool: its own, else its group's, else allow. */
  function asks(tool) {
    if (state.never.indexOf(tool) >= 0) return false;
    if (state.tools[tool]) return state.tools[tool] === "ask";
    return state.groupDefault[groupOf(tool)] === "ask";
  }
  function stateOf(tool) {
    var modal = window.agentModal;
    if (!modal || !modal.tools[tool]) return "off";
    var floor = state.floors[tool];
    return asks(tool) || (floor && floor.effect === "ask") ? "ask" : "allow";
  }
  function paintChip(chip) {
    var tool = chip.getAttribute("data-tool"), now = stateOf(tool), floor = state.floors[tool];
    var cls = "toolchip" + (now !== "off" ? " on" : "") + (now === "ask" ? " ask" : "") + (floor ? " floor" : "") + (floor && floor.effect === "deny" ? " denied" : "");
    if (chip.className !== cls) chip.className = cls;
    var title = floor ? (floor.effect === "deny" ? "{{ui.tool-permissions.refused-whatever-is-set-here}} " : "{{ui.tool-permissions.always-asks-whatever-is-set}} ") + floor.source
      : state.never.indexOf(tool) >= 0 ? "{{ui.tool-permissions.talks-to-you-or-runs}}"
      : now === "ask" ? "{{ui.tool-permissions.asks-you-before-every-call}}" + (state.tools[tool] ? "" : " {{ui.tool-permissions.the}} " + GROUP[groupOf(tool)] + " {{ui.tool-permissions.default}}") : now === "allow" ? "{{ui.tool-permissions.runs-without-asking-the-gates}}" : "{{ui.tool-permissions.off-not-offered-to-the}}";
    if (chip.title !== title) chip.title = title;
  }
  function paint() {
    if (!state) return;
    var chips = document.querySelectorAll("#agtools .toolchip");
    for (var i = 0; i < chips.length; i++) paintChip(chips[i]);
    var row = document.getElementById("tpgroups");
    if (!row) return;
    var buttons = row.querySelectorAll("button[data-g]");
    for (var j = 0; j < buttons.length; j++) {
      var g = buttons[j].getAttribute("data-g"), v = buttons[j].getAttribute("data-v");
      var tools = (state.groups[g] || []).filter(function (t) { return window.allTools.indexOf(t) >= 0; });
      var on = tools.filter(function (t) { return window.agentModal.tools[t]; });
      var sel = v === "off" ? on.length === 0 : on.length > 0 && (v === "ask" ? state.groupDefault[g] === "ask" : state.groupDefault[g] !== "ask");
      buttons[j].className = sel ? "sel" : "";
    }
  }
  function groupRow() {
    var old = document.getElementById("tpgroups"); if (old) old.remove();
    var row = document.createElement("div"); row.id = "tpgroups"; row.className = "tpgroups";
    row.innerHTML = Object.keys(GROUP).filter(function (g) { return (state.groups[g] || []).length > 0; }).map(function (g) {
      return '<span class="tpgroup"><b>' + GROUP[g] + "</b>" + ["allow", "ask", "off"].map(function (v) {
        return '<button type="button" data-g="' + g + '" data-v="' + v + '">' + ({ allow: "{{ui.tool-permissions.allow}}", ask: "{{ui.tool-permissions.ask-me}}", off: "{{ui.tool-permissions.off}}" }[v]) + "</button>";
      }).join("") + "</span>";
    }).join("");
    row.addEventListener("click", function (event) {
      var b = event.target.closest && event.target.closest("button[data-g]"); if (!b) return;
      if (document.getElementById("agscope").value !== "") return;
      var g = b.getAttribute("data-g"), v = b.getAttribute("data-v");
      (state.groups[g] || []).forEach(function (t) {
        if (window.allTools.indexOf(t) < 0) return;
        window.agentModal.tools[t] = v !== "off";
        if (v !== "off") delete state.tools[t];
      });
      if (v !== "off") state.groupDefault[g] = v;
      paint();
    });
    var chips = document.getElementById("agtools");
    chips.parentNode.insertBefore(row, chips);
  }
  window.toolPerms = {
    /** Called when the dialog opens: loads the agent's setting, the groups and the floors. */
    mount: function (agent) {
      state = null;
      var old = document.getElementById("tpgroups"); if (old) old.remove();
      fetch("/api/agents/tool-permissions?agent=" + encodeURIComponent(agent ? agent.id : ""))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          var p = d.permissions || {};
          state = { groups: d.groups || {}, floors: d.floors || {}, never: d.neverAsked || [], tools: Object.assign({}, p.tools || {}), groupDefault: Object.assign({}, p.groups || {}) };
          groupRow(); paint();
        })
        .catch(function () {});
    },
    /** A chip was clicked: allowed → ask me → off → allowed. True when handled. */
    cycle: function (chip, tool) {
      if (!state) return false;
      var modal = window.agentModal, now = stateOf(tool), floor = state.floors[tool], never = state.never.indexOf(tool) >= 0;
      var next = now === "allow" ? (never || (floor && floor.effect === "ask") ? "off" : "ask") : now === "ask" ? "off" : (floor && floor.effect === "ask" ? "ask" : "allow");
      modal.tools[tool] = next !== "off";
      if (next !== "off" && !never) {
        var byGroup = state.groupDefault[groupOf(tool)] === "ask" ? "ask" : "allow";
        if (next === byGroup) delete state.tools[tool]; else state.tools[tool] = next;
        // Re-enabled under an ask floor: its own setting is "ask", so it does not quietly become allow if the floor lifts.
        if (floor && floor.effect === "ask") state.tools[tool] = "ask";
      }
      paint();
      return true;
    },
    /** What the save sends: undefined until loaded (the server keeps what it had), null for nothing set. */
    value: function () {
      if (!state) return undefined;
      var tools = {}, groups = {}, any = false;
      for (var t in state.tools) if (window.allTools.indexOf(t) < 0 || window.agentModal.tools[t]) { tools[t] = state.tools[t]; any = true; }
      for (var g in state.groupDefault) if (state.groupDefault[g] === "ask") { groups[g] = "ask"; any = true; }
      return any ? { groups: groups, tools: tools } : null;
    }
  };
  // The page resets chip classes when a scope or a catalog row fills them; repaint after it.
  var chipsHost = document.getElementById("agtools");
  if (chipsHost) new MutationObserver(function () { paint(); }).observe(chipsHost, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });

  /** The chat's mark for one step's gate verdict. */
  window.gateMark = function (gate) {
    if (!gate || !gate.verdict) return "";
    return '<span class="gatemark g-' + esc(gate.verdict) + '" data-basis="' + esc(gate.basis || "") + '" title="' + esc(gate.basis || "") + '">' + esc(LABEL[gate.verdict] || gate.verdict) + "</span>";
  };
  // A click on a mark opens the step with the gate's reason at its top; a second click takes the reason away.
  document.addEventListener("click", function (event) {
    var mark = event.target.closest && event.target.closest(".gatemark");
    if (!mark) return;
    event.preventDefault(); event.stopPropagation();
    var row = mark.closest("details"), shown = row && row.querySelector(":scope > .gatebasis");
    if (shown) { shown.remove(); return; }
    var note = document.createElement("div"); note.className = "gatebasis"; note.textContent = "{{ui.tool-permissions.gate}} " + mark.getAttribute("data-basis");
    var summary = row && row.querySelector(":scope > summary");
    if (summary) { summary.insertAdjacentElement("afterend", note); row.open = true; }
  }, true);
})();
`;
