/**
 * The doors people reach the agents through, on the rebuilt page (INV-1825): the chat channels (a
 * Feishu or DingTalk app each), the outside services connected with their own sign-in, and the
 * people who knocked and are waiting to be let in. An admin's pane. A credential is typed, saved
 * and never shown again: the page is only told whether one is set.
 */
import { CHANNEL_SETUP_JS } from "./channel-setup-ui.ts";

/**
 * A channel row: its name and status, then who answers, when it answers in groups and Set credentials. The words wrap
 * and the controls move under them when the card is too narrow for one line (INV-2322): on one unwrapped line the
 * Set credentials button sat past the right edge of the desktop app's default window.
 */
export const NEXT_SET_DOORS_CSS = `
.setting .fact.channel-row { flex-wrap: wrap; row-gap: 8px; }
.channel-row > span:first-child { flex: 1 1 260px; min-width: 0; } .channel-row .why { white-space: normal; }
.setting .channel-row > .acts { flex: 0 1 auto; max-width: 100%; justify-content: flex-start; }
`;

export const NEXT_SET_DOORS_JS = `
${CHANNEL_SETUP_JS}
var doors = { data: null, connectors: null, error: "", adding: false, editing: null, note: "" };

function loadDoors() {
  getJson("/api/channels").then(function (got) { doors.data = got; doors.error = ""; }, function (error) { doors.data = {}; doors.error = error.message; })
    .then(function () { if (next.view === "settings") render(); });
  getJson("/api/connectors").then(function (got) { doors.connectors = got; if (next.view === "settings") render(); }, function () { doors.connectors = null; });
}

/** What saving a channel led to, in words: it is connecting now, or it needs a restart to. */
function doorSaved(got) { return got.started ? t("ui.next.doors.connecting") : got.restartNeeded ? t("ui.next.doors.restart") : t("ui.next.settings.saved2"); }

function publicUrlBlock(data) {
  var wrap = el("div", "fact"), left = el("div", ""), right = el("div", "acts"), input = el("input"), save = el("button", "act", t("ui.next.settings.save"));
  input.value = data.publicUrl || "";
  input.placeholder = location.origin;
  input.disabled = Boolean(data.publicUrlLocked);
  left.appendChild(labelled(t("ui.next.doors.publicUrl"), input));
  left.appendChild(el("p", "why", data.publicUrlLocked ? t("ui.next.doors.publicUrlLocked") : t("ui.next.doors.publicUrlHint")));
  if (!data.publicUrlLocked) {
    if (!data.publicUrl) {
      var fill = el("button", "act", t("ui.next.doors.publicUrlUseOrigin"));
      fill.addEventListener("click", function () { input.value = location.origin; input.focus(); });
      right.appendChild(fill);
    }
    save.addEventListener("click", function () {
      save.disabled = true;
      postJson("/api/channels/public-url", { publicUrl: input.value.trim() }).then(function () {
        doors.note = t("ui.next.settings.saved2"); loadDoors();
      }, function (error) { save.disabled = false; failed(error); });
    });
    right.appendChild(save);
  }
  wrap.appendChild(left); wrap.appendChild(right);
  return wrap;
}

function channelsBlock() {
  var data = doors.data, box = el("section", "setting"), running = {};
  (data.channels || []).forEach(function (channel) { running[channel.name] = channel; });
  box.appendChild(el("h2", "group", t("ui.next.doors.channels")));
  if (data.bootstrapPending) {
    var setup = el("a", "act-primary", t("ui.channels.bootstrap-pending"));
    setup.href = "/bootstrap"; box.appendChild(setup);
  }
  if (doors.note) box.appendChild(el("p", "why", doors.note));
  // On an organisation the public address lives in Settings → Organisation (INV-2311): one home, and this says where.
  if (isOrganisation()) {
    var moved = el("div", "fact"), there = el("button", "act", t("ui.org.open"));
    there.addEventListener("click", function () { openSettingsPane("organisation"); });
    moved.appendChild(el("span", "why", t("ui.org.movedHere"))); moved.appendChild(there); box.appendChild(moved);
  } else box.appendChild(publicUrlBlock(data));
  var change = function (record, extra) {
    postJson("/api/channels/records", Object.assign({ id: record.id, type: record.type }, extra)).then(function (got) { doors.note = doorSaved(got); loadDoors(); }, failed);
  };
  (data.records || []).forEach(function (record) {
    var state = running[record.id] || running[record.name] || {}, line = el("div", "fact channel-row"), text = el("span", ""), acts = el("span", "acts");
    var status = state.running ? t("ui.next.doors.on") : record.credentialsSet ? t("ui.next.doors.off") : t("ui.next.doors.noCredentials");
    var detail = record.credentialsSet ? state.detail : t(record.type === "telegram" ? "ui.channels.telegram-setup" : "ui.channels.add-credentials");
    text.appendChild(el("b", "", record.name || record.id)); text.appendChild(el("div", "why", record.type + " · " + status + (detail ? " · " + detail : "")));
    var who = selectOf([["", t("ui.next.config.default")]].concat((data.agents || []).map(function (agent) { return [agent.id, agent.name]; })), record.defaultAgent || "");
    var groups = selectOf([["addressed", t("ui.next.doors.addressed")], ["all", t("ui.next.doors.all")]], record.groupMessages || "addressed");
    who.setAttribute("aria-label", t("ui.next.doors.answers")); groups.setAttribute("aria-label", t("ui.next.doors.groups"));
    who.addEventListener("change", function () { change(record, { defaultAgent: who.value }); });
    groups.addEventListener("change", function () { change(record, { groupMessages: groups.value }); });
    acts.appendChild(who); acts.appendChild(groups);
    if (record.type === "feishu" || record.type === "dingtalk") {
      var cred = el("button", record.credentialsSet ? "act" : "act-primary", t(record.credentialsSet ? "ui.next.doors.updateCredentials" : "ui.next.doors.setCredentials"));
      cred.addEventListener("click", function () { doors.adding = true; doors.editing = { id: record.id, type: record.type, name: record.name || "" }; render(); });
      acts.appendChild(cred);
    }
    if (!record.grandfathered) {
      var remove = el("button", "act", t("ui.next.doors.remove"));
      remove.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.doors.removeSure"));
        sure.addEventListener("click", function () { postJson("/api/channels/records/remove", { id: record.id }).then(function () { doors.note = t("ui.next.doors.restart"); loadDoors(); refresh(); }, failed); });
        remove.replaceWith(sure);
      });
      acts.appendChild(remove);
    }
    line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  if (!(data.records || []).length) box.appendChild(el("p", "why", t("ui.next.doors.none")));
  if (!doors.adding) {
    var add = el("button", "act", t("ui.next.doors.add"));
    add.addEventListener("click", function () { doors.adding = true; doors.editing = null; render(); });
    box.appendChild(add);
    return box;
  }
  var preset = doors.editing;
  var type = selectOf([["feishu", t("ui.next.doors.feishu")], ["dingtalk", t("ui.next.doors.dingtalk")]], preset ? preset.type : "feishu"), id = el("input"), name = el("input"), appId = el("input"), secret = el("input");
  var save = el("button", "act-primary", t("ui.next.settings.save")), cancel = el("button", "act", t("ui.next.auto.cancel")), acts2 = el("div", "acts");
  secret.type = "password"; secret.autocomplete = "off"; id.placeholder = t("ui.next.doors.idPlaceholder");
  if (preset) { id.value = preset.id; id.disabled = true; type.disabled = true; name.value = preset.name || ""; }
  save.addEventListener("click", function () {
    if (!id.value.trim()) { id.focus(); return; }
    var idVal = appId.value.trim(), secVal = secret.value.trim();
    if ((idVal !== "") !== (secVal !== "")) { (idVal ? secret : appId).focus(); return; }
    var body = { id: id.value.trim(), type: type.value };
    if (name.value.trim()) body.name = name.value.trim();
    if (idVal) body.appId = idVal;
    if (secVal) body.appSecret = secVal;
    save.disabled = true;
    // Credentials decide Getting started's channel step, which reads /api/setup again only in refresh() (INV-2323).
    postJson("/api/channels/records", body).then(function (got) { doors.adding = false; doors.editing = null; doors.note = doorSaved(got); loadDoors(); refresh(); }, function (error) { save.disabled = false; failed(error); });
  });
  cancel.addEventListener("click", function () { doors.adding = false; doors.editing = null; render(); });
  [labelled(t("ui.next.doors.type"), type), labelled(t("ui.next.doors.id"), id), labelled(t("ui.next.member.name"), name), labelled(t("ui.next.doors.appId"), appId),
    labelled(t("ui.next.doors.appSecret"), secret)].forEach(function (node) { box.appendChild(node); });
  var callback = el("p", "why");
  var updateCallback = function () { channelCallbackHint(callback, data.feishuCallbackTemplate, type.value, id.value); };
  type.addEventListener("change", updateCallback); id.addEventListener("input", updateCallback); updateCallback();
  box.appendChild(callback);
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
  var clientId = el("input"), clientSecret = el("input"), grant = el("input"), go = el("button", "act", t("ui.next.doors.connect"));
  var how = el("p", "guidance"), callback = el("div", "connector-callback");
  callback.appendChild(el("div", "guidance", t("ui.next.doors.callback")));
  callback.appendChild(el("code", "card-code", data.redirectUri || ""));
  if (navigator.clipboard) {
    var copy = el("button", "act", t("ui.next.doors.copyCallback"));
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(data.redirectUri).then(function () { toast(t("ui.next.msg.copied")); }, failed);
    });
    callback.appendChild(copy);
  }
  clientSecret.type = "password"; clientSecret.autocomplete = "off"; grant.placeholder = t("ui.next.doors.grantPlaceholder");
  var selected = function () { return providers.find(function (provider) { return provider.id === which.value; }) || {}; };
  var follow = function () {
    var chosen = selected();
    how.textContent = (locale === "zh" && chosen.setupZh) || chosen.setup || "";
    callback.hidden = chosen.kind !== "authorization_code" || !data.redirectUri;
  };
  which.addEventListener("change", follow); follow();
  go.addEventListener("click", function () {
    var chosen = selected();
    if (!clientId.value.trim() || !clientSecret.value.trim()) { (clientId.value.trim() ? clientSecret : clientId).focus(); return; }
    var body = { provider: chosen.id, clientId: clientId.value.trim(), clientSecret: clientSecret.value.trim(), grant: grant.value.trim() };
    postJson(chosen.kind === "authorization_code" ? "/api/connectors/begin" : "/api/connectors/connect", body).then(function (got) {
      clientSecret.value = "";
      if (got.url) window.open(got.url, "_blank", "noopener"); else toast(t("ui.next.doors.connected"));
      loadDoors();
    }, function (error) { clientSecret.value = ""; failed(error); });
  });
  [labelled(t("ui.next.doors.service"), which), how, callback,
    labelled(t("ui.next.doors.clientId"), clientId), labelled(t("ui.next.doors.clientSecret"), clientSecret),
    labelled(t("ui.next.doors.grant"), grant), go].forEach(function (node) { box.appendChild(node); });
  return box;
}

function renderDoorsPane(view) {
  if (doors.data === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadDoors(); return; }
  if (doors.error) { view.appendChild(el("p", "why", doors.error)); return; }
  [knocksBlock(), joinRequestsBlock(true), channelsBlock(), connectorsBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
