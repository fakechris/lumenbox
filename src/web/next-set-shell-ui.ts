/**
 * The two settings that belong to the desktop app rather than to a server, on the rebuilt page
 * (INV-1825): what this machine is for, and the organisations it is connected to. They are asked of
 * the app's own shell, not over HTTP, and are simply absent in a browser. The words are the ones the
 * classic page already has for them.
 */
export const NEXT_SET_SHELL_JS = `
var shellSet = { machine: null, connections: null, note: "" };
function appShell() { return window.lumenboxShell || {}; }
/** The panes the desktop app adds to the list: none in a browser. */
function shellPanes() { var shell = appShell(); return (shell.machine ? ["machine"] : []).concat(shell.organisations ? ["organisations"] : []); }
/** Why the shell refused, in the words there are for it; a refusal with no words of its own is said plainly to have failed. */
function machineWhy(answer) { var code = (answer && answer.error) || "failed"; return MSG["ui.machine.why-" + code] ? t("ui.machine.why-" + code) : t("ui.machine.why-failed"); }
function organisationWhy(answer) {
  var code = (answer && answer.error) || "failed";
  return MSG["ui.organisations.why-" + code] ? t("ui.organisations.why-" + code) : t("ui.organisations.why-failed");
}

function renderMachinePane(view) {
  var shell = appShell().machine, box = el("section", "setting");
  if (!shell) { view.appendChild(el("p", "empty", t("ui.next.shell.appOnly"))); return; }
  if (!shellSet.machine) { view.appendChild(el("p", "empty", t("ui.next.auto.reading"))); shell.get().then(function (got) { shellSet.machine = got || {}; render(); }); return; }
  var state = shellSet.machine, acts = el("div", "acts"), again = function () { shellSet.machine = null; render(); };
  box.appendChild(el("h2", "group", t("ui.machine.use." + state.use)));
  box.appendChild(el("p", "why", t("ui.machine.use." + state.use + "-about")));
  box.appendChild(fact(t("ui.machine.organisations-connected"), String(state.connections || 0)));
  if (shellSet.note) box.appendChild(el("p", "why", shellSet.note));
  if (state.use === "personal") {
    var add = el("button", "act", t("ui.machine.add-organisation"));
    add.addEventListener("click", function () {
      shell.change("personal-organisation").then(function (got) {
        if (got && got.error) { shellSet.note = machineWhy(got); again(); return; }
        shellSet.note = ""; shellSet.machine = null; openSettingsPane("organisations");
      });
    });
    acts.appendChild(add);
  }
  if (state.use === "personal-organisation") {
    var back = el("button", "act", t("ui.machine.back-to-personal"));
    back.addEventListener("click", function () {
      // Going back disconnects every organisation: asked for twice when there is one.
      if (state.connections > 0 && back.className !== "act-danger") { back.className = "act-danger"; back.textContent = t("ui.machine.back-to-personal-sure"); return; }
      shell.change("personal").then(function (got) { shellSet.note = got && got.error ? machineWhy(got) : t("ui.machine.changed"); again(); });
    });
    acts.appendChild(back);
  }
  box.appendChild(acts); view.appendChild(box);
}

function renderOrganisationsPane(view) {
  var shell = appShell().organisations, box = el("section", "setting");
  if (!shell) { view.appendChild(el("p", "empty", t("ui.next.shell.appOnly"))); return; }
  if (!shellSet.connections) {
    view.appendChild(el("p", "empty", t("ui.next.auto.reading")));
    shell.list().then(function (got) { shellSet.connections = (got && got.connections) || []; if (got && got.error) shellSet.note = organisationWhy(got); render(); });
    return;
  }
  var again = function () { shellSet.connections = null; render(); };
  box.appendChild(el("h2", "group", t("ui.organisations.organisations")));
  if (shellSet.note) box.appendChild(el("p", "why", shellSet.note));
  if (!shellSet.connections.length) box.appendChild(el("p", "why", t("ui.organisations.not-connected-to-any-organisation")));
  shellSet.connections.forEach(function (connection) {
    var line = el("div", "fact"), text = el("span", ""), acts = el("span", "acts"), open = el("button", "act", t("ui.organisations.open")), leave = el("button", "act", t("ui.organisations.disconnect"));
    text.appendChild(el("b", "", connection.name));
    text.appendChild(el("div", "why", connection.origin + " · " + t("ui.organisations.you-are") + " " + (connection.person || connection.identity || "") + " (" + connection.role + ")"));
    open.addEventListener("click", function () { shell.open(connection.id).then(function (got) { if (got && got.error) { shellSet.note = organisationWhy(got); render(); } }); });
    leave.addEventListener("click", function () {
      if (leave.className !== "act-danger") { leave.className = "act-danger"; leave.textContent = t("ui.organisations.disconnect-sure"); return; }
      shell.disconnect(connection.id).then(function (got) { shellSet.note = got && got.error ? organisationWhy(got) : t("ui.organisations.disconnected"); again(); });
    });
    acts.appendChild(open); acts.appendChild(leave); line.appendChild(text); line.appendChild(acts); box.appendChild(line);
  });
  var address = el("input"), name = el("input"), join = el("button", "act-primary", t("ui.organisations.join"));
  address.placeholder = t("ui.organisations.address-or-invite-link"); name.placeholder = t("ui.organisations.name-optional");
  join.addEventListener("click", function () {
    if (!address.value.trim()) { address.focus(); return; }
    join.disabled = true; shellSet.note = t("ui.organisations.sign-in-in-the-window");
    shell.join(address.value.trim(), name.value.trim()).then(function (got) {
      shellSet.note = got && got.error ? organisationWhy(got) : got && got.cancelled ? t("ui.organisations.sign-in-closed") : t("ui.organisations.joined") + " " + ((got.connection || {}).name || "");
      again();
    });
  });
  [labelled(t("ui.organisations.address-or-invite-link"), address), labelled(t("ui.organisations.name-optional"), name), join].forEach(function (node) { box.appendChild(node); });
  view.appendChild(box);
}
`;
