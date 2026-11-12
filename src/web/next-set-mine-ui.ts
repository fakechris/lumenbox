/**
 * Settings that are a person's own, on the rebuilt page (INV-1825): what the agents know about them,
 * the tokens they issued for outside tools, and the approvals they gave once and for all. Everybody
 * sees their own; none of it is the installation's.
 */
export const NEXT_SET_MINE_JS = `
var mine = { person: null, tokens: null, policy: null, error: "", issued: "" };
var PERSON_FIELDS = ["responsibilities", "projects", "goals", "interests", "habits", "preferences"];

function loadMine() {
  Promise.all([getJson("/api/person"), getJson("/api/mcp"), getJson("/api/policy")]).then(function (got) {
    mine.person = got[0]; mine.tokens = (got[1].tokens || []).filter(function (token) { return token.mine; }); mine.policy = got[2]; mine.error = "";
  }, function (error) { mine.error = error.message; mine.person = mine.person || {}; }).then(function () { if (next.view === "settings") render(); });
}

/** Who wrote a line about the person: themselves, an agent, or a routine. */
function personSource(source) {
  var parts = String(source || "").split(":");
  if (parts[0] === "agent") return agentName(parts.slice(1).join(":"));
  if (parts[0] === "routine") return parts.slice(1).join(":");
  return "";
}

function aboutMeBlock() {
  var box = el("section", "setting"), entries = mine.person.entries || [], field = el("select"), text = el("input"), add = el("button", "act", t("ui.next.mine.add")), row = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.mine.about")));
  box.appendChild(el("p", "why", t("ui.next.mine.aboutNote")));
  PERSON_FIELDS.forEach(function (name) {
    var lines = entries.filter(function (entry) { return entry.field === name; });
    var option = el("option", "", t("ui.next.mine.field." + name)); option.value = name; field.appendChild(option);
    if (!lines.length) return;
    box.appendChild(el("h2", "group", t("ui.next.mine.field." + name)));
    lines.forEach(function (entry) {
      var line = el("div", "fact"), who = personSource(entry.source), gone = el("button", "act", t("ui.next.mine.retract"));
      line.appendChild(el("span", "", entry.text + (who ? " · " + who : "")));
      gone.addEventListener("click", function () { postJson("/api/person/retract", { id: entry.id }).then(loadMine, failed); });
      line.appendChild(gone); box.appendChild(line);
    });
  });
  text.placeholder = t("ui.next.mine.addPlaceholder");
  add.addEventListener("click", function () {
    if (!text.value.trim()) { text.focus(); return; }
    postJson("/api/person", { field: field.value, text: text.value.trim() }).then(loadMine, failed);
  });
  row.appendChild(field); row.appendChild(text); row.appendChild(add); box.appendChild(row);
  return box;
}

function tokensBlock() {
  var box = el("section", "setting"), label = el("input"), issue = el("button", "act", t("ui.next.mine.issue")), row = el("div", "acts");
  box.appendChild(el("h2", "group", t("ui.next.mine.tokens")));
  box.appendChild(el("p", "why", t("ui.next.mine.tokensNote")));
  if (mine.issued) {
    // Shown this once: it is stored nowhere it could be read back from.
    var once = el("div", "needbox"), copy = el("button", "act", t("ui.next.msg.copy")), secret = mine.issued;
    once.appendChild(el("div", "", t("ui.next.mine.once"))); once.appendChild(el("code", "card-code", secret));
    copy.addEventListener("click", function () { navigator.clipboard.writeText(secret).then(function () { toast(t("ui.next.msg.copied")); }, failed); });
    once.appendChild(copy); box.appendChild(once);
  }
  (mine.tokens || []).forEach(function (token) {
    var line = el("div", "fact"), revoke = el("button", "act", t("ui.next.mine.revoke"));
    line.appendChild(el("span", "", (token.label || "") + " · " + new Date(token.createdAt).toLocaleDateString()));
    revoke.addEventListener("click", function () { postJson("/api/mcp/tokens/revoke", { createdAt: token.createdAt }).then(function () { mine.issued = ""; loadMine(); }, failed); });
    line.appendChild(revoke); box.appendChild(line);
  });
  label.placeholder = t("ui.next.mine.tokenLabel");
  issue.addEventListener("click", function () {
    postJson("/api/mcp/tokens", { label: label.value.trim() }).then(function (got) { mine.issued = got.token || ""; loadMine(); }, failed);
  });
  row.appendChild(label); row.appendChild(issue); box.appendChild(row);
  return box;
}

function standingBlock() {
  var policy = mine.policy || {}, standing = policy.standing || [], shadow = policy.tierShadow || {};
  if (!standing.length && !(shadow.mode === "shadow" && shadow.total > 0)) return null;
  var box = el("section", "setting");
  if (standing.length) {
    box.appendChild(el("h2", "group", t("ui.next.mine.standing")));
    box.appendChild(el("p", "why", t("ui.next.mine.standingNote")));
    standing.forEach(function (grant) {
      var line = el("div", "fact"), revoke = el("button", "act", t("ui.next.mine.revoke"));
      line.appendChild(el("span", "", agentName(grant.agentId) + " · " + grant.description));
      revoke.addEventListener("click", function () { postJson("/api/policy/revoke", { fingerprint: grant.fingerprint }).then(loadMine, failed); });
      line.appendChild(revoke); box.appendChild(line);
    });
  }
  if (shadow.mode === "shadow" && shadow.total > 0) {
    box.appendChild(el("h2", "group", t("ui.next.mine.wouldAsk", { n: shadow.total })));
    (shadow.tools || []).slice(0, 12).forEach(function (row) { box.appendChild(fact(row.tool, String(row.count))); });
  }
  return box;
}

function renderMinePane(view) {
  if (mine.person === null) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); loadMine(); return; }
  if (mine.error) view.appendChild(el("p", "why", mine.error));
  [aboutMeBlock(), tokensBlock(), standingBlock()].forEach(function (block) { if (block) view.appendChild(block); });
}
`;
