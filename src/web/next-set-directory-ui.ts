/**
 * Settings → Team → People, the organisation's directory (INV-2202, docs/107): the departments as a
 * tree with a head count each, who asked to join, activating one person or everybody a department
 * lists now, syncing the directory, and who left. An Admin's block, on an organisation only.
 *
 * The tree is closed until a department is opened, and a department's people are read then, fifty
 * at a time: an organisation of hundreds is a few lines until somebody looks inside.
 *
 * A department's press first shows what it asks of the cluster — the computers it starts and their
 * memory — and starts nothing until the Admin confirms (INV-2220). After it, the computers made at
 * activation are counted by state, each state opened to see its people fifty at a time, updated
 * live from the page's event stream; the failed ones can be retried and the people not told can be
 * told again.
 */
export const NEXT_SET_DIRECTORY_CSS = `
.dept { margin: 2px 0; } .dept > summary { cursor: pointer; padding: 5px 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.dept > summary::before { content: "▸"; color: var(--muted); } .dept[open] > summary::before { content: "▾"; }
.dept > summary::-webkit-details-marker { display: none; } .dept > summary { list-style: none; }
.dept-body { margin-left: 8px; padding-left: 14px; border-left: 2px solid var(--border); }
.dept-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 5px 0; } .dept-row .grow, .dept-row > .why:first-child { flex: 1; min-width: 120px; }
.dept-row label, .setting .dept-row label { flex-direction: row; align-items: center; width: auto; gap: 6px; }
.dept-row input[type="checkbox"], .setting .dept-row input[type="checkbox"] { width: auto; }
[data-directory] p.why, [data-directory] .needbox, [data-directory] .needbox .why { white-space: normal; }
[data-directory="held"] { margin: 8px 0; } [data-directory="held"] .acts { margin-top: 8px; flex-wrap: wrap; }
`;

export const NEXT_SET_DIRECTORY_JS = `
var directory = { data: null, loading: false, channelId: "", open: {}, people: {}, role: {}, sub: {}, note: "", progress: null, shown: {}, rows: {}, ask: {} };

/** Bytes as the cluster's unit, GiB. */
function directoryGiB(bytes) { return (Math.round(bytes / 1073741824 * 10) / 10) + " GiB"; }

/** The counts of the computers made at activation; an open state's people with them. An answer for a door no longer chosen is dropped. */
function loadDirectoryProgress() {
  var door = directory.channelId;
  if (!door) return;
  getJson("/api/activations/progress?channelId=" + encodeURIComponent(door)).then(function (got) {
    if (door !== directory.channelId) return;
    directory.progress = got;
    // A refresh reads again as many people as were showing, so a page somebody opened is not taken away.
    Object.keys(directory.shown).forEach(function (state) { if (directory.shown[state]) loadDirectoryProgressPeople(state, 0, directory.rows[state] ? directory.rows[state].people.length : 0); });
    if (next.view === "settings") render();
  }, function () {});
}
/** One state's people from offset, fifty at a time, until at least upTo are read. */
function loadDirectoryProgressPeople(state, offset, upTo, read) {
  var door = directory.channelId;
  getJson("/api/activations/progress?channelId=" + encodeURIComponent(door) + "&state=" + encodeURIComponent(state) + "&offset=" + offset).then(function (got) {
    if (door !== directory.channelId) return;
    var before = read || (offset > 0 && directory.rows[state] ? directory.rows[state].people : []), people = before.concat(got.people || []);
    if ((got.people || []).length > 0 && people.length < (upTo || 0) && people.length < got.total) { loadDirectoryProgressPeople(state, people.length, upTo, people); return; }
    directory.rows[state] = { total: got.total, people: people };
    if (next.view === "settings") render();
  }, failed);
}
/** Another door was chosen: nothing read or asked for the one before carries over. */
function directoryDoorChanged() { directory.open = {}; directory.people = {}; directory.progress = null; directory.shown = {}; directory.rows = {}; directory.ask = {}; }
/** The page's event stream: a computer an activation asked for moved, or its person was told. Re-read, at most once a second. */
var directoryProgressTimer = 0;
function directoryEvent(event) {
  if (!event || event.type !== "activation_progress" || directoryProgressTimer) return;
  directoryProgressTimer = setTimeout(function () { directoryProgressTimer = 0; if (next.view === "settings") loadDirectoryProgress(); }, 1000);
}

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
    loadDirectoryProgress();
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

/** A role for one person: any. For a department (bulk): never Admin, which is given one person at a time. */
function directoryRolePick(key, bulk) {
  var pick = selectOf(ROLES.filter(function (name) { return !bulk || name !== "admin"; }).map(function (name) { return [name, t("ui.next.team.role." + name)]; }), directory.role[key] || "driver");
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
  // The press asks first: what it would start, and the memory that asks of the cluster. Nothing happens until it is confirmed.
  go.addEventListener("click", function () {
    var role = directory.role[key] || "driver", door = directory.channelId, includeSub = !!directory.sub[node.vendorId];
    go.disabled = true;
    getJson("/api/activations/estimate?channelId=" + encodeURIComponent(door) + "&department=" + encodeURIComponent(node.vendorId) + "&includeSub=" + includeSub + "&role=" + role)
      .then(function (got) {
        if (door !== directory.channelId) return; // asked of another door: shown nowhere
        directory.ask[node.vendorId] = { estimate: got, role: role, channelId: door, includeSub: includeSub }; render();
      }, function (error) { go.disabled = false; failed(error); });
  });  var asking = directory.ask[node.vendorId];
  // What was shown is what is confirmed: an estimate for another door or another reach of the department is dropped, not sent.
  if (asking && (asking.channelId !== directory.channelId || asking.includeSub !== !!directory.sub[node.vendorId])) { delete directory.ask[node.vendorId]; asking = null; }
  if (asking) return departmentConfirm(node, asking);
  line.appendChild(directoryRolePick(key, true));
  if (node.total > node.direct) line.appendChild(subLabel);
  line.appendChild(go);
  return line;
}

/** What the press will do, said before it is done: people, computers, memory, who is out of quota. Confirm or cancel. */
function departmentConfirm(node, asking) {
  var box = el("div", "needbox"), acts = el("div", "acts"), e = asking.estimate, role = t("ui.next.team.role." + asking.role);
  var sure = el("button", "act-primary", t("ui.next.directory.estimateConfirm")), cancel = el("button", "act", t("ui.next.directory.estimateCancel"));
  box.setAttribute("data-directory", "estimate");
  box.appendChild(el("strong", "", !e.boxes ? t("ui.next.directory.estimateNone", { people: e.people, role: role })
    : e.memoryBytes === null ? t("ui.next.directory.estimateNoMemory", { people: e.people, role: role, boxes: e.boxes })
    : t("ui.next.directory.estimate", { people: e.people, role: role, boxes: e.boxes, memory: directoryGiB(e.memoryBytes), each: e.memoryRequest })));
  if (e.outOfQuota) box.appendChild(el("div", "why", t("ui.next.directory.estimateQuota", { n: e.outOfQuota })));
  cancel.addEventListener("click", function () { delete directory.ask[node.vendorId]; render(); });
  sure.addEventListener("click", function () {
    sure.disabled = true;
    postJson("/api/activations/department", { channelId: asking.channelId, department: node.vendorId, includeSub: asking.includeSub, role: asking.role, confirm: { boxes: e.boxes } })
      .then(function (got) {
        delete directory.ask[node.vendorId];
        directory.note = t("ui.next.directory.deptDone", { name: node.name || t("ui.next.directory.root"), n: got.activated, already: got.alreadyActive }); loadDirectory();
      }, function (error) { delete directory.ask[node.vendorId]; failed(error); loadDirectory(); });
  });
  acts.appendChild(cancel); acts.appendChild(sure); box.appendChild(acts);
  return box;
}

/** The computers made at activation, by state: a line of counts, each state opened to see its people. */
function directoryProgressBlock() {
  var data = directory.progress;
  if (!data || !data.latest) return null;
  var counts = data.counts || {}, open = (counts.starting || 0) + (counts.queued || 0) + (counts.failed || 0) + (data.notTold || 0);
  if (!open && Date.now() - Date.parse(data.latest) > 86400000) return null; // all done a day ago: nothing to watch
  var box = el("div", ""), states = ["starting", "queued", "failed", "quota", "ready", "not-told"];
  box.setAttribute("data-directory", "progress");
  box.appendChild(el("h3", "group", t("ui.next.directory.progress")));
  box.appendChild(el("p", "why", t("ui.next.directory.progressNote")));
  states.forEach(function (state) {
    var n = state === "not-told" ? data.notTold || 0 : counts[state] || 0;
    if (!n) return;
    var fold = el("details", "dept"), head = el("summary", ""), body = el("div", "dept-body");
    fold.setAttribute("data-progress", state);
    head.appendChild(el("strong", "", t("ui.next.directory.progress." + state, { n: n })));
    fold.appendChild(head); fold.open = !!directory.shown[state];
    fold.addEventListener("toggle", function () {
      if (fold.open === !!directory.shown[state]) return;
      directory.shown[state] = fold.open;
      if (fold.open) loadDirectoryProgressPeople(state, 0); else render();
    });
    if (!fold.open) { box.appendChild(fold); return; }
    if (state === "not-told") body.appendChild(el("p", "why", t("ui.next.directory.notToldNote")));
    if (state === "failed" || state === "not-told") body.appendChild(directoryAgain(state, undefined, state === "failed" ? t("ui.next.directory.retryFailed") : t("ui.next.directory.tellAgain")));
    var held = directory.rows[state];
    if (!held) body.appendChild(el("p", "why", t("ui.next.auto.reading")));
    (held ? held.people : []).forEach(function (person) {
      var line = el("div", "dept-row"), why = person.reason || (person.told && !person.told.delivered ? person.told.why : "");
      var who = el("div", "grow"); who.appendChild(el("div", "", person.name)); if (why) who.appendChild(el("div", "why", why)); // the reason under the name, so the button stays on its row
      line.appendChild(who);
      if (state === "failed" || state === "not-told") line.appendChild(directoryAgain(state, person.subject, state === "failed" ? t("ui.next.directory.retryOne") : t("ui.next.directory.tellAgain")));
      body.appendChild(line);
    });
    if (held && held.people.length < held.total) {
      var more = el("button", "act", t("ui.next.directory.more", { n: held.total - held.people.length }));
      more.addEventListener("click", function () { more.disabled = true; loadDirectoryProgressPeople(state, held.people.length); });
      body.appendChild(more);
    }
    fold.appendChild(body); box.appendChild(fold);
  });
  return box;
}

/** Again, for one person or for all of a state: retry the failed computers, or tell the people not told. */
function directoryAgain(state, subject, label) {
  var go = el("button", "act", label);
  go.addEventListener("click", function () {
    go.disabled = true;
    postJson(state === "failed" ? "/api/activations/retry-boxes" : "/api/activations/tell", subject ? { channelId: directory.channelId, subject: subject } : { channelId: directory.channelId })
      .then(function (got) {
        directory.note = state === "failed" ? t("ui.next.directory.retried", { n: got.retried }) : t("ui.next.directory.toldAgain", { told: got.told, left: got.notTold });
        loadDirectoryProgress();
      }, function (error) { go.disabled = false; failed(error); });
  });
  return go;
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
    pick.addEventListener("change", function () { directory.channelId = pick.value; directoryDoorChanged(); loadDirectory(); });
    line.appendChild(pick);
  }
  line.appendChild(el("span", "why", when));
  sync.addEventListener("click", function () {
    sync.disabled = true; sync.textContent = t("ui.next.directory.syncing");
    postJson("/api/directories/sync", { channelId: data.channelId }).then(function (got) {
      directory.note = got.held ? t("ui.next.directory.syncedHeld", { n: got.held }) : got.left ? t("ui.next.directory.syncedLeft", { n: got.left }) : t("ui.next.directory.syncedNow");
      loadDirectory(); loadPeople();
    }, function (error) { failed(error); loadDirectory(); });
  });
  line.appendChild(sync);
  return line;
}

/** A sync that was not believed: who it would have signed out, and the Admin's two answers. Nothing has changed yet. */
function heldSyncBox(held) {
  var box = el("div", "needbox"), names = held.people.map(function (person) { return person.name; }), acts = el("div", "acts");
  var yes = el("button", "act", t("ui.next.directory.heldConfirm")), no = el("button", "act", t("ui.next.directory.heldDismiss"));
  var answer = function (path, note) {
    return function () { postJson(path, { channelId: directory.channelId }).then(function (got) { directory.note = note(got); loadDirectory(); loadPeople(); }, function (error) { failed(error); loadDirectory(); }); };
  };
  box.setAttribute("data-directory", "held");
  box.appendChild(el("strong", "", t("ui.next.directory.held", { n: names.length })));
  box.appendChild(el("div", "", t("ui.next.directory.held." + held.reason)));
  box.appendChild(el("div", "why", names.slice(0, 20).join(", ") + (names.length > 20 ? " " + t("ui.next.directory.heldMore", { n: names.length - 20 }) : "")));
  yes.addEventListener("click", function () {
    var sure = el("button", "act-danger", t("ui.next.directory.heldConfirmSure", { n: names.length }));
    sure.addEventListener("click", function () { sure.disabled = true; answer("/api/activations/held/confirm", function (got) { return t("ui.next.directory.heldDone", { n: got.left }); })(); });
    yes.replaceWith(sure);
  });
  no.addEventListener("click", answer("/api/activations/held/dismiss", function () { return ""; }));
  acts.appendChild(no); acts.appendChild(yes); box.appendChild(acts);
  return box;
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
  if (data.held) box.appendChild(heldSyncBox(data.held));
  (data.unlisted || []).forEach(function (person) { box.appendChild(el("div", "needbox", t("ui.next.directory.lastAdminKept", { name: person.name }))); });
  if (requests) box.appendChild(requests);
  var progressNow = directoryProgressBlock(); if (progressNow) box.appendChild(progressNow);
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
