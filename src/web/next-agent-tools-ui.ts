/**
 * What an agent may use, and what it must ask before using, on the rebuilt agent page (INV-1825).
 *
 * Each tool is allowed, asked about, or off. A group's own setting is what its tools take when
 * nothing is said of them; a floor the organisation set cannot be gone below, and is shown as the
 * choice that is missing. Saved with the agent: off is a tool left out of its list, the rest is its
 * permissions.
 */
export const NEXT_AGENT_TOOLS_JS = `
var TOOL_GROUP_ORDER = ["desk", "web", "code", "team", "other"];

/** Where one tool stands for this agent, and what may be chosen for it. */
function toolStateOf(name, group, agentTools, perms, floors, neverAsked) {
  var floor = floors[name] ? floors[name].effect : "", inherited = (perms.groups && perms.groups[group]) || "allow";
  var set = (perms.tools && perms.tools[name]) || inherited, off = Array.isArray(agentTools) && agentTools.indexOf(name) < 0;
  var choices = floor === "deny" ? ["off"] : floor === "ask" ? ["ask", "off"] : neverAsked.indexOf(name) >= 0 ? ["allow", "off"] : ["allow", "ask", "off"];
  var value = off ? "off" : choices.indexOf(set) >= 0 ? set : choices[0];
  // What a floor forces is not a setting of this agent's: it is not written down as one.
  return { name: name, group: group, value: value, choices: choices, inherited: floor === "ask" ? "ask" : inherited };
}

/** What a save sends: the tools that are on (with any the page does not list, kept), and only the settings that differ from their group's. */
function toolsSaved(rows, agentTools, perms) {
  var listed = {}, tools = [], own = {};
  rows.forEach(function (row) {
    listed[row.name] = true;
    if (row.value === "off") return;
    tools.push(row.name);
    if (row.value !== row.inherited) own[row.name] = row.value;
  });
  (agentTools || []).forEach(function (name) { if (!listed[name]) tools.push(name); });
  var permissions = {};
  if (perms.groups) permissions.groups = perms.groups;
  if (Object.keys(own).length) permissions.tools = own;
  return { tools: tools, toolPermissions: permissions };
}

/**
 * The picker. Until what may be chosen has been read, a save changes nothing about tools; if it
 * cannot be read at all (not this agent's driver), the plain on/off list stands in.
 */
function toolChoices(agent, creating) {
  var box = el("div", "toolrows"), rows = null, plain = null, perms = {};
  box.appendChild(el("p", "why", t("ui.next.auto.reading")));
  getJson("/api/agents/tool-permissions?agent=" + encodeURIComponent(creating ? "" : agent.id)).then(function (got) {
    perms = got.permissions || {}; rows = [];
    box.replaceChildren();
    TOOL_GROUP_ORDER.concat(Object.keys(got.groups || {}).filter(function (group) { return TOOL_GROUP_ORDER.indexOf(group) < 0; })).forEach(function (group) {
      var names = (got.groups || {})[group] || [];
      if (!names.length) return;
      box.appendChild(el("h2", "group", MSG["ui.next.tools.group." + group] ? t("ui.next.tools.group." + group) : group));
      names.forEach(function (name) {
        var row = toolStateOf(name, group, creating ? null : agent.tools, perms, got.floors || {}, got.neverAsked || []), line = el("label", "toolrow"), pick = el("select");
        row.choices.forEach(function (choice) { var node = el("option", "", t("ui.next.tools." + choice)); node.value = choice; node.selected = choice === row.value; pick.appendChild(node); });
        pick.disabled = row.choices.length < 2;
        pick.addEventListener("change", function () { row.value = pick.value; });
        line.appendChild(el("span", "", name + ((got.floors || {})[name] ? " · " + t("ui.next.tools.floor") : ""))); line.appendChild(pick);
        rows.push(row); box.appendChild(line);
      });
    });
  }, function () { plain = toolPicker(creating ? null : agent.tools); box.replaceChildren(plain.node); });
  return { node: box, value: function () { return rows ? toolsSaved(rows, creating ? null : agent.tools, perms) : plain ? { tools: plain.value() } : {}; } };
}
`;
