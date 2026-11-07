/**
 * The sidebar's first level (INV-1691, docs/95 §4): a column at the window's left edge listing the
 * installations this app is a client of — 个人 first, then each organisation by name — each with
 * the person's role there and its own counts: what needs the person (the badge) and what is unread.
 *
 * Only in the desktop app, and only once an organisation is joined: a column of one says nothing,
 * the same rule as the box bar. Selecting an organisation asks the shell to show it; the shell lays
 * the organisation's own page, served by its server, over everything right of this column
 * (electron/installation-views.cjs). This page never loads anything of the organisation: the
 * organisation's counts arrive from the shell as two numbers, and the personal counts are read here
 * from this page's own server. The items behind a count are read inside that installation.
 */
export const INSTALLATIONS_JS = `(function () {
  var shell = window.lumenboxShell && window.lumenboxShell.installations;
  if (!shell) return;
  var ROLE = { owner: "{{ui.installation.owner}}", admin: "{{ui.role.admin}}", driver: "{{ui.role.driver}}", viewer: "{{ui.role.viewer}}" };
  var style = document.createElement("style");
  style.textContent = [
    "#installrail { position: fixed; left: 0; top: 0; bottom: 0; width: 76px; z-index: 40; box-sizing: border-box; display: none; flex-direction: column; gap: 4px; padding: 40px 6px 8px; overflow-y: auto; background: var(--sidebar); border-right: 1px solid var(--border); -webkit-app-region: drag; }",
    "body.has-rail #installrail { display: flex; }",
    "body.has-rail { padding-left: 76px; }",
    "body.has-rail.electron-mac #topbar { padding-left: 14px; }",
    "#installrail .instl { -webkit-app-region: no-drag; font: inherit; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 2px; border: 1px solid transparent; border-radius: var(--radius-input); background: none; color: var(--text); cursor: pointer; }",
    "#installrail .instl:hover { background: var(--surface); }",
    "#installrail .instl[aria-current=true] { background: var(--surface); border-color: var(--border); }",
    "#installrail .instl-mark { position: relative; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 600; background: var(--accent-soft); color: var(--text); }",
    "#installrail .instl-need { position: absolute; top: -5px; right: -7px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; font-size: 10px; line-height: 16px; background: var(--warn); color: #fff; }",
    "#installrail .instl-name { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }",
    "#installrail .instl-role, #installrail .instl-unread { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted); }"
  ].join("\\n");
  document.head.appendChild(style);
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  var rail = el("nav", { id: "installrail", "aria-label": "{{ui.installations.installations}}" });
  document.body.appendChild(rail);
  var personal = { unknown: true };
  var last = [];
  /** This installation's counts, from this page's own server: unread across the agents, and what is owed by me. */
  function personalCounts() {
    var read = function (route) { return fetch(route, { headers: { accept: "application/json" } }).then(function (r) { if (!r.ok) throw new Error(route); return r.json(); }); };
    return Promise.all([read("/api/state"), read("/api/attention")]).then(function (both) {
      var unread = 0;
      (both[0].agents || []).forEach(function (a) { unread += Math.max(0, Math.floor((a.facts && a.facts.unreadCount) || 0)); });
      personal = { unread: unread, needsYou: (both[1].mine || []).length };
    }).catch(function () { personal = { unknown: true }; });
  }
  function nameOf(entry) { return entry.kind === "personal" ? "{{ui.installations.personal}}" : entry.name; }
  function summary(entry) {
    var parts = [nameOf(entry), ROLE[entry.role] || entry.role];
    if (entry.unknown) parts.push("{{ui.installations.counts-unknown}}");
    else { parts.push(entry.needsYou + " {{ui.installations.need-you}}"); parts.push(entry.unread + " {{ui.installations.unread}}"); }
    return parts.join(" · ");
  }
  function render(list) {
    last = list;
    rail.textContent = "";
    document.body.classList.toggle("has-rail", list.length > 1);
    list.forEach(function (entry) {
      var shown = entry.kind === "personal" ? Object.assign({}, entry, personal) : entry;
      var b = el("button", { type: "button", class: "instl", "data-install": entry.id, "aria-current": entry.selected ? "true" : "false", title: summary(shown), "aria-label": summary(shown) });
      var mark = el("span", { class: "instl-mark" }, nameOf(entry).charAt(0).toUpperCase());
      if (!shown.unknown && shown.needsYou > 0) mark.appendChild(el("span", { class: "instl-need", "data-install-need": entry.id }, String(shown.needsYou > 99 ? "99+" : shown.needsYou)));
      b.appendChild(mark);
      b.appendChild(el("span", { class: "instl-name" }, nameOf(entry)));
      b.appendChild(el("span", { class: "instl-role", "data-install-role": entry.id }, ROLE[entry.role] || entry.role));
      b.appendChild(el("span", { class: "instl-unread", "data-install-unread": entry.id }, shown.unknown ? "—" : shown.unread > 0 ? shown.unread + " {{ui.installations.unread}}" : ""));
      b.onclick = function () { choose(entry.id); };
      rail.appendChild(b);
    });
  }
  function choose(id) {
    shell.select(id, rail.offsetWidth).then(function (a) {
      if (a && a.error) { var b = rail.querySelector('[data-install="' + id + '"]'); if (b) b.title = "{{ui.organisations.why-no-token}}"; return; }
      refresh();
    });
  }
  function refresh() {
    return Promise.all([shell.list(), personalCounts()]).then(function (both) {
      var answer = both[0];
      if (answer && !answer.error) render(answer.installations || []);
    });
  }
  window.installRail = { refresh: refresh, entries: function () { return last; } };
  refresh();
  setInterval(refresh, 15000);
})();
`;
