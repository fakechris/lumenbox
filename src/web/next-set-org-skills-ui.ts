/**
 * Settings → Team → Organisation skills (INV-2222, docs/109 §6): what the organisation has
 * published, each with its version, who published it and when, and whether it is required; how many
 * boxes hold what the library says and which are behind, offline, or were changed from inside;
 * and publishing, updating, withdrawing and marking required. An Admin's block, on an organisation only.
 *
 * A skill is published from a folder on the Admin's computer, from a template file, or from a box
 * the Admin may enter. Publishing a name already there is an update. Nothing here is typed as
 * text: a skill is its files.
 *
 * What members offered waits here too, each with its files as they would be published, what the
 * checks say of them and the warnings about where its install goes; Approve publishes it as the
 * Admin's act, Decline asks for the reason the member reads. A member offers from Settings → Mine
 * (`offerSkillBlock`), and reads there what became of each offer.
 */
export const NEXT_SET_ORG_SKILLS_CSS = `
[data-org-skills] p.why { white-space: normal; } [data-org-skills] .dept-row > label { flex: 1; min-width: 200px; }
`;

export const NEXT_SET_ORG_SKILLS_JS = `
var orgSkills = { data: null, loading: false, from: "folder", box: "", boxSkills: null, template: null, note: "", offers: null, declining: "" };

function loadOrgSkills() {
  if (orgSkills.loading) return;
  orgSkills.loading = true;
  getJson("/api/org-skills").then(function (got) { orgSkills.data = got; }, function () { orgSkills.data = false; })
    .then(function () { return getJson("/api/org-skills/offers").then(function (got) { orgSkills.offers = got.offers || []; }, function () { orgSkills.offers = []; }); })
    .then(function () { orgSkills.loading = false; if (next.view === "settings") render(); });
}
/** What the Admin is told with a publish: where an install looks to land outside what a box keeps. */
function warnOf(got) { if (got && got.warnings && got.warnings.length) orgSkills.note = t("ui.next.orgSkills.warned") + " " + got.warnings.join(" "); }
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
    orgSkills.template = null; keepOrgSkills(got); warnOf(got); render(); setTimeout(loadOrgSkills, 4000);
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
  (skill.warnings || []).forEach(function (line) { var w = el("p", "why", line); w.setAttribute("data-org-skill-warning", ""); body.appendChild(w); });
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

/** One offer a member made, as the Admin decides it: the files in full, the checks, and the two answers. */
function orgOfferRow(offer) {
  var fold = el("details", "fold"), body = el("div", "fold-body"), acts = el("div", "dept-row");
  fold.setAttribute("data-org-offer", offer.id);
  fold.appendChild(el("summary", "", t("ui.next.orgSkills.offerHead", { name: offer.name, who: offer.byName, when: agoText(offer.at) })));
  body.appendChild(el("p", "why", offer.description));
  if (offer.replaces) body.appendChild(el("p", "why", t("ui.next.orgSkills.offerReplaces", { version: offer.replaces })));
  body.appendChild(el("p", "why", offer.check && offer.check.ok ? t("ui.next.orgSkills.offerChecked") : t("ui.next.orgSkills.offerRefused", { why: (offer.check || {}).why || "" })));
  (offer.warnings || []).forEach(function (line) { body.appendChild(el("p", "why", line)); });
  Object.keys(offer.content || {}).sort().forEach(function (path) {
    var file = el("details", "fold"); file.appendChild(el("summary", "", path));
    var pre = el("pre", "", offer.content[path]); pre.style.whiteSpace = "pre-wrap"; pre.style.maxHeight = "240px"; pre.style.overflow = "auto";
    file.appendChild(pre); body.appendChild(file);
  });
  var yes = el("button", "act-primary", t("ui.next.orgSkills.approve")), no = el("button", "act", t("ui.next.orgSkills.decline"));
  yes.disabled = !(offer.check && offer.check.ok);
  var decide = function (decision, reason) {
    postJson("/api/org-skills/offers/decide", { id: offer.id, decision: decision, reason: reason || "" }).then(function (got) {
      toast(t(decision === "approved" ? "ui.next.orgSkills.approved" : "ui.next.orgSkills.declined", { name: offer.name }));
      orgSkills.declining = ""; keepOrgSkills(got); loadOrgSkills();
    }, orgSkillsRefused);
  };
  yes.addEventListener("click", function () { yes.disabled = true; decide("approved"); });
  if (orgSkills.declining === offer.id) {
    var why = el("input"), send = el("button", "act", t("ui.next.orgSkills.declineSend"));
    why.setAttribute("aria-label", t("ui.next.orgSkills.declineWhy")); why.placeholder = t("ui.next.orgSkills.declineWhy");
    send.addEventListener("click", function () { if (why.value.trim()) decide("declined", why.value.trim()); });
    acts.appendChild(why); acts.appendChild(send);
  } else {
    no.addEventListener("click", function () { orgSkills.declining = offer.id; fold.open = true; render(); });
    acts.appendChild(yes); acts.appendChild(no);
  }
  body.appendChild(acts);
  fold.appendChild(body);
  fold.open = orgSkills.declining === offer.id;
  return fold;
}

/** Settings → Mine: offer a skill from a box you may enter, and what became of what you offered. On an organisation only. */
var mySkillOffers = { data: null, box: "", skills: null };
function offerSkillBlock() {
  if (mySkillOffers.data === null) {
    mySkillOffers.data = false;
    getJson("/api/org-skills/offers/mine").then(function (got) { mySkillOffers.data = got; render(); }, function () { mySkillOffers.data = false; });
    return null;
  }
  if (!mySkillOffers.data || !canDriveAgents()) return null;
  var box = el("section", "setting"), line = el("div", "dept-row"), sources = mySkillOffers.data.sources || [];
  box.setAttribute("data-org-skills", "offer");
  box.appendChild(el("h2", "group", t("ui.next.orgSkills.offerTitle")));
  box.appendChild(el("p", "why", t("ui.next.orgSkills.offerNote")));
  var boxPick = selectOf([["", t("ui.next.orgSkills.pickBox")]].concat(sources.map(function (b) { return [b.id, b.name]; })), mySkillOffers.box);
  boxPick.setAttribute("aria-label", t("ui.next.orgSkills.fromBox"));
  boxPick.addEventListener("change", function () {
    mySkillOffers.box = boxPick.value; mySkillOffers.skills = null; render();
    if (boxPick.value) getJson("/api/org-skills/box?box=" + encodeURIComponent(boxPick.value)).then(function (got) { mySkillOffers.skills = got.skills || []; render(); }, failed);
  });
  line.appendChild(boxPick);
  var go = el("button", "act-primary", t("ui.next.orgSkills.offer"));
  go.disabled = true;
  if (mySkillOffers.box && mySkillOffers.skills) {
    var skillPick = selectOf(mySkillOffers.skills.map(function (slug) { return [slug, slug]; }), "");
    skillPick.setAttribute("aria-label", t("ui.next.orgSkills.whichSkill"));
    line.appendChild(skillPick);
    go.disabled = !mySkillOffers.skills.length;
    go.addEventListener("click", function () {
      go.disabled = true;
      postJson("/api/org-skills/offer", { box: mySkillOffers.box, skill: skillPick.value }).then(function () {
        toast(t("ui.next.orgSkills.offered")); mySkillOffers.data = null; render();
      }, function (error) { go.disabled = false; failed(error); });
    });
  }
  line.appendChild(go);
  box.appendChild(line);
  (mySkillOffers.data.offers || []).slice().reverse().forEach(function (offer) {
    var text = offer.name + " · " + agoText(offer.at) + " — " + t("ui.next.orgSkills.offerState." + offer.state) + (offer.reason ? ": " + offer.reason : "");
    var p = el("p", "why", text); p.setAttribute("data-my-offer", offer.state); box.appendChild(p);
  });
  return box;
}

function orgSkillsBlock() {
  if ((team.installation || {}).mode === "single-machine" || !canOperateInstallation()) return null;
  if (orgSkills.data === null) { loadOrgSkills(); return null; }
  if (orgSkills.data === false) return null;
  var box = el("section", "setting"), skills = orgSkills.data.skills || [], add = el("details", "fold");
  box.setAttribute("data-org-skills", "library");
  box.appendChild(el("h2", "group", t("ui.next.orgSkills.title")));
  box.appendChild(el("p", "why", t("ui.next.orgSkills.note")));
  var waiting = orgSkills.offers || [];
  if (waiting.length) {
    var review = el("div", ""); review.setAttribute("data-org-skills", "offers");
    review.appendChild(el("h3", "group", t("ui.next.orgSkills.waiting", { n: waiting.length })));
    waiting.forEach(function (offer) { review.appendChild(orgOfferRow(offer)); });
    box.appendChild(review);
  }
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
