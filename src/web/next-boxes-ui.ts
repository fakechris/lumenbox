/**
 * The computers agents live on (INV-1825).
 *
 * A person organises agents by the computer they are on, so the computers are named at the top of the
 * agent list — and when the one being looked at is not running, that is said right there, with the
 * button that starts it. This view is the rest: every computer this person may see, whether it is
 * reachable, how many agents it holds, and removing one that was attached.
 */
export const NEXT_BOXES_JS = `
var boxes = { list: [], own: "", starting: false, state: null, log: [], failed: "", personal: {}, computerBusy: false, computerRequest: "" };

function boxById(id) { return boxes.list.filter(function (box) { return box.id === id; })[0]; }

/**
 * Starting this installation's own computer. The first time it downloads an image, which takes
 * minutes: what Docker says is shown as it comes (the "box_setup" events), and the end of it — up,
 * or the line it failed on — is what replaces "starting".
 */
function startBox() {
  if (!canOperateInstallation()) return;
  if (boxes.starting || ownCannotStart()) return;
  boxes.starting = true; boxes.log = []; boxes.failed = ""; render();
  postJson("/api/box/up", {}).then(function (got) {
    // Already up: there will be no events to wait for.
    if (got && got.ok) { boxes.starting = false; refresh(); }
  }, function (error) {
    // Somebody already started it: the same events are on their way.
    if (error.data && error.data.code === "box-starting") return;
    boxes.starting = false; boxes.failed = error.message; render();
  });
}
function boxSetupEvent(event) {
  if (!event || event.type !== "box_setup") return;
  var changed = boxes.starting === !!event.done;
  boxes.starting = !event.done;
  if (event.line) boxes.log = boxes.log.concat([String(event.line)]).slice(-200);
  if (event.done) { boxes.failed = event.ok ? "" : String(event.line || ""); refresh(); }
  var log = document.querySelector("#agents .box-log"); // drawn under the sandbox's heading only while starting (first-screen-ui.ts)
  if (!changed && log) { log.textContent = boxes.log.slice(-8).join(String.fromCharCode(10)); log.scrollTop = log.scrollHeight; } else render();
}

function podUnreachable(detail) {
  return t("ui.next.box.podUnreachable", { why: detail || t("ui.next.box.healthPending") });
}

function personalBoxRetry(id, onRetried) {
  var retry = el("button", "act", t("ui.next.boxset.retryConnection"));
  retry.addEventListener("click", function () {
    retry.disabled = true;
    return postJson("/api/personal-boxes/retry", { id: id }).then(function () {
      retry.disabled = false;
      if (onRetried) onRetried();
      refreshSoon();
    }, function (error) { retry.disabled = false; failed(error); });
  });
  return retry;
}

/** On Kubernetes the installation's own computer is started by nobody here: it is listed only as an attached node, and offered no start (INV-2310). */
function ownCannotStart() { return !!(boxes.state && boxes.state.backend === "kubernetes"); }

/**
 * Who else is in the sandbox being looked at, beside the agents. Why a sandbox is not ready, and its one button, is
 * under its heading (sandboxWhy, first-screen-ui.ts).
 */
function boxNotice() {
  var box = boxById(chat.box), members = $("box-members");
  // Nobody shares the desktop's one sandbox: it is the Owner's (docs/112 §1), so it names no members.
  if (box && box.members === "everyone" && box.membersLabel && isOrganisation()) {
    if (members.dataset.label !== box.membersLabel) { members.replaceChildren(boxMembers(box)); members.dataset.label = box.membersLabel; }
  } else { members.replaceChildren(); delete members.dataset.label; }
  members.hidden = !members.firstChild;
}

function boxMembers(box) {
  if (box.members !== "everyone") return el("div", "why", box.membersLabel);
  var details = el("details", "box-members");
  details.dataset.boxId = box.id;
  details.appendChild(el("summary", "", t("ui.access.shared")));
  details.appendChild(el("div", "", box.membersLabel));
  return details;
}

function renderBoxes(view) {
  renderPersonalComputers(view);
  var managed = (boxes.personal.mine || {}).boxes || [];
  var inventory = boxes.personal.inventory;
  if (inventory) managed = inventory.boxes;
  var list = el("div", "list"), admin = canOperateInstallation();
  boxes.list.forEach(function (box) {
    if (managed.some(function (item) { return item.id === box.id; })) return;
    var row = el("div", "row"), body = el("div", "body");
    body.appendChild(el("div", "title", box.name));
    body.appendChild(el("div", "why", [box.kind, t("ui.next.box.agents", { n: box.agents || 0 }), box.version || ""].filter(Boolean).join(" · ")));
    if (box.membersLabel) body.appendChild(boxMembers(box));
    row.appendChild(el("span", "who", initial(box.name)));
    row.appendChild(body);
    row.appendChild(el("span", box.connected ? "chip-run" : "chip", t(box.connected ? "ui.next.box.on" : "ui.next.box.off")));
    if (admin && !box.connected && box.id === boxes.own && !ownCannotStart()) {
      var start = el("button", "act", t(boxes.starting ? "ui.next.box.starting" : "ui.next.box.start"));
      start.disabled = boxes.starting; start.addEventListener("click", startBox);
      row.appendChild(start);
      if (boxes.failed) body.appendChild(el("div", "why", boxes.failed));
    }
    if (!box.connected && box.kind === "kubernetes" && box.id !== boxes.own) body.appendChild(el("div", "why", podUnreachable(box.detail)));
    if (admin && !box.personal && box.id !== boxes.own && box.kind !== "kubernetes" && !(box.agents > 0)) {
      var remove = el("button", "act", t("ui.next.box.remove"));
      remove.addEventListener("click", function () {
        var confirm = el("button", "act-danger", t("ui.next.box.removeConfirm"));
        confirm.addEventListener("click", function () { postJson("/api/boxes/detach", { name: box.id }).then(function () { refresh(); }, failed); });
        remove.replaceWith(confirm);
      });
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
  view.appendChild(list);
  if (!admin) return;
  var more = el("section", "setting"), link = el("button", "act", t("ui.next.box.addOpen"));
  link.addEventListener("click", function () { openSettingsPane("boxes"); });
  more.appendChild(el("h2", "group", t("ui.next.box.add")));
  more.appendChild(el("p", "", t("ui.next.box.addNote")));
  more.appendChild(link);
  view.appendChild(more);
}

function runComputer(path, body, created) {
  if (boxes.computerBusy) return;
  boxes.computerBusy = true; render();
  postJson("/api/personal-boxes/" + path, body).then(function () {
    if (created) boxes.computerRequest = "";
  }, failed).finally(function () { boxes.computerBusy = false; refresh(); });
}

function editComputerName(title, value, save) {
  computerDialog(title, function (body, action) {
    var name = el("input"); name.value = value; name.maxLength = 100;
    name.setAttribute("aria-label", t("ui.personal.name"));
    body.appendChild(labelled(t("ui.personal.name"), name));
    var button = action(t("ui.personal.saveName"), false, function (close) {
      if (name.value.trim()) { close(); save(name.value.trim()); }
    });
    name.addEventListener("input", function () { button.disabled = !name.value.trim(); });
    name.addEventListener("keydown", function (event) { if (event.key === "Enter") button.click(); });
  });
}

function computerText(tag, className, text) {
  var node = el(tag, className, text);
  node.style.whiteSpace = "normal";
  node.style.overflowWrap = "anywhere";
  return node;
}

function computerRow(box, mine, people, locked) {
  var row = el("div", "row"), body = el("div", "body"), acts = el("div", "acts");
  row.style.display = "grid";
  row.style.gridTemplateColumns = "minmax(0, 1fr) auto";
  acts.style.gridColumn = "1 / -1";
  acts.style.flexWrap = "wrap";
  var metadata = [t("ui.personal.created", { date: new Date(box.createdAt).toLocaleString() }), t("ui.personal.image", { image: box.image || t("ui.personal.unknown") })];
  if (!mine) metadata.unshift(t(box.orphaned ? "ui.personal.formerOwner" : "ui.personal.owner", { name: box.ownerName }));
  body.appendChild(computerText("div", "title", box.name));
  body.appendChild(computerText("div", "why", metadata.join(" · ")));
  if (box.podStatus) body.appendChild(computerText("div", "why", box.podStatus));
  if (box.error || box.status === "unreachable") body.appendChild(computerText("div", "why", box.error || podUnreachable(box.connectionError)));
  var asked = box.transferAsked;
  if (asked && !mine) body.appendChild(computerText("div", "why", t("ui.personal.transferWaiting", { owner: box.ownerName, to: asked.toName })));
  if (asked && mine) body.appendChild(computerText("div", "why", t("ui.personal.transferAskedOfYou", { to: asked.toName })));
  if (box.handedFrom && mine) body.appendChild(computerText("div", "why", t("ui.personal.handedFrom", { name: box.handedFrom.name })));
  var statusLabel = box.status === "unreachable" ? t("ui.next.box.off") : t("ui.personal.state." + box.status);
  row.appendChild(body); row.appendChild(el("span", box.status === "ready" ? "chip-run" : "chip", statusLabel));
  function button(label, run, danger) {
    var control = el("button", danger ? "act-danger" : "act", label);
    control.disabled = boxes.computerBusy; control.addEventListener("click", run); acts.appendChild(control);
  }
  function act(action, extra) {
    var data = Object.assign({ id: box.id }, extra || {});
    if (!mine) data.action = action;
    runComputer(mine ? action : "admin", data);
  }
  if (asked && mine) {
    button(t("ui.personal.transferAgree"), function () { runComputer("transfer-answer", { id: box.id, agree: true }); });
    button(t("ui.personal.transferDecline"), function () { runComputer("transfer-answer", { id: box.id, agree: false }); });
  }
  if (["ready", "unreachable", "detached", "failed"].indexOf(box.status) >= 0 || (box.status === "interrupted" && !box.pendingRemoval)) {
    if (mine && !locked) button(t("ui.personal.rename"), function () {
      editComputerName(t("ui.personal.rename"), box.name, function (name) { act("rename", { name: name }); });
    });
    if (!mine) button(t("ui.personal.transfer"), function () {
      computerDialog(t("ui.personal.transfer"), function (form, action) {
        var recipient = el("select"), reason = el("input"); computerRecipients(recipient, people, box.orphaned ? "" : box.owner);
        reason.maxLength = 300;
        form.appendChild(labelled(t("ui.personal.selectRecipient"), recipient));
        form.appendChild(labelled(t("ui.personal.transferReason"), reason));
        // What a transfer means, before it is confirmed (INV-2298): the owner is asked while they can sign in; their sign-ins go with it.
        if (box.ownerCanSignIn) form.appendChild(computerText("p", "why", t("ui.personal.transferAsks", { owner: box.ownerName })));
        form.appendChild(computerText("p", "why", t("ui.personal.transferSignIns", { owner: box.ownerName })));
        var apply = action(t("ui.personal.transfer"), false, function (close) { if (recipient.value) { close(); act("transfer", { recipient: recipient.value, reason: reason.value }); } });
        apply.disabled = true;
        recipient.addEventListener("change", function () { apply.disabled = !recipient.value; });
      });
    });
    if (box.status !== "detached") button(t("ui.personal.keep"), function () { act(mine ? "remove" : "keep", mine ? { deleteData: false, deleteAgents: false } : {}); });
    button(t("ui.personal.delete"), function () {
      deleteComputerDialog(box, function (agentIds) {
        act(mine ? "remove" : "delete", mine ? { deleteData: true, deleteAgents: agentIds.length > 0, agentIds: agentIds } : { deleteAgents: true, agentIds: agentIds });
      });
    }, true);
  }
  if (["unreachable", "detached", "failed", "interrupted", "deleting"].indexOf(box.status) >= 0 && !locked && (!box.orphaned || box.pendingRemoval))
    button(t(box.status === "unreachable" ? "ui.next.boxset.retryConnection" : "ui.personal.restore"), function () { act(mine ? "retry" : "recover"); });
  if (acts.childElementCount) row.appendChild(acts);
  return row;
}

function renderPersonalComputers(view) {
  var mine = boxes.personal.mine, inventory = boxes.personal.inventory;
  if (mine && (mine.canCreate || mine.boxes.length)) {
    var own = el("section", "setting"), create = el("button", "act-primary", t("ui.personal.create")), list = el("div", "list");
    var full = mine.quota !== null && mine.held >= mine.quota;
    own.appendChild(el("h2", "group", t("ui.personal.mine")));
    own.appendChild(el("p", "why", computerQuota(mine)));
    if (full) own.appendChild(computerText("p", "why", t("ui.personal.full")));
    if (mine.auto && mine.auto.state === "preparing") own.appendChild(computerText("p", "why", t("ui.personal.preparing")));
    create.disabled = !mine.canCreate || full || boxes.computerBusy;
    create.addEventListener("click", function () {
      editComputerName(t("ui.personal.create"), t("ui.personal.defaultName", { name: mine.name }), function (name) {
        if (!boxes.computerRequest) boxes.computerRequest = personalComputerRequestId();
        runComputer("create", { requestId: boxes.computerRequest, name: name }, true);
      });
    });
    own.appendChild(create);
    if (boxes.computerBusy) own.appendChild(el("p", "why", t("ui.personal.working")));
    mine.boxes.forEach(function (box) { list.appendChild(computerRow(box, true, [], !mine.canCreate)); });
    own.appendChild(list); view.appendChild(own);
  }
  if (!inventory) return;
  var teamBoxes = el("section", "setting"), allocations = el("div", "acts"), list2 = el("div", "list");
  allocations.style.flexWrap = "wrap";
  teamBoxes.appendChild(el("h2", "group", t("ui.personal.team")));
  inventory.people.forEach(function (person) {
    allocations.appendChild(el("span", "chip", [person.name, computerQuota(person)].concat(person.waitingForQuota ? [t("ui.personal.waiting")] : []).join(" · ")));
  });
  teamBoxes.appendChild(allocations);
  if (!inventory.boxes.length) list2.appendChild(el("p", "why", t("ui.personal.none")));
  inventory.boxes.forEach(function (box) { list2.appendChild(computerRow(box, false, inventory.people, false)); });
  teamBoxes.appendChild(list2); view.appendChild(teamBoxes);
}
`;
