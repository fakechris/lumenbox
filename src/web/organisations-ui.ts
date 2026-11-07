/**
 * Settings → Organisations (INV-1690, docs/95 §4): the organisations this app is connected to —
 * join one by its address or an invite link, open it, leave it.
 *
 * Only in the desktop app. A connection is the shell's, not this installation's: the page asks the
 * shell through the preload bridge (`window.lumenboxShell.organisations`, electron/preload.cjs), and
 * the personal server never sees an organisation's address, identity or token. In a browser there is
 * no bridge, and the tab is not mounted. The shell answers a refusal as a code; the words for it are
 * here, in the bundle (`ui.organisations.why-<code>`). Open shows the organisation in this window, beside the first level (installations-ui.ts, INV-1691).
 */
export const ORGANISATIONS_JS = `(function () {
  var shell = window.lumenboxShell && window.lumenboxShell.organisations;
  if (!shell) return;
  var WHY = {
    "no-address": "{{ui.organisations.why-no-address}}", "bad-address": "{{ui.organisations.why-bad-address}}", "not-https": "{{ui.organisations.why-not-https}}",
    unreachable: "{{ui.organisations.why-unreachable}}", "not-lumenbox": "{{ui.organisations.why-not-lumenbox}}", "not-signed-in": "{{ui.organisations.why-not-signed-in}}",
    "personal-installation": "{{ui.organisations.why-personal-installation}}", "no-token": "{{ui.organisations.why-no-token}}", refused: "{{ui.organisations.why-failed}}", failed: "{{ui.organisations.why-failed}}"
  };
  var ROLE = { admin: "{{ui.role.admin}}", driver: "{{ui.role.driver}}", viewer: "{{ui.role.viewer}}" };
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function why(answer) { return WHY[answer && answer.error] || WHY.failed; }
  var ui = {};
  function render(connections) {
    ui.list.textContent = "";
    if (!connections.length) { ui.list.appendChild(el("div", { class: "dim", "data-org-empty": "" }, "{{ui.organisations.not-connected-to-any-organisation}}")); return; }
    connections.forEach(function (c) {
      var row = el("div", { class: "ui-row ui-gap", "data-org": c.id });
      var who = el("div", { style: "flex:1;min-width:0" });
      who.appendChild(el("div", { style: "font-weight:600" }, c.name));
      who.appendChild(el("div", { class: "dim", style: "font-size:12px" }, c.origin + " · {{ui.organisations.you-are}} " + (c.person || c.identity) + " (" + (ROLE[c.role] || c.role) + ")"));
      var openBtn = el("button", { class: "btn", type: "button", "data-org-open": c.id }, "{{ui.organisations.open}}");
      openBtn.onclick = function () { shell.open(c.id).then(function (a) { ui.line.textContent = a.error ? why(a) : ""; if (!a.error) { document.getElementById("settingswrap").style.display = "none"; if (window.installRail) window.installRail.refresh(); } }); };
      var leave = el("button", { class: "btn ghost", type: "button", "data-org-leave": c.id }, "{{ui.organisations.disconnect}}");
      leave.onclick = function () {
        if (leave.getAttribute("data-sure") !== "1") { leave.setAttribute("data-sure", "1"); leave.textContent = "{{ui.organisations.disconnect-sure}}"; return; }
        shell.disconnect(c.id).then(function (a) { ui.line.textContent = a.error ? why(a) : "{{ui.organisations.disconnected}}"; load(); if (window.installRail) window.installRail.refresh(); });
      };
      row.appendChild(who); row.appendChild(openBtn); row.appendChild(leave);
      ui.list.appendChild(row);
    });
  }
  function load() { shell.list().then(function (a) { if (a.error) { ui.line.textContent = why(a); return; } render(a.connections || []); }); }
  function join() {
    ui.join.disabled = true;
    ui.line.textContent = "{{ui.organisations.sign-in-in-the-window}}";
    shell.join(ui.address.value, ui.name.value).then(function (a) {
      ui.join.disabled = false;
      if (a.error) { ui.line.textContent = why(a); return; }
      if (a.cancelled) { ui.line.textContent = "{{ui.organisations.sign-in-closed}}"; return; }
      ui.address.value = ""; ui.name.value = "";
      ui.line.textContent = "{{ui.organisations.joined}} " + a.connection.name + ".";
      load(); if (window.installRail) window.installRail.refresh();
    });
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("organisations")) return false;
    tabs.appendChild(el("a", { href: "#", class: "tab", "data-settab": "organisations" }, "{{ui.pane.organisations}}"));
    var wrap = el("div", { class: "field settab-off", "data-settab": "organisations", id: "organisations" });
    wrap.appendChild(el("label", {}, "{{ui.organisations.organisations}}"));
    wrap.appendChild(el("div", { class: "fieldnote" }, "{{ui.organisations.this-computer-is-your-personal}}"));
    ui.list = el("div", { class: "ui-gap", id: "organisationlist" });
    var form = el("div", { class: "ui-row ui-gap" });
    ui.address = el("input", { id: "organisationaddress", spellcheck: "false", placeholder: "{{ui.organisations.address-or-invite-link}}", style: "flex:2" });
    ui.name = el("input", { id: "organisationname", spellcheck: "false", placeholder: "{{ui.organisations.name-optional}}", style: "flex:1" });
    ui.join = el("button", { class: "btn accent", type: "button", id: "organisationjoin" }, "{{ui.organisations.join}}");
    ui.join.onclick = join;
    form.appendChild(ui.address); form.appendChild(ui.name); form.appendChild(ui.join);
    ui.line = el("div", { class: "fieldnote", id: "organisationline" });
    wrap.appendChild(ui.list); wrap.appendChild(form); wrap.appendChild(ui.line);
    modal.insertBefore(wrap, modal.querySelector(".actions"));
    tabs.addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "organisations") load(); });
    load();
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
})();
`;
