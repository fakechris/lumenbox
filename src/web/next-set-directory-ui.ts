/**
 * Settings → Team → People, the organisation's directory (INV-2202, docs/107): the departments as a
 * tree with a head count each, who asked to join, activating one person or everybody a department
 * lists now, syncing the directory, and who left. An Admin's block, on an organisation only.
 *
 * The tree is closed until a department is opened, and a department's people are read then, fifty
 * at a time: an organisation of hundreds is a few lines until somebody looks inside.
 */
export const NEXT_SET_DIRECTORY_CSS = `
.dept { margin: 2px 0; } .dept > summary { cursor: pointer; padding: 5px 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.dept > summary::before { content: "▸"; color: var(--muted); } .dept[open] > summary::before { content: "▾"; }
.dept > summary::-webkit-details-marker { display: none; } .dept > summary { list-style: none; }
.dept-body { margin-left: 8px; padding-left: 14px; border-left: 2px solid var(--border); }
.dept-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 5px 0; } .dept-row .grow, .dept-row > .why:first-child { flex: 1; min-width: 120px; }
.dept-row label, .setting .dept-row label { flex-direction: row; align-items: center; width: auto; gap: 6px; }
.dept-row input[type="checkbox"], .setting .dept-row input[type="checkbox"] { width: auto; }
[data-directory] p.why, [data-directory] .needbox { white-space: normal; }
`;

export const NEXT_SET_DIRECTORY_JS = `
var directory = { data: null, loading: false, channelId: "", open: {}, people: {}, role: {}, sub: {}, note: "" };

/** Where a directory person stands, as a chip in the page's own tones. */
function directoryChip(state) {
  var chip = el("span", "chip", t("ui.next.directory.state." + state));
  chip.className = "chip" + (state === "asked" ? " need" : state === "active" ? " done" : state === "left" ? " stuck" : "");
  return chip;
}

function loadDirectory() {
  if (directory.loading) return;
  directory.loading = true;
  getJson("/api/activations" + (directory.channelId ? "?channelId=" + encodeURIComponent(directory.channelId) : "")).then(function (got) {
    directory.data = got; directory.channelId = got.channelId || "";
    Object.keys(directory.open).forEach(function (id) { if (directory.open[id]) loadDepartmentPeople(id, 0); });
  }, function () { directory.data = directory.data || { doors: [] }; }).then(function () { directory.loading = false; if (next.view === "settings") render(); });
}

/** A department's own people, read when it is opened; "more" appends the next fifty. */
function loadDepartmentPeople(id, offset) {
  getJson("/api/activations/people?channelId=" + encodeURIComponent(directory.channelId) + "&department=" + encodeURIComponent(id) + "&offset=" + offset).then(function (got) {
    var before = offset > 0 && directory.people[id] ? directory.people[id].people : [];
    directory.people[id] = { total: got.total, people: before.concat(got.people || []) };
    if (next.view === "settings") render();
  }, failed);
}

function directoryRolePick(key) {
  var pick = selectOf(ROLES.map(function (name) { return [name, t("ui.next.team.role." + name)]; }), directory.role[key] || "driver");
  pick.addEventListener("change", function () { directory.role[key] = pick.value; });
  return pick;
}

function activatePerson(person, key) {
  var go = el("button", "act", t("ui.next.directory.activate"));
  go.addEventListener("click", function () {
    go.disabled = true;
    postJson("/api/activations/person", { channelId: directory.channelId, subject: person.subject, role: directory.role[key] || "driver" })
      .then(function () { toast(t("ui.next.directory.activated", { name: person.name })); loadDirectory(); }, function (error) { go.disabled = false; failed(error); });
  });
  return go;
}

/** Asked to join: signed in through the channel and waiting. Shown with the people who wrote and wait (Settings → Channels) too. */
function joinRequestsBlock(alone) {
  var requests = (directory.data || {}).requests || [];
  if (directory.data === null) { loadDirectory(); return null; }
  if (!requests.length) return null;
  var box = el(alone ? "section" : "div", alone ? "setting" : "");
  box.setAttribute("data-directory", "requests");
  box.appendChild(el(alone ? "h2" : "h3", "group", t("ui.next.directory.asked", { n: requests.length })));
  box.appendChild(el("p", "why", t("ui.next.directory.askedNote")));
  requests.forEach(function (request) {
    var line = el("div", "dept-row"), key = "r:" + request.subject, away = el("button", "act", t("ui.next.card.dismiss"));
    line.appendChild(el("span", "grow", request.name + " · " + agoText(request.at) + (request.listed ? "" : " · " + t("ui.next.directory.notListed"))));
    away.addEventListener("click", function () { postJson("/api/activations/dismiss", { channelId: directory.channelId, subject: request.subject }).then(loadDirectory, failed); });
    [directoryRolePick(key), activatePerson(request, key), away].forEach(function (node) { line.appendChild(node); });
    box.appendChild(line);
  });
  return box;
}

function directoryPersonRow(person) {
  var line = el("div", "dept-row"), key = "p:" + person.subject, who = el("span", "grow", person.name + (person.title ? " · " + person.title : ""));
  line.setAttribute("data-person-state", person.state);
  line.appendChild(who);
  line.appendChild(directoryChip(person.state));
  if (person.state === "active") {
    line.appendChild(el("span", "why", t("ui.next.team.role." + person.role) + (person.signedIn ? "" : " · " + t("ui.next.directory.notSignedIn"))));
    return line;
  }
  line.appendChild(directoryRolePick(key)); line.appendChild(activatePerson(person, key));
  return line;
}

/** Everybody the department lists now, at one role, once. Whoever joins it later is only listed. */
function departmentActs(node) {
  var line = el("div", "dept-row"), key = "d:" + node.vendorId, sub = el("input"), subLabel = el("label", ""), go = el("button", "act", t("ui.next.directory.activateDept", { n: node.direct }));
  var count = function () { return directory.sub[node.vendorId] ? node.total : node.direct; };
  sub.type = "checkbox"; sub.checked = !!directory.sub[node.vendorId];
  sub.addEventListener("change", function () { directory.sub[node.vendorId] = sub.checked; go.textContent = t("ui.next.directory.activateDept", { n: count() }); });
  go.textContent = t("ui.next.directory.activateDept", { n: count() });
  subLabel.appendChild(sub); subLabel.appendChild(document.createTextNode(" " + t("ui.next.directory.withSub")));
  go.addEventListener("click", function () {
    var sure = el("button", "act-primary", t("ui.next.directory.activateDeptSure", { n: count(), role: t("ui.next.team.role." + (directory.role[key] || "driver")) }));
    sure.addEventListener("click", function () {
      sure.disabled = true;
      postJson("/api/activations/department", { channelId: directory.channelId, department: node.vendorId, includeSub: !!directory.sub[node.vendorId], role: directory.role[key] || "driver" })
        .then(function (got) {
          directory.note = t("ui.next.directory.deptDone", { name: node.name || t("ui.next.directory.root"), n: got.activated, already: got.alreadyActive }); loadDirectory();
        }, function (error) { failed(error); loadDirectory(); });
    });
    go.replaceWith(sure);
  });
  line.appendChild(directoryRolePick(key));
  if (node.total > node.direct) line.appendChild(subLabel);
  line.appendChild(go);
  return line;
}

function departmentNode(node, all) {
  var fold = el("details", "dept"), head = el("summary", ""), body = el("div", "dept-body"), counts = [t("ui.next.directory.count", { n: node.total })];
  if (node.active) counts.push(t("ui.next.directory.countActive", { n: node.active }));
  if (node.asked) counts.push(t("ui.next.directory.countAsked", { n: node.asked }));
  if (node.left) counts.push(t("ui.next.directory.countLeft", { n: node.left }));
  fold.setAttribute("data-department", node.vendorId);
  head.appendChild(el("strong", "", node.name || t("ui.next.directory.root"))); head.appendChild(el("span", "why", counts.join(" · ")));
  fold.appendChild(head); fold.open = !!directory.open[node.vendorId];
  fold.addEventListener("toggle", function () {
    if (fold.open === !!directory.open[node.vendorId]) return;
    directory.open[node.vendorId] = fold.open;
    if (fold.open) loadDepartmentPeople(node.vendorId, 0); else render();
  });
  if (!fold.open) return fold; // nothing inside is built until somebody looks
  if (node.total > 0) body.appendChild(departmentActs(node));
  all.filter(function (child) { return child.parentVendorId === node.vendorId; }).forEach(function (child) { body.appendChild(departmentNode(child, all)); });
  var held = directory.people[node.vendorId];
  if (!held && node.direct > 0) body.appendChild(el("p", "why", t("ui.next.auto.reading")));
  if (held) {
    held.people.forEach(function (person) { body.appendChild(directoryPersonRow(person)); });
    if (held.people.length < held.total) {
      var more = el("button", "act", t("ui.next.directory.more", { n: held.total - held.people.length }));
      more.addEventListener("click", function () { more.disabled = true; loadDepartmentPeople(node.vendorId, held.people.length); });
      body.appendChild(more);
    }
  }
  fold.appendChild(body);
  return fold;
}

function directorySyncLine(data) {
  var line = el("div", "dept-row"), door = (data.doors || []).filter(function (each) { return each.channelId === data.channelId; })[0] || {}, sync = el("button", "act", t("ui.next.directory.sync"));
  var when = door.status === "not-synced" || !door.syncedAt ? t("ui.next.directory.neverSynced") : t("ui.next.directory.synced", { when: agoText(door.syncedAt), n: data.people || 0 });
  if (door.status === "failed") when += " · " + t("ui.next.directory.syncFailed");
  if (door.status === "changed") when = t("ui.next.directory.changed");
  if ((data.doors || []).length > 1) {
    var pick = selectOf(data.doors.map(function (each) { return [each.channelId, each.name]; }), data.channelId);
    pick.addEventListener("change", function () { directory.channelId = pick.value; directory.open = {}; directory.people = {}; loadDirectory(); });
    line.appendChild(pick);
  }
  line.appendChild(el("span", "why", when));
  sync.addEventListener("click", function () {
    sync.disabled = true; sync.textContent = t("ui.next.directory.syncing");
    postJson("/api/directories/sync", { channelId: data.channelId }).then(function (got) {
      directory.note = got.left ? t("ui.next.directory.syncedLeft", { n: got.left }) : t("ui.next.directory.syncedNow"); loadDirectory(); loadPeople();
    }, function (error) { failed(error); loadDirectory(); });
  });
  line.appendChild(sync);
  return line;
}

function directoryBlock() {
  if ((team.installation || {}).mode === "single-machine") return null;
  var data = directory.data;
  if (data === null) { loadDirectory(); return null; }
  if (!(data.doors || []).length || !data.channelId) return null;
  var box = el("section", "setting"), requests = joinRequestsBlock(false), departments = data.departments || [];
  box.setAttribute("data-directory", "tree");
  box.appendChild(el("h2", "group", t("ui.next.directory.title")));
  box.appendChild(el("p", "why", t("ui.next.directory.note")));
  box.appendChild(directorySyncLine(data));
  if (directory.note) box.appendChild(el("p", "why", directory.note));
  (data.unlisted || []).forEach(function (person) { box.appendChild(el("div", "needbox", t("ui.next.directory.lastAdminKept", { name: person.name }))); });
  if (requests) box.appendChild(requests);
  departments.filter(function (node) { return node.parentVendorId === null; }).forEach(function (node) { box.appendChild(departmentNode(node, departments)); });
  var left = data.left || [];
  if (left.length) {
    box.appendChild(el("h3", "group", t("ui.next.directory.left", { n: left.length })));
    box.appendChild(el("p", "why", t("ui.next.directory.leftNote")));
    left.forEach(function (person) {
      var line = el("div", "dept-row"), facts = [person.name];
      if (person.at) facts.push(agoText(person.at));
      if (person.boxes) facts.push(t("ui.next.directory.leftBoxes", { n: person.boxes }));
      line.setAttribute("data-person-state", "left");
      line.appendChild(el("span", "grow", facts.join(" · "))); line.appendChild(directoryChip("left"));
      box.appendChild(line);
    });
  }
  return box;
}
`;
