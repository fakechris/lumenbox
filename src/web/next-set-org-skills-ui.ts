/**
 * Settings → Team → Organisation skills (INV-2222, docs/109 §6): what the organisation has
 * published, each with its version, who published it and when, and whether it is required; how many
 * boxes hold what the library says and which are behind, offline, or were changed from inside;
 * and publishing, updating, withdrawing and marking required. An Admin's block, on an organisation only.
 *
 * A skill is published from a folder on the Admin's computer, from a template file, or from a box
 * the Admin may enter. Publishing a name already there is an update. Nothing here is typed as
 * text: a skill is its files.
 */
export const NEXT_SET_ORG_SKILLS_CSS = `
[data-org-skills] p.why { white-space: normal; } [data-org-skills] .dept-row > label { flex: 1; min-width: 200px; }
`;

export const NEXT_SET_ORG_SKILLS_JS = `
var orgSkills = { data: null, loading: false, from: "folder", box: "", boxSkills: null, template: null, note: "" };

function loadOrgSkills() {
  if (orgSkills.loading) return;
  orgSkills.loading = true;
  getJson("/api/org-skills").then(function (got) { orgSkills.data = got; }, function () { orgSkills.data = false; })
    .then(function () { orgSkills.loading = false; if (next.view === "settings") render(); });
}
function keepOrgSkills(got) { orgSkills.data = got; orgSkills.note = ""; render(); }
function orgSkillsRefused(error) { orgSkills.note = error && error.message ? error.message : String(error); render(); }

/** A folder picked on this computer, as a skill's files: the folder's own name dropped, hidden files and anything that is not text left out. */
function readSkillFolder(list) {
  var picked = Array.prototype.filter.call(list, function (file) { return !/(^|\\/)\\./.test(file.webkitRelativePath || file.name); });
  return Promise.all(picked.map(function (file) {
    return file.text().then(function (text) { return [(file.webkitRelativePath || file.name).split("/").slice(1).join("/") || file.name, text]; });
  })).then(function (pairs) {
    var files = {};
    pairs.forEach(function (pair) { if (pair[1].indexOf("\\u0000") < 0) files[pair[0]] = pair[1]; });
    return files;
  });
}

function publishOrgSkill(body, button) {
  button.disabled = true;
  postJson("/api/org-skills/publish", body).then(function (got) {
    toast(t("ui.next.orgSkills.published", { name: got.published }));
    orgSkills.template = null; keepOrgSkills(got); setTimeout(loadOrgSkills, 4000);
  }, function (error) { button.disabled = false; orgSkillsRefused(error); });
}

/** Where a new skill, or a new version of one, comes from. */
function orgSkillPublishForm() {
  var form = el("div", "fold-body"), from = selectOf([["folder", t("ui.next.orgSkills.fromFolder")], ["template", t("ui.next.orgSkills.fromTemplate")], ["box", t("ui.next.orgSkills.fromBox")]], orgSkills.from);
  var go = el("button", "act-primary", t("ui.next.orgSkills.publish")), line = el("div", "dept-row"), sources = (orgSkills.data || {}).sources || [];
  from.setAttribute("aria-label", t("ui.next.orgSkills.from"));
  from.addEventListener("change", function () { orgSkills.from = from.value; orgSkills.note = ""; render(); });
  line.appendChild(from);
  if (orgSkills.from === "folder") {
    var folder = el("input"); folder.type = "file"; folder.multiple = true; folder.setAttribute("webkitdirectory", ""); folder.setAttribute("aria-label", t("ui.next.orgSkills.fromFolder"));
    go.addEventListener("click", function () {
      if (!folder.files || !folder.files.length) { orgSkillsRefused(new Error(t("ui.next.orgSkills.pickFolder"))); return; }
      readSkillFolder(folder.files).then(function (files) { publishOrgSkill({ files: files }, go); });
    });
    line.appendChild(folder);
  } else if (orgSkills.from === "template") {
    var file = el("input"); file.type = "file"; file.accept = ".json,application/json"; file.setAttribute("aria-label", t("ui.next.orgSkills.fromTemplate"));
    file.addEventListener("change", function () {
      if (!file.files || !file.files[0]) return;
      file.files[0].text().then(function (text) { orgSkills.template = JSON.parse(text); orgSkills.note = ""; }).catch(function () { orgSkills.template = null; orgSkills.note = t("ui.next.orgSkills.notTemplate"); }).then(render);
    });
    line.appendChild(file);
    if (orgSkills.template) {
      var which = selectOf(((orgSkills.template.skills || []).map(function (skill) { return [skill.slug, skill.name || skill.slug]; })), "");
      which.setAttribute("aria-label", t("ui.next.orgSkills.whichSkill"));
      go.addEventListener("click", function () { publishOrgSkill({ template: orgSkills.template, skill: which.value }, go); });
      line.appendChild(which);
    } else go.disabled = true;
  } else {
    var boxPick = selectOf([["", t("ui.next.orgSkills.pickBox")]].concat(sources.map(function (box) { return [box.id, box.name]; })), orgSkills.box);
    boxPick.setAttribute("aria-label", t("ui.next.orgSkills.fromBox"));
    boxPick.addEventListener("change", function () {
      orgSkills.box = boxPick.value; orgSkills.boxSkills = null; render();
      if (boxPick.value) getJson("/api/org-skills/box?box=" + encodeURIComponent(boxPick.value)).then(function (got) { orgSkills.boxSkills = got.skills || []; render(); }, orgSkillsRefused);
    });
    line.appendChild(boxPick);
    if (orgSkills.box && orgSkills.boxSkills) {
      var skillPick = selectOf(orgSkills.boxSkills.map(function (slug) { return [slug, slug]; }), "");
      skillPick.setAttribute("aria-label", t("ui.next.orgSkills.whichSkill"));
      go.addEventListener("click", function () { publishOrgSkill({ box: orgSkills.box, skill: skillPick.value }, go); });
      line.appendChild(skillPick);
      if (!orgSkills.boxSkills.length) go.disabled = true;
    } else go.disabled = true;
  }
  line.appendChild(go);
  form.appendChild(line);
  form.appendChild(el("p", "why", t("ui.next.orgSkills.publishNote")));
  return form;
}

function orgSkillRow(skill) {
  var fold = el("details", "fold"), head = el("summary", ""), body = el("div", "fold-body"), acts = el("div", "dept-row");
  var need = el("label", ""), box = el("input"), gone = el("button", "act", t("ui.next.orgSkills.withdraw"));
  head.appendChild(el("span", "", skill.name + " · v" + skill.version + " · " + skill.byName + " · " + agoText(skill.at)));
  if (skill.required) { var chip = el("span", "chip", t("ui.next.orgSkills.required")); chip.classList.add("need"); head.appendChild(document.createTextNode(" ")); head.appendChild(chip); }
  fold.setAttribute("data-org-skill", skill.slug);
  fold.appendChild(head);
  body.appendChild(el("p", "why", skill.description));
  body.appendChild(el("p", "why", t("ui.next.orgSkills.files", { slug: skill.slug, files: (skill.files || []).join(", "), source: skill.source })));
  box.type = "checkbox"; box.checked = !!skill.required;
  box.addEventListener("change", function () { postJson("/api/org-skills/require", { slug: skill.slug, required: box.checked }).then(keepOrgSkills, orgSkillsRefused); });
  need.appendChild(box); need.appendChild(document.createTextNode(" " + t("ui.next.orgSkills.requireLabel")));
  var sure = false;
  gone.addEventListener("click", function () {
    if (!sure) { sure = true; gone.textContent = t("ui.next.orgSkills.withdrawSure", { name: skill.name }); return; }
    gone.disabled = true;
    postJson("/api/org-skills/withdraw", { slug: skill.slug }).then(function (got) { toast(t("ui.next.orgSkills.withdrawn", { name: skill.name })); keepOrgSkills(got); setTimeout(loadOrgSkills, 4000); }, orgSkillsRefused);
  });
  acts.appendChild(need); acts.appendChild(gone);
  body.appendChild(acts);
  fold.appendChild(body);
  return fold;
}

/** Which boxes hold what the library says: the count, and by name every box that does not, with why. */
function orgSkillBoxes(boxes) {
  var part = el("div", ""), again = el("button", "act", t("ui.next.orgSkills.lookAgain")), line = el("div", "dept-row");
  line.appendChild(el("span", "grow", t("ui.next.orgSkills.boxes", { current: boxes.current, behind: boxes.behind, offline: boxes.offline })));
  again.addEventListener("click", function () { again.disabled = true; postJson("/api/org-skills/sync", {}).then(keepOrgSkills, orgSkillsRefused); });
  line.appendChild(again);
  part.setAttribute("data-org-skills", "boxes");
  part.appendChild(line);
  (boxes.each || []).forEach(function (box) {
    if (box.state === "current" && !(box.drift || []).length) return;
    var text = box.name + " — " + t("ui.next.orgSkills.state." + box.state) + (box.error ? ": " + box.error : "");
    if ((box.drift || []).length) text += (box.state === "current" ? " — " : "; ") + t("ui.next.orgSkills.drift", { paths: box.drift.join(", ") });
    part.appendChild(el("p", "why", text));
  });
  return part;
}

function orgSkillsBlock() {
  if ((team.installation || {}).mode === "single-machine" || !canOperateInstallation()) return null;
  if (orgSkills.data === null) { loadOrgSkills(); return null; }
  if (orgSkills.data === false) return null;
  var box = el("section", "setting"), skills = orgSkills.data.skills || [], add = el("details", "fold");
  box.setAttribute("data-org-skills", "library");
  box.appendChild(el("h2", "group", t("ui.next.orgSkills.title")));
  box.appendChild(el("p", "why", t("ui.next.orgSkills.note")));
  if (!skills.length) box.appendChild(el("p", "empty", t("ui.next.orgSkills.none")));
  skills.forEach(function (skill) { box.appendChild(orgSkillRow(skill)); });
  if (skills.length) box.appendChild(orgSkillBoxes(orgSkills.data.boxes || {}));
  add.open = !skills.length || !!orgSkills.note || orgSkills.from !== "folder" || !!orgSkills.template;
  add.appendChild(el("summary", "", t("ui.next.orgSkills.add")));
  add.appendChild(orgSkillPublishForm());
  box.appendChild(add);
  if (orgSkills.note) { var note = el("p", "why", orgSkills.note); note.setAttribute("role", "alert"); note.setAttribute("data-org-skills", "note"); box.appendChild(note); }
  return box;
}
`;
