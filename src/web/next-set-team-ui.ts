/**
 * The team's settings on the rebuilt page (INV-1825), first half: who the people are and what each
 * may do, inviting one, the scopes that narrow what agents may use, the secrets the agents are lent,
 * and the outside tool servers. An admin's pane. A secret's value is typed, saved and never shown
 * again; the page is told only that it exists and who holds it.
 */
export const NEXT_SET_TEAM_JS = `
var team = { people: null, installation: null, error: "", invite: null, scopes: null, allTools: [], vault: null, mcp: null, merge: null };
var ROLES = ["admin", "driver", "viewer"];

function loadTeam() {
  getJson("/api/channels").then(function (got) { team.people = got.principals || []; team.installation = got.installation || {}; team.error = ""; }, function (error) {
    team.people = []; team.error = error.message;
  }).then(function () { if (next.view === "settings") render(); });
  var also = function (path, keep) { getJson(path).then(function (got) { keep(got); if (next.view === "settings") render(); }, function () {}); };
  also("/api/scopes", function (got) { team.scopes = got.scopes || []; team.allTools = got.allTools || []; });
  also("/api/vault", function (got) { team.vault = got; });
  also("/api/mcp", function (got) { team.mcp = got; });
  also("/api/installation/merge", function (got) { team.merge = got; });
  loadLimits();
}

/** A comma-separated field as a list, without blanks. */
function listOf(text) { return String(text || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean); }

/** The roster with one person's role changed: the whole list is what the server takes. */
function rosterWith(people, id, role) {
  return people.map(function (person) { return { id: person.id, name: person.name, role: person.id === id ? role : person.role, identities: person.identities || [] }; });
}

function peopleBlock() {
  var box = el("section", "setting"), personal = (team.installation || {}).mode === "single-machine";
  box.appendChild(el("h2", "group", t("ui.next.team.people")));
  (team.people || []).forEach(function (person) {
    var line = el("div", "fact"), owner = personal && person.id === team.installation.ownerId;
    line.appendChild(el("span", "", person.name + " · " + t("ui.next.team.identities", { n: (person.identities || []).length })));
    if (owner) line.appendChild(el("span", "chip", t("ui.next.team.owner")));
    else {
      var role = selectOf(ROLES.map(function (name) { return [name, t("ui.next.team.role." + name)]; }), person.role);
      role.addEventListener("change", function () {
        postJson("/api/principals", { principals: rosterWith(team.people, person.id, role.value) }).then(function (got) { team.people = got.principals || team.people; toast(t("ui.next.settings.saved2")); render(); }, function (error) {
          failed(error); loadTeam();
        });
      });
      line.appendChild(role);
    }
    box.appendChild(line);
  });
  var as = selectOf([["driver", t("ui.next.team.role.driver")], ["viewer", t("ui.next.team.role.viewer")], ["admin", t("ui.next.team.role.admin")]], "driver");
  var invite = el("button", "act", t(personal ? "ui.next.team.linkMine" : "ui.next.team.invite")), row = el("div", "acts");
  invite.addEventListener("click", function () {
    postJson("/api/channels/invite", personal ? { principalId: team.installation.ownerId } : { role: as.value }).then(function (got) { team.invite = got; render(); }, failed);
  });
  if (!personal) row.appendChild(as);
  row.appendChild(invite); box.appendChild(row);
  if (team.invite) {
    // Good for fifteen minutes and for one person: said with the code, because it is easy to assume otherwise.
    var once = el("div", "needbox");
    once.appendChild(el("div", "", t("ui.next.team.inviteNote")));
    once.appendChild(el("code", "card-code", team.invite.link || team.invite.code || ""));
    if (team.invite.link && team.invite.code) once.appendChild(el("div", "why", t("ui.next.team.inviteCode", { code: team.invite.code })));
    box.appendChild(once);
  }
  return box;
}

/** Several records that are one person, offered as a single merge; done only on a confirmed press, and then the installation restarts. */
function mergeBlock() {
  var merge = team.merge;
  if (!merge || !merge.offered) return null;
  var box = el("section", "setting"), name = el("input"), yes = el("button", "act-primary", t("ui.next.team.merge")), no = el("button", "act", t("ui.next.team.mergeNo")), acts = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.team.mergeTitle")));
  (merge.people || []).forEach(function (person) { box.appendChild(fact(person.name, (person.identities || []).map(function (row) { return row.door; }).join(", "))); });
  name.value = merge.ownerName || "";
  yes.addEventListener("click", function () {
    yes.disabled = true;
    postJson("/api/installation/merge", { confirm: true, digest: merge.digest, name: name.value.trim() }).then(function () {
      toast(t("ui.next.doors.restart")); postJson("/api/restart", {}).catch(function () {});
    }, function (error) { yes.disabled = false; failed(error); });
  });
  no.addEventListener("click", function () { postJson("/api/installation/merge", { decline: true, digest: merge.digest }).then(function () { team.merge = null; render(); }, failed); });
  box.appendChild(labelled(t("ui.next.team.mergeName"), name)); acts.appendChild(yes); acts.appendChild(no); box.appendChild(acts);
  return box;
}

/** Scopes: named limits on tools, secrets and sites that an agent can be put under. The whole list is saved together. */
function scopesBlock() {
  if (team.scopes === null) return null;
  var box = el("section", "setting"), rows = [], add = el("button", "act", t("ui.next.team.addScope")), save = el("button", "act-primary", t("ui.next.settings.save")), acts = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.team.scopes")));
  box.appendChild(el("p", "why", t("ui.next.team.scopesNote")));
  team.scopes.forEach(function (scope, index) {
    var fold = el("details", "fold"), body = el("div", "fold-body"), name = el("input"), tools = el("input"), secrets = el("input"), hosts = el("input"), gone = el("button", "act", t("ui.next.doors.remove"));
    name.value = scope.name || ""; tools.value = (scope.tools || []).join(", "); secrets.value = (scope.secretIds || []).join(", "); hosts.value = (scope.egressHosts || []).join(", ");
    tools.placeholder = t("ui.next.team.allTools");
    fold.open = !!scope.fresh;
    fold.appendChild(el("summary", "", scope.name || scope.id));
    gone.addEventListener("click", function () { team.scopes.splice(index, 1); render(); });
    [labelled(t("ui.next.member.name"), name), labelled(t("ui.next.team.scopeTools"), tools), labelled(t("ui.next.team.scopeSecrets"), secrets),
      labelled(t("ui.next.team.scopeHosts"), hosts), gone].forEach(function (node) { body.appendChild(node); });
    fold.appendChild(body); box.appendChild(fold);
    rows.push(function () {
      var next2 = Object.assign({}, scope, { name: name.value.trim() || scope.id, secretIds: listOf(secrets.value) });
      delete next2.fresh; delete next2.tools; delete next2.egressHosts;
      if (listOf(tools.value).length) next2.tools = listOf(tools.value);
      if (listOf(hosts.value).length) next2.egressHosts = listOf(hosts.value);
      return next2;
    });
  });
  add.addEventListener("click", function () {
    team.scopes = rows.map(function (read) { return read(); }).concat([{ id: "scope-" + Date.now().toString(36), name: "", secretIds: [], fresh: true }]); render();
  });
  save.addEventListener("click", function () {
    postJson("/api/scopes", { scopes: rows.map(function (read) { return read(); }) }).then(function (got) { team.scopes = got.scopes || []; toast(t("ui.next.settings.saved2")); render(); }, failed);
  });
  acts.appendChild(save); acts.appendChild(add); box.appendChild(acts);
  return box;
}

/** Secrets lent to agents. What is listed is that one exists, who holds it and where it may be sent — never its value. */
function secretsBlock() {
  if (!team.vault) return null;
  var box = el("section", "setting"), needed = team.vault.neededBy || {};
  var put = function (body, after) { postJson("/api/vault", body).then(function (got) { team.vault = Object.assign({}, team.vault, { secrets: got.secrets || [] }); after(); render(); }, failed); };
  box.appendChild(el("h2", "group", t("ui.next.team.secrets")));
  box.appendChild(el("p", "why", t("ui.next.team.secretsNote")));
  (team.vault.secrets || []).forEach(function (secret) {
    var line = el("div", "fact"), holders = (secret.grants || []).map(function (grant) { return grant.holder; }).join(", "), remove = el("button", "act", t("ui.next.doors.remove"));
    var note = [secret.description, holders ? t("ui.next.team.heldBy", { who: holders }) : "", (secret.domains || []).join(", "), (needed[secret.id] || []).length ? t("ui.next.team.neededBy", { who: needed[secret.id].join(", ") }) : ""];
    var text = el("span", ""); text.appendChild(el("b", "", secret.id)); text.appendChild(el("div", "why", note.filter(Boolean).join(" · ")));
    remove.addEventListener("click", function () {
      var sure = el("button", "act-danger", t((needed[secret.id] || []).length ? "ui.next.team.removeNeeded" : "ui.next.doors.removeSure"));
      sure.addEventListener("click", function () { postJson("/api/vault/remove", { id: secret.id }).then(function (got) { team.vault = Object.assign({}, team.vault, { secrets: got.secrets || [] }); render(); }, failed); });
      remove.replaceWith(sure);
    });
    line.appendChild(text); line.appendChild(remove); box.appendChild(line);
  });
  var id = el("input"), value = el("input"), holders2 = el("input"), sites = el("input"), save = el("button", "act", t("ui.next.team.saveSecret"));
  value.type = "password"; value.autocomplete = "off"; holders2.placeholder = t("ui.next.team.holdersPlaceholder"); sites.placeholder = t("ui.next.team.sitesPlaceholder");
  save.addEventListener("click", function () {
    if (!id.value.trim()) { id.focus(); return; }
    var domains = listOf(sites.value), body = { id: id.value.trim(), grants: listOf(holders2.value).map(function (holder) { return { holder: holder }; }) };
    // "git" among the sites means the secret is a git credential, as the classic field read it.
    body.kind = domains.indexOf("git") >= 0 ? "git" : null; body.domains = domains.filter(function (site) { return site !== "git"; });
    if (value.value) body.value = value.value;
    put(body, function () { id.value = ""; value.value = ""; holders2.value = ""; sites.value = ""; toast(t("ui.next.settings.saved2")); });
  });
  [labelled(t("ui.next.team.secretId"), id), labelled(t("ui.next.team.secretValue"), value), labelled(t("ui.next.team.holders"), holders2), labelled(t("ui.next.team.sites"), sites), save]
    .forEach(function (node) { box.appendChild(node); });
  return box;
}

function toolServersBlock() {
  if (!team.mcp) return null;
  var box = el("section", "setting"), servers = team.mcp.servers || [], extensions = team.mcp.extensions, acts = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.team.servers")));
  servers.forEach(function (server) {
    var over = server.toolCount > (team.mcp.budget || Infinity);
    box.appendChild(fact(server.name, t(server.running ? "ui.next.doors.on" : "ui.next.doors.off") + " · " + t("ui.next.team.toolCount", { n: server.toolCount || 0 }) + (over ? " · " + t("ui.next.team.overBudget") : "")
      + (server.detail ? " · " + server.detail : "")));
  });
  if (!servers.length) box.appendChild(el("p", "why", t("ui.next.team.noServers")));
  if (extensions) {
    box.appendChild(fact(t("ui.next.team.extensions"), t("ui.next.team.toolCount", { n: (extensions.tools || []).length || extensions.tools || 0 })));
    (extensions.problems || []).forEach(function (problem) { box.appendChild(el("p", "why", String(problem))); });
  }
  [["/api/mcp/reload", t("ui.next.team.reloadServers")], ["/api/extensions/reload", t("ui.next.team.reloadExtensions")]].forEach(function (pair) {
    var again = el("button", "act", pair[1]);
    again.addEventListener("click", function () { again.disabled = true; postJson(pair[0], {}).then(function () { toast(t("ui.next.settings.saved2")); loadTeam(); }, function (error) { again.disabled = false; failed(error); }); });
    acts.appendChild(again);
  });
  box.appendChild(acts);
  return box;
}

function renderTeamPane(view) {
  if (team.people === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadTeam(); return; }
  if (team.error) { view.appendChild(el("p", "why", team.error)); return; }
  [mergeBlock(), peopleBlock(), limitsBlock(), memoryReviewBlock(), scopesBlock(), secretsBlock(), toolServersBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
