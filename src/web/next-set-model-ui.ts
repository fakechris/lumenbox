/**
 * The model the installation runs on, on the rebuilt page (INV-1825): the provider and its key, the
 * model, what sees pictures and what summarises, the key for web search, the providers to fall back
 * to, and which accounts are resting after running out. An admin's to change; a key is typed, saved
 * and never shown again.
 */
export const NEXT_SET_MODEL_JS = `
var model = { config: null, error: "", fallbacks: null, rests: null, note: "", test: "" };

function loadModel() {
  getJson("/api/config").then(function (got) { model.config = got; model.error = ""; }, function (error) { model.error = error.message; model.config = model.config || {}; })
    .then(function () { if (next.view === "settings") render(); });
  // An admin's to read: for anybody else these two simply are not shown.
  getJson("/api/provider/fallbacks").then(function (got) { model.fallbacks = got; if (next.view === "settings") render(); }, function () { model.fallbacks = null; });
  getJson("/api/provider/rests").then(function (got) { model.rests = got; if (next.view === "settings") render(); }, function () { model.rests = null; });
}

/** What a save sends for the model settings. An empty model or address clears it; a key is sent only when one was typed. */
function modelBody(form) {
  var body = { provider: form.provider, model: form.model.trim() || null, baseUrl: form.provider === "custom" ? form.baseUrl.trim() || null : null, vision: form.vision, summaryModel: form.summaryModel.trim() || null };
  if (form.key.trim()) body.key = form.key.trim();
  if (form.searchKey.trim()) { body.searchProvider = form.searchProvider; body.searchKey = form.searchKey.trim(); }
  else if (form.searchProvider !== form.searchWas) body.searchProvider = form.searchProvider;
  return body;
}

function selectOf(rows, chosen) {
  var select = el("select");
  rows.forEach(function (row) { var node = el("option", "", row[1]); node.value = row[0]; node.selected = row[0] === chosen; select.appendChild(node); });
  return select;
}
function labelled(text, control) { var label = el("label", "", text); label.appendChild(control); return label; }

function modelForm() {
  var config = model.config, presets = config.presets || [], saved = config.config || {}, search = (config.search || {}).providers || [];
  var box = el("section", "setting"), admin = settings.me && settings.me.role === "admin";
  box.appendChild(el("h2", "group", t("ui.next.model.title")));
  box.appendChild(el("p", "why", t("ui.next.model.now", { label: (config.effective || {}).label || "", model: (config.effective || {}).model || "" })));
  if (!admin) { box.appendChild(el("p", "why", t("ui.next.set.adminOnly"))); return box; }
  var chosen = saved.provider || config.current || "", searchWas = (search.filter(function (row) { return row.keyPresent; })[0] || {}).name || "";
  var provider = selectOf(presets.map(function (preset) { return [preset.name, preset.label + " · " + preset.model]; }), chosen);
  var name = el("input"), address = el("input"), key = el("input"), keyNote = el("p", "why"), summary = el("input"), searchKey = el("input"), list = el("datalist");
  var vision = selectOf([["auto", t("ui.next.model.vision.auto")], ["on", t("ui.next.model.vision.on")], ["off", t("ui.next.model.vision.off")]], (config.settings || {}).vision || "auto");
  var searchProvider = selectOf([["", t("ui.next.model.noSearch")]].concat(search.map(function (row) { return [row.name, row.name]; })), searchWas);
  name.value = saved.model || ""; address.value = saved.baseUrl || ""; summary.value = (config.settings || {}).summaryModel || "";
  key.type = "password"; searchKey.type = "password"; key.autocomplete = "off"; searchKey.autocomplete = "off"; list.id = "model-names"; name.setAttribute("list", list.id);
  var addressLabel = labelled(t("ui.next.model.baseUrl"), address), follow = function () {
    var preset = presets.filter(function (row) { return row.name === provider.value; })[0] || {};
    addressLabel.hidden = provider.value !== "custom";
    name.placeholder = preset.model || "";
    keyNote.textContent = preset.keyPresent ? t("ui.next.model.keySet") : t("ui.next.model.keyMissing");
    list.replaceChildren();
    (preset.models || []).forEach(function (value) { var node = el("option"); node.value = value; list.appendChild(node); });
  };
  provider.addEventListener("change", follow); follow();
  var form = function () {
    return { provider: provider.value, model: name.value, baseUrl: address.value, key: key.value, vision: vision.value, summaryModel: summary.value, searchProvider: searchProvider.value, searchKey: searchKey.value, searchWas: searchWas };
  };
  [labelled(t("ui.next.config.provider"), provider), labelled(t("ui.next.model.name"), name), addressLabel, labelled(t("ui.next.model.key"), key), keyNote,
    labelled(t("ui.next.model.vision"), vision), labelled(t("ui.next.model.summary"), summary), labelled(t("ui.next.model.search"), searchProvider),
    labelled(t("ui.next.model.searchKey"), searchKey), list].forEach(function (node) { box.appendChild(node); });
  var acts = el("div", "acts"), save = el("button", "act-primary", t("ui.next.settings.save")), test = el("button", "act", t("ui.next.model.test"));
  save.addEventListener("click", function () {
    if (searchKey.value.trim() && !searchProvider.value) { toast(t("ui.next.model.searchNeedsProvider")); searchProvider.focus(); return; }
    save.disabled = true;
    postJson("/api/config", modelBody(form())).then(function (got) { model.note = got.note || t("ui.next.settings.saved2"); model.test = ""; loadModel(); }, function (error) {
      // "Saved, but not in effect" is still a save: what the server holds is read again.
      save.disabled = false; failed(error); loadModel();
    });
  });
  test.addEventListener("click", function () {
    var asked = form(), body = { provider: asked.provider };
    if (asked.model.trim()) body.model = asked.model.trim();
    if (asked.provider === "custom" && asked.baseUrl.trim()) body.baseUrl = asked.baseUrl.trim();
    if (asked.key.trim()) body.key = asked.key.trim();
    test.disabled = true; model.test = t("ui.next.model.testing"); note.textContent = model.test;
    postJson("/api/config/test", body).then(function (got) {
      model.test = got.ok ? t("ui.next.model.testOk", { model: got.model || "", ms: got.latencyMs || 0 }) : t("ui.next.model.testBad", { error: got.error || "" });
    }, function (error) { model.test = t("ui.next.model.testBad", { error: error.message }); }).then(function () { test.disabled = false; note.textContent = model.test; });
  });
  var note = el("p", "why", model.test || model.note);
  acts.appendChild(save); acts.appendChild(test); box.appendChild(acts); box.appendChild(note);
  return box;
}

/** Up to three providers to turn to when the first runs out, in order; one with no key is said to be left out. */
function fallbackBlock() {
  if (!model.fallbacks) return null;
  var box = el("section", "setting"), data = model.fallbacks, picks = [], save = el("button", "act", t("ui.next.settings.save"));
  box.appendChild(el("h2", "group", t("ui.next.model.fallbacks")));
  box.appendChild(el("p", "why", t("ui.next.model.fallbacksNote")));
  [0, 1, 2].forEach(function (index) {
    var rows = [["", t("ui.next.model.noFallback")]].concat((data.presets || []).map(function (preset) {
      return [preset.name, preset.label + " · " + preset.model + (preset.hasKey ? "" : " · " + t("ui.next.config.noKey"))];
    }));
    var pick = selectOf(rows, (data.names || [])[index] || "");
    picks.push(pick); box.appendChild(labelled(t("ui.next.model.fallbackN", { n: index + 1 }), pick));
  });
  (data.lastDay || []).forEach(function (row) {
    box.appendChild(fact(t("ui.next.model.stoodIn", { provider: row.provider, for: row.standingInFor }), t("ui.next.model.rounds", { n: row.rounds })));
  });
  save.addEventListener("click", function () {
    postJson("/api/provider/fallbacks", { names: picks.map(function (pick) { return pick.value; }).filter(Boolean) }).then(function (got) { model.fallbacks = got; toast(t("ui.next.settings.saved2")); render(); }, failed);
  });
  box.appendChild(save);
  return box;
}

/** Accounts that ran out and are waiting for their allowance to come back, each with a way to try now. */
function restsBlock() {
  var rests = (model.rests && model.rests.rests) || [];
  if (!rests.length) return null;
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.model.resting")));
  rests.forEach(function (rest) {
    var line = el("div", "fact"), retry = el("button", "act", t("ui.next.model.retryNow"));
    line.appendChild(el("span", "", rest.label + " · " + t("ui.next.model.until", { when: new Date(rest.until).toLocaleString() }) + (rest.reason ? " · " + rest.reason : "")));
    retry.addEventListener("click", function () { postJson("/api/provider/rests/retry", { account: rest.account }).then(loadModel, failed); });
    line.appendChild(retry); box.appendChild(line);
  });
  if (model.rests.quota) box.appendChild(el("p", "why", model.rests.quota));
  return box;
}

function renderModelPane(view) {
  if (model.config === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadModel(); return; }
  if (model.error) { view.appendChild(el("p", "why", model.error)); return; }
  [restsBlock(), modelForm(), fallbackBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
