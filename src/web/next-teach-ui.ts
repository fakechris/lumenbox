/**
 * Reviewing what an agent learned from being shown, on the rebuilt page (INV-1825). After a person
 * hands a desktop back, the agent drafts a skill from what it watched; nothing it drafted is used
 * until an admin has read it here and published it. A draft may come with a question: answering it
 * makes a new draft. A draft that carries an operation can be tried on its cases first.
 */
export const NEXT_TEACH_JS = `
var teach = { drafts: null, error: "", open: "", versions: null, busy: false };

function loadTeach() {
  getJson("/api/teaching-drafts").then(function (got) { teach.drafts = got.drafts || []; teach.error = ""; }, function (error) { teach.drafts = []; teach.error = error.message; })
    .then(function () { if (next.view === "system") render(); });
}

/** Whether a draft carries an operation, which can be run on its cases before it is published. */
function teachHasOperation(draft) { return !!(draft.files && draft.files["operation.json"]); }

/** One decision on a draft: said to the server with the digest that was read, so a draft changed meanwhile is not decided blind. */
function teachDecide(draft, action, extra, done) {
  teach.busy = true; render();
  postJson("/api/teaching-drafts/" + action, Object.assign({ id: draft.id, digest: draft.digest }, extra || {})).then(function () { toast(done); }, failed)
    .then(function () { teach.busy = false; teach.versions = null; loadTeach(); });
}

function teachDetail(draft) {
  var box = el("div", "fold-body"), acts = el("div", "acts");
  if (draft.question) {
    var answer = el("textarea"), send = el("button", "act-primary", t("ui.next.teach.answer"));
    answer.rows = 3; answer.placeholder = t("ui.next.teach.answerPlaceholder");
    send.disabled = teach.busy;
    send.addEventListener("click", function () { if (answer.value.trim()) teachDecide(draft, "clarify", { answer: answer.value.trim() }, t("ui.next.teach.redrafted")); });
    box.appendChild(el("div", "needbox", draft.question)); box.appendChild(answer); box.appendChild(send);
  }
  if (draft.skill) { var text = el("pre", "raw"); text.textContent = draft.skill; box.appendChild(text); }
  (draft.hints || []).forEach(function (hint) { box.appendChild(el("p", "why", typeof hint === "string" ? hint : hint.message || hint.text || "")); });
  Object.keys(draft.files || {}).forEach(function (name) {
    var file = el("details", "fold"), body = el("pre", "raw");
    body.textContent = draft.files[name];
    file.appendChild(el("summary", "", name)); file.appendChild(body); box.appendChild(file);
  });
  if (draft.dryRun) {
    box.appendChild(fact(t("ui.next.teach.tried"), draft.dryRun.passed + " / " + draft.dryRun.total));
    (draft.dryRun.failures || []).slice(0, 10).forEach(function (line) { box.appendChild(el("p", "why", line)); });
  }
  if (draft.status === "draft") {
    var publish = el("button", "act-primary", t("ui.next.teach.publish")), reject = el("button", "act", t("ui.next.act.deny"));
    publish.disabled = reject.disabled = teach.busy || !draft.skill;
    publish.addEventListener("click", function () { teachDecide(draft, "approve", null, t("ui.next.teach.published")); });
    reject.addEventListener("click", function () { teachDecide(draft, "reject", null, t("ui.next.done.denied")); });
    acts.appendChild(publish); acts.appendChild(reject);
    if (teachHasOperation(draft)) {
      var tryIt = el("button", "act", t("ui.next.teach.try"));
      tryIt.disabled = teach.busy;
      tryIt.addEventListener("click", function () { teachDecide(draft, "dryrun", null, t("ui.next.teach.triedDone")); });
      acts.appendChild(tryIt);
    }
  }
  if (acts.childNodes.length) box.appendChild(acts);
  if (draft.status === "published") {
    if (teach.versions === null) {
      teach.versions = [];
      getJson("/api/teaching-drafts/versions?id=" + encodeURIComponent(draft.id)).then(function (got) { teach.versions = got.versions || []; if (teach.open === draft.id) render(); }, function () {});
    }
    // Going back is offered for every version but the one in use, whichever way the list is ordered.
    var newest = Math.max.apply(null, teach.versions.map(function (version) { return version.version; }));
    teach.versions.forEach(function (version) {
      var line = el("div", "fact");
      line.appendChild(el("span", "why", "v" + version.version + " · " + new Date(version.at).toLocaleString() + " · " + (version.author || "") + " · " + (version.message || "")));
      if (version.version !== newest) {
        var back = el("button", "act", t("ui.next.config.restore"));
        back.addEventListener("click", function () {
          postJson("/api/teaching-drafts/rollback", { id: draft.id, version: version.version }).then(function () { toast(t("ui.next.config.restored", { n: version.version })); teach.versions = null; render(); }, failed);
        });
        line.appendChild(back);
      }
      box.appendChild(line);
    });
  }
  return box;
}

function teachBlock() {
  var box = el("section", "setting");
  box.appendChild(systemFold(t("ui.next.teach.title"), "teach", function (body) {
    if (teach.drafts === null) { body.appendChild(el("p", "why", t("ui.next.auto.reading"))); loadTeach(); return; }
    if (teach.error) { body.appendChild(el("p", "why", teach.error)); return; }
    if (!teach.drafts.length) body.appendChild(el("p", "why", t("ui.next.teach.none")));
    teach.drafts.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).forEach(function (draft) {
      var line = el("button", "fact"), state = MSG["ui.next.teach.status." + draft.status] ? t("ui.next.teach.status." + draft.status) : draft.status;
      line.appendChild(el("span", "", agentName(draft.agentId) + " · " + new Date(draft.createdAt).toLocaleString()));
      line.appendChild(el("span", draft.status === "draft" ? "warn" : "why", draft.question ? t("ui.next.teach.asks") : state));
      line.addEventListener("click", function () { teach.open = teach.open === draft.id ? "" : draft.id; teach.versions = null; render(); });
      body.appendChild(line);
      if (teach.open === draft.id) body.appendChild(teachDetail(draft));
    });
  }));
  return box;
}
`;
