/**
 * Teams in the agent list of the rebuilt page (INV-1825). A team is a tag agents carry, nothing more:
 * when any agent on the selected computer has one, the list can be narrowed to a team, and an admin
 * can rename a team for everybody in it. With no tags there is nothing to show, and nothing is.
 */
export const NEXT_TEAMS_JS = `
var teams = { chosen: "", renaming: false };
try { teams.chosen = localStorage.getItem("lumen-team") || ""; } catch (error) {}

/** The teams among these agents, in order; "-" stands for the agents in none. */
function teamsOf(agents) {
  var seen = {}, loose = false;
  agents.forEach(function (agent) { if ((agent.tags || []).length === 0) loose = true; (agent.tags || []).forEach(function (tag) { seen[tag] = true; }); });
  var names = Object.keys(seen).sort();
  return names.length && loose ? names.concat(["-"]) : names;
}

/** The agents of the chosen team; all of them when none is chosen, or when the chosen one is not among these. */
function inTeam(agents, chosen) {
  if (!chosen || teamsOf(agents).indexOf(chosen) < 0) return agents;
  return agents.filter(function (agent) { return chosen === "-" ? (agent.tags || []).length === 0 : (agent.tags || []).indexOf(chosen) >= 0; });
}

function chooseTeam(name) {
  teams.chosen = name; teams.renaming = false;
  try { localStorage.setItem("lumen-team", name); } catch (error) {}
  render();
}

/** The control above the agent list. Hidden when no agent here is in a team. */
function renderTeams(agents) {
  var holder = $("teams"), names = teamsOf(agents);
  holder.replaceChildren();
  holder.hidden = names.length === 0;
  if (holder.hidden) return;
  if (teams.renaming) {
    var input = el("input"), save = el("button", "act", t("ui.next.settings.save"));
    input.value = teams.chosen;
    save.addEventListener("click", function () {
      var to = input.value.trim();
      if (!to || to === teams.chosen) { teams.renaming = false; render(); return; }
      postJson("/api/teams/rename", { from: teams.chosen, to: to }).then(function () {
        teams.renaming = false; teams.chosen = "";
        // The server writes a team's name its own way (lower case, hyphens): the one it now is, is chosen.
        var written = to.toLowerCase().replace(/\\s+/g, "-");
        refresh().then(function () { chooseTeam(teamsOf(agentsHere()).filter(function (name) { return name.toLowerCase() === written; })[0] || ""); });
      }, failed);
    });
    holder.appendChild(input); holder.appendChild(save); input.focus();
    return;
  }
  var pick = el("select"), option = function (value, text) { var node = el("option", "", text); node.value = value; node.selected = value === teams.chosen; pick.appendChild(node); };
  pick.setAttribute("aria-label", t("ui.next.team.label"));
  option("", t("ui.next.team.all"));
  names.forEach(function (name) { option(name, name === "-" ? t("ui.next.team.none") : name); });
  pick.addEventListener("change", function () { chooseTeam(pick.value); });
  holder.appendChild(pick);
  if (teams.chosen && teams.chosen !== "-" && names.indexOf(teams.chosen) >= 0) {
    var rename = el("button", "", t("ui.next.team.rename"));
    rename.addEventListener("click", function () { teams.renaming = true; render(); });
    holder.appendChild(rename);
  }
}
`;
