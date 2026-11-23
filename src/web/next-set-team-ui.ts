/**
 * The team's settings on the rebuilt page (INV-1825), first half: who the people are and what each
 * may do, inviting one, the scopes that narrow what agents may use, the secrets the agents are lent,
 * and the outside tool servers. An admin's pane. A secret's value is typed, saved and never shown
 * again; the page is told only that it exists and who holds it.
 */
export const NEXT_SET_TEAM_JS = `
var team = { people: null, installation: null, error: "", invite: null, inviteCheck: 0, invites: [], scopes: null, allTools: [], vault: null, mcp: null, merge: null, loadedAt: 0, timer: 0 };
var ROLES = ["admin", "driver", "viewer"];
var INVITE_MINUTES = ["15", "60", "1440", "10080"];
var invitePick = { role: "driver", minutes: "15" }, removing = { id: "" };

function keepPeople(got) {
  team.people = got.people || []; team.installation = got.installation || {}; team.invites = got.invites || []; team.error = "";
  if (team.invite && !team.invites.some(function (invite) { return invite.code === team.invite.code; })) team.invite = null; // used or expired
}

/** The People list, re-read while the pane is open so a person who just redeemed a code appears (INV-2054). */
function loadPeople() {
  team.loadedAt = Date.now(); clearTimeout(team.timer);
  team.timer = setTimeout(function () { if (next.view === "settings" && settings.pane === "team" && !removing.id) loadPeople(); }, 15000);
  return getJson("/api/people").then(keepPeople, function (error) {
    team.people = team.people || []; team.error = error.message;
  }).then(function () { if (next.view === "settings") render(); });
}

function loadTeam() {
  loadPeople();
  var also = function (path, keep) { getJson(path).then(function (got) { keep(got); if (next.view === "settings") render(); }, function () {}); };
  also("/api/scopes", function (got) { team.scopes = got.scopes || []; team.allTools = got.allTools || []; });
  also("/api/vault", function (got) { team.vault = got; });
  also("/api/mcp", function (got) { team.mcp = got; });
  also("/api/installation/merge", function (got) { team.merge = got; });
  loadLimits();
}

function teamPaneOpen() { return next.view === "settings" && settings.pane === "team"; }

function watchTeamInvite() {
  if (team.inviteCheck || !team.invite || !teamPaneOpen()) return;
  team.inviteCheck = setTimeout(function () {
    if (!teamPaneOpen()) { team.inviteCheck = 0; return; }
    var invite = team.invite;
    getJson("/api/people").then(function (got) {
      if (team.invite !== invite || !Array.isArray(got.invites) || got.invites.some(function (active) { return active.code === invite.code; })) return;
      keepPeople(got);
      if (teamPaneOpen()) render();
    }, function () {}).finally(function () {
      team.inviteCheck = 0; watchTeamInvite();
    });
  }, 3000);
}

/** A comma-separated field as a list, without blanks. */
function listOf(text) { return String(text || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean); }

/** The roster with one person's role changed: the whole list is what the server takes. */
function rosterWith(people, id, role) {
  return people.map(function (person) { return { id: person.id, name: person.name, role: person.id === id ? role : person.role, identities: person.identities || [] }; });
}

function untilText(at) { return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }

/** Which doors a person signs in through, by the names the Doors pane uses. */
function doorsText(person) {
  return (person.doors || []).map(function (door) { return door.door === "web" ? t("ui.next.team.door.web") : door.door; }).join(", ");
}

/** What an admin needs to know before acting on a person: how they sign in, when they last did anything, their boxes. */
function personFacts(person) {
  var boxes = person.boxes || {}, doors = doorsText(person);
  return [
    doors ? t("ui.next.team.via", { via: doors }) : t("ui.next.team.noDoor"),
    person.lastActive ? t("ui.next.team.active", { when: agoText(person.lastActive) }) : t("ui.next.team.neverActive"),
    boxes.quota === null || boxes.quota === undefined ? t("ui.next.team.boxesFree", { n: boxes.held || 0 }) : t("ui.next.team.boxes", { n: boxes.held || 0, quota: boxes.quota })
  ].join(" · ");
}

function minutesPick() {
  var lasts = selectOf(INVITE_MINUTES.map(function (n) { return [n, t("ui.next.team.lasts." + n)]; }), invitePick.minutes);
  lasts.addEventListener("change", function () { invitePick.minutes = lasts.value; });
  return labelled(t("ui.next.team.lasts"), lasts);
}

function newCode(body, after) {
  postJson("/api/channels/invite", Object.assign({ minutes: Number(invitePick.minutes) }, body)).then(function (got) { team.invite = got; if (after) after(); loadPeople(); }, failed);
}

/** A person's own actions. Removing takes a second press that says what it does; the last admin has none (INV-2053). */
function personActs(person) {
  var acts = el("div", "acts"), code = el("button", "act", t("ui.next.team.codeFor")), out = el("button", "act", t("ui.next.team.signOut"));
  code.addEventListener("click", function () { newCode({ principalId: person.id }); });
  out.addEventListener("click", function () {
    postJson("/api/principals/logout", { principalId: person.id }).then(function () { toast(t("ui.next.team.signedOut", { name: person.name })); }, failed);
  });
  acts.appendChild(code);
  // Signing the only admin out everywhere can leave nobody able to sign back in to the settings.
  if (person.lastAdmin) { acts.appendChild(el("span", "why", t("ui.next.team.lastAdmin"))); return acts; }
  acts.appendChild(out);
  if (removing.id !== person.id) {
    var remove = el("button", "act", t("ui.next.team.remove"));
    remove.addEventListener("click", function () { removing.id = person.id; render(); });
    acts.appendChild(remove); return acts;
  }
  var sure = el("button", "act-danger", t("ui.next.team.removeSure", { name: person.name })), keep = el("button", "act", t("ui.next.team.keep"));
  sure.addEventListener("click", function () {
    sure.disabled = true;
    postJson("/api/principals/remove", { principalId: person.id }).then(function () { removing.id = ""; toast(t("ui.next.team.removed", { name: person.name })); loadPeople(); }, function (error) {
      removing.id = ""; failed(error); loadPeople();
    });
  });
  keep.addEventListener("click", function () { removing.id = ""; render(); });
  var what = el("div", "needbox");
  what.appendChild(el("div", "", t("ui.next.team.removeWhat", { name: person.name, n: (person.boxes || {}).held || 0 })));
  if (person.self) what.appendChild(el("div", "why", t("ui.next.team.removeSelf")));
  var both = el("div", "acts"); both.appendChild(sure); both.appendChild(keep); what.appendChild(both);
  var whole = el("div", ""); whole.appendChild(acts); whole.appendChild(what);
  return whole;
}

function personLine(person, personal) {
  var line = el("div", "person-row"), head = el("div", "fact"), owner = personal && person.id === team.installation.ownerId;
  head.appendChild(el("strong", "", person.name));
  if (person.self) head.appendChild(el("span", "chip", t("ui.next.team.you")));
  if (owner) head.appendChild(el("span", "chip", t("ui.next.team.owner")));
  else {
    var role = selectOf(ROLES.map(function (name) { return [name, t("ui.next.team.role." + name)]; }), person.role);
    role.addEventListener("change", function () {
      delete role.dataset.edited; // the next redraw shows the role the server kept, refused or not
      // The roster as it is now, not as last drawn: a sign-in linked since then must survive the save.
      getJson("/api/people").then(function (got) {
        return postJson("/api/principals", { principals: rosterWith(got.people || [], person.id, role.value) });
      }).then(function () { toast(t("ui.next.settings.saved2")); loadPeople(); }, function (error) {
        failed(error); loadPeople();
      });
    });
    head.appendChild(role);
  }
  line.appendChild(head);
  line.appendChild(el("div", "why", personFacts(person)));
  if (!owner) line.appendChild(personActs(person));
  return line;
}

/** Who a code is for, as the card and the list of live codes say it (INV-2056). */
function inviteWho(invite) {
  if (invite.name) return t("ui.next.team.inviteFor", { name: invite.name });
  return t("ui.next.team.inviteAs", { role: t("ui.next.team.role." + invite.role) }) + (invite.note ? " · " + invite.note : "");
}

function inviteCard(invite) {
  // Good for one person, once, until a time: said with the code, because it is easy to assume otherwise.
  var once = el("div", "needbox");
  once.appendChild(el("strong", "", inviteWho(invite)));
  once.appendChild(el("div", "", t("ui.next.team.inviteNote", { when: untilText(invite.expiresAt) })));
  once.appendChild(el("code", "card-code", invite.link || invite.code || ""));
  if (invite.link && invite.code) once.appendChild(el("div", "why", t("ui.next.team.inviteCode", { code: invite.code })));
  return once;
}

function inviteForm(personal) {
  var row = el("div", "acts"), invite = el("button", "act", t(personal ? "ui.next.team.linkMine" : "ui.next.team.invite"));
  if (personal) {
    invite.addEventListener("click", function () { newCode({ principalId: team.installation.ownerId }); });
    row.appendChild(minutesPick()); row.appendChild(invite); return row;
  }
  var as = selectOf([["driver", t("ui.next.team.role.driver")], ["viewer", t("ui.next.team.role.viewer")], ["admin", t("ui.next.team.role.admin")]], invitePick.role);
  var note = el("input");
  note.maxLength = 80; note.placeholder = t("ui.next.team.inviteWhoPlaceholder");
  as.addEventListener("change", function () { invitePick.role = as.value; });
  invite.addEventListener("click", function () {
    newCode({ role: as.value, note: note.value.trim() }, function () { note.value = ""; delete note.dataset.edited; });
  });
  [labelled(t("ui.next.team.inviteRole"), as), labelled(t("ui.next.team.inviteWho"), note), minutesPick(), invite].forEach(function (node) { row.appendChild(node); });
  return row;
}

function peopleBlock() {
  var box = el("section", "setting"), personal = (team.installation || {}).mode === "single-machine";
  box.appendChild(el("h2", "group", t("ui.next.team.people")));
  (team.people || []).forEach(function (person) { box.appendChild(personLine(person, personal)); });
  box.appendChild(inviteForm(personal));
  if (team.invite) box.appendChild(inviteCard(team.invite));
  var waiting = team.invites || [];
  if (waiting.length > 0) {
    box.appendChild(el("h3", "group", t("ui.next.team.pending")));
    waiting.forEach(function (invite) {
      box.appendChild(el("div", "fact", t("ui.next.team.pendingLine", { code: invite.code, who: inviteWho(invite), when: untilText(invite.expiresAt) })));
    });
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
  if (Date.now() - team.loadedAt > 15000) loadPeople();
  if (team.error) { view.appendChild(el("p", "why", team.error)); return; }
  watchTeamInvite();
  [mergeBlock(), peopleBlock(), limitsBlock(), memoryReviewBlock(), scopesBlock(), secretsBlock(), toolServersBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
