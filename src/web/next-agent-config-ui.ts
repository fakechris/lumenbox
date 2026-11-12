/**
 * The rest of an agent's configuration on the rebuilt page (INV-1825): which model it runs on and
 * which teams it is in, the files it reads every turn, and the versions its configuration has been
 * through. Each is a fold on the agent's page, read when opened; none is on a default surface.
 */
export const NEXT_AGENT_CONFIG_JS = `
var agentConfig = { presets: null, scopes: null, files: null, file: "AGENTS.md", cap: 0, versions: null, current: null, forId: "", template: null };
var STANDING_NAMES = ["AGENTS.md", "SOUL.md", "USER.md", "HEARTBEAT.md"];

/** Opened on another agent, what was read for the last one is not this one's. */
function agentConfigFor(id) {
  if (agentConfig.forId === id) return;
  agentConfig.forId = id; agentConfig.template = null; agentConfig.files = null; agentConfig.versions = null; agentConfig.current = null; agentConfig.file = STANDING_NAMES[0];
}

/** A fold whose body is drawn, and its data asked for, the first time it is opened. */
function lazyFold(title, key, draw) {
  var fold = el("details", "fold"), body = el("div", "fold-body");
  fold.appendChild(el("summary", "", title)); fold.appendChild(body);
  fold.open = member.open === key;
  fold.addEventListener("toggle", function () { member.open = fold.open ? key : (member.open === key ? "" : member.open); if (fold.open) draw(body); });
  if (fold.open) draw(body);
  return fold;
}

/** Model, teams and scope: part of the same save as the name. Empty means the installation's default. */
function modelFields(agent) {
  var provider = el("select"), scope = el("select"), model = field(t("ui.next.config.model"), agent.model || "");
  var teams = field(t("ui.next.config.teams"), (agent.tags || []).join(", "));
  var providerLabel = el("label", "", t("ui.next.config.provider")), scopeLabel = el("label", "", t("ui.next.config.scope"));
  var option = function (select, value, text, chosen) { var node = el("option", "", text); node.value = value; node.selected = chosen; select.appendChild(node); };
  var fill = function () {
    provider.replaceChildren(); scope.replaceChildren();
    option(provider, "", t("ui.next.config.default"), !agent.provider);
    (agentConfig.presets || []).forEach(function (preset) {
      option(provider, preset.name, preset.label + (preset.keyPresent ? "" : " · " + t("ui.next.config.noKey")), preset.name === agent.provider);
    });
    // A provider this installation no longer lists is still the agent's until somebody changes it.
    if (agent.provider && !(agentConfig.presets || []).some(function (preset) { return preset.name === agent.provider; })) option(provider, agent.provider, agent.provider, true);
    option(scope, "", t("ui.next.config.noScope"), !agent.scopeId);
    (agentConfig.scopes || []).forEach(function (row) { option(scope, row.id, row.name || row.id, row.id === agent.scopeId); });
    scopeLabel.hidden = !(agentConfig.scopes || []).length && !agent.scopeId;
  };
  providerLabel.appendChild(provider); scopeLabel.appendChild(scope);
  model.input.placeholder = t("ui.next.config.modelPlaceholder");
  fill();
  if (agentConfig.presets === null) {
    agentConfig.presets = [];
    getJson("/api/config").then(function (got) { agentConfig.presets = got.presets || []; fill(); }, function () {});
    // Scopes are an admin's to read: for anybody else there is simply none to choose.
    getJson("/api/scopes").then(function (got) { agentConfig.scopes = got.scopes || []; fill(); }, function () { agentConfig.scopes = []; });
  }
  return {
    nodes: [providerLabel, model.label, teams.label, scopeLabel],
    value: function () {
      var body = { provider: provider.value, model: model.input.value.trim(), tags: teams.input.value.split(",").map(function (tag) { return tag.trim(); }).filter(Boolean) };
      if (!scopeLabel.hidden) body.scopeId = scope.value;
      return body;
    },
  };
}

/** The files the agent reads every turn: one shown at a time, saved on its own. */
function standingFold(agent) {
  return lazyFold(t("ui.next.config.standing"), "standing", function (body) {
    if (agentConfig.files === null) {
      body.replaceChildren(el("p", "why", t("ui.next.auto.reading")));
      getJson("/api/standing?agent=" + encodeURIComponent(agent.id)).then(function (got) {
        agentConfig.files = got.files || {}; agentConfig.cap = got.cap || 0;
        if (member.id === agent.id) renderMember();
      }, function (error) { body.replaceChildren(el("p", "why", error.message)); });
      return;
    }
    var pick = el("select"), text = el("textarea"), save = el("button", "act", t("ui.next.config.saveFile")), row = el("div", "acts");
    STANDING_NAMES.forEach(function (name) { var node = el("option", "", name); node.value = name; node.selected = name === agentConfig.file; pick.appendChild(node); });
    text.value = agentConfig.files[agentConfig.file] || ""; text.rows = 12;
    pick.addEventListener("change", function () { agentConfig.file = pick.value; text.value = agentConfig.files[pick.value] || ""; });
    save.addEventListener("click", function () {
      save.disabled = true;
      postJson("/api/standing", { agent: agent.id, name: agentConfig.file, text: text.value }).then(function (got) {
        agentConfig.files = got.files || agentConfig.files; agentConfig.versions = null;
        save.disabled = false; toast(t("ui.next.settings.saved2"));
      }, function (error) { save.disabled = false; failed(error); });
    });
    row.appendChild(pick); row.appendChild(save);
    body.replaceChildren(el("p", "why", t("ui.next.config.standingNote", { name: agent.name })), row, text);
  });
}

/** What one version changed, in a line. */
function versionLine(version) {
  var fields = (version.changes || []).map(function (change) { return change.field; });
  return (version.restoredFrom ? t("ui.next.config.backTo", { n: version.restoredFrom }) + " · " : "") + (fields.length ? fields.join(", ") : t("ui.next.config.first"));
}

/** Every saved configuration, newest first; an earlier one can be gone back to. */
function historyFold(agent) {
  return lazyFold(t("ui.next.config.history"), "history", function (body) {
    if (agentConfig.versions === null) {
      body.replaceChildren(el("p", "why", t("ui.next.auto.reading")));
      getJson("/api/agents/config-versions?agent=" + encodeURIComponent(agent.id)).then(function (got) {
        agentConfig.versions = got.versions || []; agentConfig.current = got.current;
        if (member.id === agent.id) renderMember();
      }, function (error) { body.replaceChildren(el("p", "why", error.message)); });
      return;
    }
    body.replaceChildren();
    if (agentConfig.versions.length === 0) body.appendChild(el("p", "why", t("ui.next.config.noHistory")));
    agentConfig.versions.slice().sort(function (a, b) { return b.n - a.n; }).slice(0, 30).forEach(function (version) {
      var line = el("div", "fact"), left = el("span", "why", "v" + version.n + " · " + new Date(version.at).toLocaleString() + " · " + agentName(version.by));
      line.appendChild(left); line.appendChild(el("span", "", versionLine(version)));
      if (version.n === agentConfig.current) left.textContent += " · " + t("ui.next.config.now");
      else {
        var back = el("button", "act", t("ui.next.config.restore"));
        back.addEventListener("click", function () {
          back.disabled = true;
          postJson("/api/agents/config-versions/restore", { agent: agent.id, version: version.n }).then(function () {
            agentConfig.versions = null; agentConfig.files = null;
            toast(t("ui.next.config.restored", { n: version.n })); refresh().then(renderMember);
          }, function (error) { back.disabled = false; failed(error); });
        });
        line.appendChild(back);
      }
      body.appendChild(line);
    });
  });
}

/**
 * The agent as something others can start from: it drafts a template of itself, a person looks at
 * what was staged, and only a person publishes it or takes it down.
 */
function templateFold(agent) {
  return lazyFold(t("ui.next.template.title"), "template", function (body) {
    var again = function () { agentConfig.template = null; if (member.id === agent.id) renderMember(); };
    if (agentConfig.template === null) {
      body.replaceChildren(el("p", "why", t("ui.next.auto.reading")));
      getJson("/api/templates/mine?agent=" + encodeURIComponent(agent.id)).then(function (got) {
        agentConfig.template = got;
        if (member.id === agent.id) renderMember();
      }, function (error) { body.replaceChildren(el("p", "why", error.message)); });
      return;
    }
    var mine = agentConfig.template, versions = mine.versions || [], draft = el("button", "act", t("ui.next.template.draft", { name: agent.name }));
    body.replaceChildren(el("p", "why", t("ui.next.template.note")));
    draft.addEventListener("click", function () {
      draft.disabled = true;
      postJson("/api/templates/share", { agent: agent.id }).then(function () { toast(t("ui.next.template.asked", { name: agent.name })); }, function (error) { draft.disabled = false; failed(error); });
    });
    body.appendChild(draft);
    versions.slice().reverse().forEach(function (version) {
      var line = el("div", "fact"), get = el("a", "act", t("ui.next.template.download"));
      get.href = "/api/templates/download?agent=" + encodeURIComponent(agent.id) + "&version=" + encodeURIComponent(version.version);
      line.appendChild(el("span", "why", "v" + version.version + " · " + (version.name || "") + " · " + new Date(version.stagedAt).toLocaleDateString()));
      line.appendChild(get); body.appendChild(line);
    });
    if (mine.share && mine.share.published) {
      var down = el("button", "act", t("ui.next.template.unpublish"));
      down.addEventListener("click", function () { postJson("/api/templates/unpublish", { agent: agent.id }).then(again, failed); });
      body.appendChild(fact(t("ui.next.template.published", { version: mine.share.version }), mine.share.url || ""));
      body.appendChild(down);
    } else if (versions.length && mine.canPublish) {
      var who = el("select"), publish = el("button", "act-primary", t("ui.next.template.publish")), row = el("div", "acts");
      ["tenant", "public"].forEach(function (value) { var node = el("option", "", t("ui.next.template.to." + value)); node.value = value; who.appendChild(node); });
      publish.addEventListener("click", function () {
        publish.disabled = true;
        postJson("/api/templates/publish", { agent: agent.id, visibility: who.value }).then(again, function (error) { publish.disabled = false; failed(error); });
      });
      row.appendChild(who); row.appendChild(publish); body.appendChild(row);
    } else if (versions.length) body.appendChild(el("p", "why", t("ui.next.template.cannotPublish")));
  });
}
`;
