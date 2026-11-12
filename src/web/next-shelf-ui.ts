/**
 * Starting an agent from a template on the rebuilt page (INV-1825): the ready-made ones, the ones
 * made here, the roles and crews of the catalogue, and a template somebody sent as a file or as
 * text. Shown under the blank form when a new agent is being made; one press creates it on the
 * computer that is selected.
 */
export const NEXT_SHELF_JS = `
var shelf = { data: null, error: "", find: "", open: false, shared: null };

/** Every template on offer as one list of rows: where it comes from, what to show, and what a press sends. */
function shelfRows(data) {
  var rows = [];
  (data.marketplace || []).forEach(function (row) {
    rows.push({ group: "ready", name: row.name, note: row.title || row.description || "", send: { templateSlug: row.slug } });
  });
  (data.mine || []).forEach(function (row) {
    rows.push({ group: "mine", name: row.name, note: row.agentName + " · v" + row.version, send: { agentId: row.agentId, version: row.version } });
  });
  (data.catalog || []).forEach(function (row) {
    var members = (row.members || []).map(function (member2) { return member2.name; }).join(", ");
    var note = (row.title || row.summary || "") + (members ? " · " + members : "");
    rows.push({ group: row.kind === "crew" ? "crew" : "role", name: row.name, note: note, send: { catalogSlug: row.slug } });
  });
  return rows;
}

/** The rows that hold what is being looked for, in a name or a note. */
function shelfFound(rows, wanted) {
  wanted = String(wanted || "").trim().toLowerCase();
  return wanted ? rows.filter(function (row) { return (row.name + " " + row.note).toLowerCase().indexOf(wanted) >= 0; }) : rows;
}

function shelfMade(created) {
  var first = (created || [])[0];
  toast(t("ui.next.shelf.made", { names: (created || []).map(function (row) { return row.name; }).join(", ") }));
  closeMember();
  refresh().then(function () { if (first) openChat(first.id); });
}

/**
 * Arriving from a share page ("/?import=<id>"): the template is fetched for the person to read, and
 * nothing is added until they press Import themselves.
 */
function landSharedTemplate() {
  var shareId = new URLSearchParams(location.search).get("import");
  if (!shareId) return;
  history.replaceState(null, "", location.pathname);
  getJson("/api/templates/preview?shareId=" + encodeURIComponent(shareId)).then(function (got) {
    shelf.shared = { shareId: shareId, name: got.name || "", document: got.document || "", by: got.ownerName || "", about: got.description || "" };
    openMember("");
  }, failed);
}

function sharedBlock() {
  var shared = shelf.shared, box = el("div", "needbox"), go = el("button", "act-primary", t("ui.next.shelf.import")), no = el("button", "act", t("ui.next.auto.cancel")), acts = el("div", "acts");
  var where = chat.box || ((shelf.data && shelf.data.boxes || [])[0] || {}).id || "";
  box.appendChild(el("div", "card-head", t("ui.next.shelf.shared", { name: shared.name, by: shared.by || t("ui.next.shelf.someone") })));
  if (shared.about) box.appendChild(el("div", "", shared.about));
  go.addEventListener("click", function () {
    go.disabled = true;
    var body = Object.assign({ template: shared.document, shareId: shared.shareId }, shared.name ? { name: shared.name } : {}, where ? { boxId: where } : {});
    postJson("/api/templates/import", body).then(function (got) { shelf.shared = null; shelfMade([{ id: got.id, name: got.name }]); }, function (error) { go.disabled = false; failed(error); });
  });
  no.addEventListener("click", function () { shelf.shared = null; renderMember(); });
  acts.appendChild(go); acts.appendChild(no); box.appendChild(acts);
  return box;
}

/** Closed until asked for: making an agent starts with a name, and the catalogue is one press away. */
function shelfBlock() {
  var outer = el("div", "setting"), fold = el("details", "fold"), box = el("div", "fold-body"), list = el("div", "shelf");
  fold.appendChild(el("summary", "", t("ui.next.shelf.title"))); fold.appendChild(box); outer.appendChild(fold);
  fold.open = shelf.open;
  fold.addEventListener("toggle", function () { if (fold.open !== shelf.open) { shelf.open = fold.open; renderMember(); } });
  if (!shelf.open) return outer;
  if (shelf.error) { box.appendChild(el("p", "why", shelf.error)); return outer; }
  if (shelf.data === null) {
    box.appendChild(el("p", "why", t("ui.next.auto.reading")));
    getJson("/api/templates/shelf").then(function (got) { shelf.data = got; }, function (error) { shelf.data = {}; shelf.error = error.message; })
      .then(function () { if (member.creating && !$("member").hidden) renderMember(); });
    return outer;
  }
  var where = chat.box || ((shelf.data.boxes || [])[0] || {}).id || "", find = el("input"), rows = shelfRows(shelf.data);
  find.placeholder = t("ui.next.shelf.find"); find.value = shelf.find;
  var draw = function () {
    var last = "";
    list.replaceChildren();
    shelfFound(rows, shelf.find).forEach(function (row) {
      if (row.group !== last) { list.appendChild(el("h2", "group", t("ui.next.shelf.group." + row.group))); last = row.group; }
      var line = el("div", "fact"), text = el("span", ""), use = el("button", "act", t("ui.next.shelf.use"));
      text.appendChild(el("b", "", row.name)); text.appendChild(el("span", "why", " " + clip(row.note, 90)));
      use.addEventListener("click", function () {
        use.disabled = true;
        postJson("/api/templates/stamp", Object.assign({ boxId: where }, row.send)).then(function (got) { shelfMade(got.created); }, function (error) {
          use.disabled = false; failed(error);
        });
      });
      line.appendChild(text); line.appendChild(use); list.appendChild(line);
    });
    if (!list.childNodes.length) list.appendChild(el("p", "why", t("ui.next.shelf.none")));
  };
  find.addEventListener("input", function () { shelf.find = find.value; draw(); });
  if (rows.length > 6) box.appendChild(find);
  draw(); box.appendChild(list);

  // A template somebody sent: a file, or its text pasted.
  var sent = el("details", "fold"), text2 = el("textarea"), file = el("input"), bring = el("button", "act", t("ui.next.shelf.import"));
  sent.appendChild(el("summary", "", t("ui.next.shelf.sent")));
  text2.rows = 5; text2.placeholder = t("ui.next.shelf.paste"); file.type = "file"; file.accept = ".json,application/json";
  file.addEventListener("change", function () {
    var reader = new FileReader();
    reader.onload = function () { text2.value = String(reader.result || ""); };
    if (file.files[0]) reader.readAsText(file.files[0]);
  });
  bring.addEventListener("click", function () {
    if (!text2.value.trim()) { text2.focus(); return; }
    bring.disabled = true;
    postJson("/api/templates/import", Object.assign({ template: text2.value }, where ? { boxId: where } : {})).then(function (got) {
      shelfMade([{ id: got.id, name: got.name }]);
    }, function (error) { bring.disabled = false; failed(error); });
  });
  [file, text2, bring].forEach(function (node) { sent.appendChild(node); });
  box.appendChild(sent);
  return outer;
}
`;
