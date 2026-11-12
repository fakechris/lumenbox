/**
 * The doors people reach the agents through, on the rebuilt page (INV-1825): the chat channels (a
 * Feishu or DingTalk app each), the outside services connected with their own sign-in, and the
 * people who knocked and are waiting to be let in. An admin's pane. A credential is typed, saved
 * and never shown again: the page is only told whether one is set.
 */
export const NEXT_SET_DOORS_JS = `
var doors = { data: null, connectors: null, error: "", adding: false, note: "" };

function loadDoors() {
  getJson("/api/channels").then(function (got) { doors.data = got; doors.error = ""; }, function (error) { doors.data = {}; doors.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  getJson("/api/connectors").then(function (got) { doors.connectors = got; if (next.view === "settings") render(); }, function () { doors.connectors = null; });
}

/** What saving a channel led to, in words: it is connecting now, or it needs a restart to. */
function doorSaved(got) { return got.started ? t("ui.next.doors.connecting") : got.restartNeeded ? t("ui.next.doors.restart") : t("ui.next.settings.saved2"); }

function channelsBlock() {
  var data = doors.data, box = el("section", "setting"), running = {};
  (data.channels || []).forEach(function (channel) { running[channel.name] = channel; });
  box.appendChild(el("h2", "group", t("ui.next.doors.channels")));
  if (doors.note) box.appendChild(el("p", "why", doors.note));
  var change = function (record, extra) {
    postJson("/api/channels/records", Object.assign({ id: record.id, type: record.type }, extra)).then(function (got) { doors.note = doorSaved(got); loadDoors(); }, failed);
  };
  (data.records || []).forEach(function (record) {
    var state = running[record.id] || running[record.name] || {}, line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts");
    var status = state.running ? t("ui.next.doors.on") : record.credentialsSet ? t("ui.next.doors.off") : t("ui.next.doors.noCredentials");
    text.appendChild(el("b", "", record.name || record.id)); text.appendChild(el("div", "why", record.type + " · " + status + (state.detail ? " · " + state.detail : "")));
    var who = selectOf([["", t("ui.next.config.default")]].concat((data.agents || []).map(function (agent) { return [agent.id, agent.name]; })), record.defaultAgent || "");
    var groups = selectOf([["addressed", t("ui.next.doors.addressed")], ["all", t("ui.next.doors.all")]], record.groupMessages || "addressed");
    who.setAttribute("aria-label", t("ui.next.doors.answers")); groups.setAttribute("aria-label", t("ui.next.doors.groups"));
    who.addEventListener("change", function () { change(record, { defaultAgent: who.value }); });
    groups.addEventListener("change", function () { change(record, { groupMessages: groups.value }); });
    acts.appendChild(who); acts.appendChild(groups);
    if (!record.grandfathered) {
      var remove = el("button", "act", t("ui.next.doors.remove"));
      remove.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.doors.removeSure"));
        sure.addEventListener("click", function () { postJson("/api/channels/records/remove", { id: record.id }).then(function () { doors.note = t("ui.next.doors.restart"); loadDoors(); }, failed); });
        remove.replaceWith(sure);
      });
      acts.appendChild(remove);
    }
    line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  if (!(data.records || []).length) box.appendChild(el("p", "why", t("ui.next.doors.none")));
  if (!doors.adding) {
    var add = el("button", "act", t("ui.next.doors.add"));
    add.addEventListener("click", function () { doors.adding = true; render(); });
    box.appendChild(add);
    return box;
  }
  var type = selectOf([["feishu", t("ui.next.doors.feishu")], ["dingtalk", t("ui.next.doors.dingtalk")]], "feishu"), id = el("input"), name = el("input"), appId = el("input"), secret = el("input");
  var save = el("button", "act-primary", t("ui.next.settings.save")), cancel = el("button", "act", t("ui.next.auto.cancel")), acts2 = el("div", "acts");
  secret.type = "password"; secret.autocomplete = "off"; id.placeholder = t("ui.next.doors.idPlaceholder");
  save.addEventListener("click", function () {
    if (!id.value.trim()) { id.focus(); return; }
    var body = { id: id.value.trim(), type: type.value };
    if (name.value.trim()) body.name = name.value.trim();
    if (appId.value.trim()) body.appId = appId.value.trim();
    if (secret.value.trim()) body.appSecret = secret.value.trim();
    save.disabled = true;
    postJson("/api/channels/records", body).then(function (got) { doors.adding = false; doors.note = doorSaved(got); loadDoors(); }, function (error) { save.disabled = false; failed(error); });
  });
  cancel.addEventListener("click", function () { doors.adding = false; render(); });
  [labelled(t("ui.next.doors.type"), type), labelled(t("ui.next.doors.id"), id), labelled(t("ui.next.member.name"), name), labelled(t("ui.next.doors.appId"), appId),
    labelled(t("ui.next.doors.appSecret"), secret)].forEach(function (node) { box.appendChild(node); });
  acts2.appendChild(save); acts2.appendChild(cancel); box.appendChild(acts2);
  return box;
}

function knocksBlock() {
  var knocks = doors.data.knocks || [];
  if (!knocks.length) return null;
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.doors.knocks", { n: knocks.length })));
  knocks.forEach(function (knock) {
    var line = el("div", "fact"), acts = el("span", "acts");
    line.appendChild(el("span", "", (knock.senderLabel || knock.identity) + " · " + knock.channel + " · " + new Date(knock.at).toLocaleString()));
    [["driver", t("ui.next.doors.asDriver")], ["viewer", t("ui.next.doors.asViewer")]].forEach(function (pair) {
      var let2 = el("button", "act", pair[1]);
      let2.addEventListener("click", function () { postJson("/api/channels/approve", { identity: knock.identity, role: pair[0] }).then(loadDoors, function (error) { failed(error); loadDoors(); }); });
      acts.appendChild(let2);
    });
    var away = el("button", "act", t("ui.next.card.dismiss"));
    away.addEventListener("click", function () { postJson("/api/channels/dismiss", { identity: knock.identity }).then(loadDoors, failed); });
    acts.appendChild(away); line.appendChild(acts); box.appendChild(line);
  });
  return box;
}

/** Outside services connected with their own sign-in: an app's id and secret are given once, and a sign-in page opens where the service wants one. */
function connectorsBlock() {
  if (!doors.connectors) return null;
  var data = doors.connectors, box = el("section", "setting"), providers = data.providers || [];
  box.appendChild(el("h2", "group", t("ui.next.doors.connectors")));
  (data.connected || []).forEach(function (row) {
    var line = el("div", "fact"), off = el("button", "act", t("ui.next.doors.disconnect"));
    line.appendChild(el("span", "", row.provider + " · " + (row.grants || []).map(function (grant) { return grant.holder; }).join(", ")));
    off.addEventListener("click", function () { postJson("/api/vault/remove", { id: row.id }).then(loadDoors, failed); });
    line.appendChild(off); box.appendChild(line);
  });
  if (!providers.length) return box;
  var locale = "{{@locale}}", which = selectOf(providers.map(function (provider) { return [provider.id, (locale === "zh" && provider.titleZh) || provider.title]; }), providers[0].id);
  var clientId = el("input"), clientSecret = el("input"), grant = el("input"), how = el("p", "why"), go = el("button", "act", t("ui.next.doors.connect"));
  clientSecret.type = "password"; clientSecret.autocomplete = "off"; grant.placeholder = t("ui.next.doors.grantPlaceholder");
  var follow = function () { var chosen = providers.filter(function (provider) { return provider.id === which.value; })[0] || {}; how.textContent = (locale === "zh" && chosen.setupZh) || chosen.setup || ""; };
  which.addEventListener("change", follow); follow();
  go.addEventListener("click", function () {
    var chosen = providers.filter(function (provider) { return provider.id === which.value; })[0] || {};
    if (!clientId.value.trim() || !clientSecret.value.trim()) { (clientId.value.trim() ? clientSecret : clientId).focus(); return; }
    var body = { provider: chosen.id, clientId: clientId.value.trim(), clientSecret: clientSecret.value.trim(), grant: grant.value.trim() };
    postJson(chosen.kind === "authorization_code" ? "/api/connectors/begin" : "/api/connectors/connect", body).then(function (got) {
      clientSecret.value = "";
      if (got.url) window.open(got.url, "_blank", "noopener"); else toast(t("ui.next.doors.connected"));
      loadDoors();
    }, function (error) { clientSecret.value = ""; failed(error); });
  });
  [labelled(t("ui.next.doors.service"), which), how, labelled(t("ui.next.doors.clientId"), clientId), labelled(t("ui.next.doors.clientSecret"), clientSecret),
    labelled(t("ui.next.doors.grant"), grant), go].forEach(function (node) { box.appendChild(node); });
  return box;
}

function renderDoorsPane(view) {
  if (doors.data === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadDoors(); return; }
  if (doors.error) { view.appendChild(el("p", "why", doors.error)); return; }
  [knocksBlock(), channelsBlock(), connectorsBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
