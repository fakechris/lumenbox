/**
 * Settings → Organisation (INV-2311, docs/112 §4): an organisation's own setup, the Admin's, and not
 * on getting started. Three parts, each with its state: the channel app members sign in with, the
 * public address, and activating members.
 *
 * Nothing here is a second copy. The public address is `publicUrlBlock` and activation is
 * `directoryBlock`, moved here from Channels and Team on an organisation; the channel app is edited
 * where every channel is, and this pane says its state and opens Settings → Channels.
 */
export const NEXT_SET_ORGANISATION_CSS = `
.org-part .why { white-space: normal; } .org-part .fact > div:first-child { flex: 1; min-width: 0; } .org-part .fact .acts { align-items: flex-start; }
`;

export const NEXT_SET_ORGANISATION_JS = `
/** The DingTalk and Feishu apps: the ones a member signs in with. */
function organisationApps(data) { return (data.records || []).filter(function (record) { return record.type === "dingtalk" || record.type === "feishu"; }); }

/** A part's heading with its state beside it. */
function organisationHead(section, words, state, tone) {
  section.classList.add("org-part");
  var head = el("h2", "group", words + " · ");
  head.appendChild(el("span", tone ? "chip " + tone : "chip", state));
  section.appendChild(head);
}

function organisationAppBlock(data, connected) {
  var section = el("section", "setting"), apps = organisationApps(data), open = el("button", "act", t("ui.org.openChannels"));
  organisationHead(section, t("ui.org.channelApp"), t(connected ? "ui.org.state.connected" : "ui.org.state.notConnected"), connected ? "done" : "need");
  section.appendChild(el("p", "why", t(apps.length ? "ui.org.channelApp.why" : "ui.org.channelApp.none")));
  // Each app by the name a person gave it and its state; the id and the vendor are Settings → Channels' detail.
  apps.forEach(function (record) {
    var name = record.name && record.name !== record.id ? record.name : t("ui.next.doors." + record.type);
    section.appendChild(el("div", "why", name + " · " + t(appConnected(data, record) ? "ui.org.state.connected" : "ui.org.state.notConnected")));
  });
  open.addEventListener("click", function () { openSettingsPane("doors"); });
  section.appendChild(open);
  return section;
}

function organisationAddressBlock(data) {
  var section = el("section", "setting");
  organisationHead(section, t("ui.org.publicAddress"), t(data.publicUrl ? "ui.org.state.set" : "ui.org.state.notSet"), data.publicUrl ? "done" : "need");
  section.appendChild(publicUrlBlock(data));
  return section;
}

function organisationActivateBlock() {
  var section = el("section", "setting"), tree = directoryBlock();
  if (directory.data === null) { section.appendChild(el("p", "empty", t("ui.next.auto.reading"))); return section; } // being read
  organisationHead(section, t("ui.org.activate"), t(tree ? "ui.org.state.connected" : "ui.org.state.needsApp"), tree ? "done" : "need");
  if (tree) { section.appendChild(tree); return section; }
  var open = el("button", "act", t("ui.org.openChannels"));
  open.addEventListener("click", function () { openSettingsPane("doors"); });
  section.appendChild(open);
  return section;
}

/** A channel app is connected when it has its credentials and its channel is running. */
function appConnected(data, record) {
  return !!record.credentialsSet && (data.channels || []).some(function (channel) { return channel.running && (channel.name === record.id || channel.name === record.name); });
}

function renderOrganisationPane(view) {
  if (!doors.data) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadDoors(); return; }
  if (doors.error) view.appendChild(el("p", "why", doors.error));
  var data = doors.data, connected = organisationApps(data).some(function (record) { return appConnected(data, record); });
  [organisationAppBlock(data, connected), organisationAddressBlock(data), organisationActivateBlock()].forEach(function (block) { view.appendChild(block); });
}
`;
