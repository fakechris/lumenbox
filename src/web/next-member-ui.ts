/**
 * An agent's own page in the rebuilt view (INV-1825): who it is, what it may use, and the few things
 * a person does to an agent — rename it, change what it is for, pause it, let it go. Also how a new
 * one is made. Opened from the agent's name; never part of the default surface.
 */
export const NEXT_MEMBER_JS = `
var member = { id: "", creating: false, paused: {}, allTools: [] };

function field(labelText, value, multiline) {
  var label = el("label", "", labelText), input = el(multiline ? "textarea" : "input");
  input.value = value || "";
  label.appendChild(input);
  return { label: label, input: input };
}

function toolPicker(selected) {
  var box = el("div", "toolgrid"), boxes = [];
  member.allTools.forEach(function (name) {
    var label = el("label", "tool"), check = el("input");
    check.type = "checkbox"; check.value = name; check.checked = selected === null || selected === undefined || selected.indexOf(name) >= 0;
    label.appendChild(check); label.appendChild(document.createTextNode(" " + name));
    boxes.push(check); box.appendChild(label);
  });
  return { node: box, value: function () { return boxes.filter(function (check) { return check.checked; }).map(function (check) { return check.value; }); } };
}

function renderMember() {
  var inner = $("member-inner"), agent = member.creating ? { name: "", title: "", description: "", tools: null } : next.agents[member.id];
  inner.replaceChildren();
  if (!agent) { closeMember(); return; }
  $("member-title").textContent = member.creating ? t("ui.next.member.new") : agent.name;
  var form = el("div", "setting"), name = field(t("ui.next.member.name"), agent.name), title = field(t("ui.next.member.role"), agent.title), persona = field(t("ui.next.member.persona"), agent.description, true);
  var tools = toolPicker(agent.tools), save = el("button", "act-primary", t(member.creating ? "ui.next.member.create" : "ui.next.settings.save"));
  [name, title, persona].forEach(function (row) { form.appendChild(row.label); });
  var toolsBox = el("details", "fold");
  toolsBox.appendChild(el("summary", "", t("ui.next.member.tools")));
  toolsBox.appendChild(tools.node);
  form.appendChild(toolsBox);
  save.addEventListener("click", function () {
    var body = { name: name.input.value.trim(), title: title.input.value.trim(), description: persona.input.value, tools: tools.value() };
    if (!body.name) { name.input.focus(); return; }
    var sent = member.creating ? postJson("/api/agents", Object.assign({ boxId: chat.box || undefined }, body)) : postJson("/api/agents/update", Object.assign({ id: member.id }, body));
    sent.then(function (got) {
      toast(t(member.creating ? "ui.next.member.created" : "ui.next.settings.saved2"));
      var opened = member.creating && got && got.id ? got.id : member.id;
      closeMember();
      refresh().then(function () { if (opened) openChat(opened); });
    }, failed);
  });
  form.appendChild(save);
  inner.appendChild(form);
  if (member.creating) return;
  var acts = el("div", "foot-links"), isPaused = !!member.paused[member.id];
  var pause = el("button", "", t(isPaused ? "ui.next.member.resume" : "ui.next.member.pause"));
  pause.addEventListener("click", function () {
    postJson(isPaused ? "/api/agents/resume" : "/api/agents/pause", { id: member.id }).then(function () { loadPauses(); refreshSoon(); }, failed);
  });
  var remove = el("button", "", t("ui.next.member.delete"));
  remove.addEventListener("click", function () {
    var confirm = el("button", "act-danger", t("ui.next.member.deleteConfirm"));
    confirm.addEventListener("click", function () {
      postJson("/api/agents/delete", { id: member.id }).then(function () { toast(t("ui.next.member.deleted")); chat.agentId = ""; closeMember(); refresh(); }, failed);
    });
    acts.replaceChildren(el("span", "", t("ui.next.member.deleteNote")), confirm);
  });
  acts.appendChild(pause); acts.appendChild(remove);
  if (isPaused) inner.appendChild(el("div", "needbox", t("ui.next.member.pausedNote", { reason: member.paused[member.id].reason || "" })));
  inner.appendChild(acts);
}

/** Who is paused: an admin's read; for anybody else there is simply nothing to show. */
function loadPauses() {
  getJson("/api/agents/pauses").then(function (got) { member.paused = got.paused || {}; if (!$("member").hidden) renderMember(); renderSide(); }, function () {});
}

function openMember(agentId) {
  member.id = agentId || ""; member.creating = !agentId;
  $("member").hidden = false; $("scrim").hidden = false;
  renderMember();
}
function closeMember() { $("member").hidden = true; if ($("panel").hidden) $("scrim").hidden = true; }

function memberStart() {
  $("member-close").addEventListener("click", closeMember);
  $("scrim").addEventListener("click", closeMember);
  $("agent-new").addEventListener("click", function () { openMember(""); });
  $("view-title").addEventListener("click", function () { if (next.view === "chat" && chat.agentId) openMember(chat.agentId); });
  loadPauses();
}
`;
