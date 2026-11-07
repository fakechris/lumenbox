/**
 * Settings → Team → People on a personal installation (INV-1685, INV-1689, docs/22 §1a): the Owner's
 * row says "Owner · 机主" instead of a role picker, and any act that would let a second person in is
 * refused. `rosterFetch` is `fetch` for the roster's writes: when the server answers 409 with
 * `needs: "organisation"`, it shows why — this installation has only you; to work with others, join
 * or create an organisation — with the manual page in the page's language, reloads the list, and hands
 * back the refusal. Nothing here converts the installation: there is no conversion.
 *
 * INV-1698: on a personal installation the invite button makes a code for the Owner's own other
 * account (another Feishu app, DingTalk, a browser), which links to the Owner and adds nobody. On a
 * desktop roster with no installation field, People offers "these are all me": a preview from
 * `GET /api/installation/merge` — each person's doors and when each was last heard from, what
 * points to one person, what the merge would change — and a merge only after the person ticks
 * that every one of them is them. The merge runs at the restart that follows.
 */
export const INSTALLATION_JS = `(function () {
  function single() { var i = window.installation; return !!(i && i.mode === "single-machine"); }
  window.ownerBadge = function (person) {
    if (!single() || person.id !== window.installation.ownerId) return "";
    return '<span data-owner-badge class="dim" style="font-size:12px" title="{{ui.installation.the-one-person-on-this}}">{{ui.installation.owner}}</span>';
  };
  function explain() {
    var dialog = document.getElementById("personalonly");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "personalonly";
      dialog.className = "modal";
      dialog.innerHTML = '<h3>{{ui.installation.only-you-here}}</h3>' +
        '<div style="font-size:13px;line-height:1.6">{{ui.installation.personal-only}}</div>' +
        '<div class="actions"><a class="btn ghost" data-personal-manual target="_blank" rel="noopener">{{ui.installation.how-to-work-with-others}}</a><button class="btn accent" data-personal-ok>{{ui.installation.ok}}</button></div>';
      document.body.appendChild(dialog);
    }
    dialog.querySelector("[data-personal-manual]").setAttribute("href", "{{ui.manualUrl.personal-only}}");
    dialog.querySelector("[data-personal-ok]").onclick = function () { dialog.close(); };
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  }
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  window.inviteBody = function (role) { return single() ? { principalId: window.installation.ownerId } : { role: role }; };
  var STORES = {
    "mcp-tokens": "{{ui.merge.store.mcp-tokens}}", watchdog: "{{ui.merge.store.watchdog}}", tasks: "{{ui.merge.store.tasks}}", spend: "{{ui.merge.store.spend}}",
    memory: "{{ui.merge.store.memory}}", "person-notes": "{{ui.merge.store.person-notes}}", "box-members": "{{ui.merge.store.box-members}}", "personal-boxes": "{{ui.merge.store.personal-boxes}}",
    "vault-grants": "{{ui.merge.store.vault-grants}}", rules: "{{ui.merge.store.rules}}", "box-quotas": "{{ui.merge.store.box-quotas}}", sessions: "{{ui.merge.store.sessions}}",
    turns: "{{ui.merge.store.turns}}", inbox: "{{ui.merge.store.inbox}}"
  };
  function day(at) { return at ? new Date(at).toLocaleString() : "{{ui.merge.never-heard}}"; }
  function previewHtml(p) {
    var people = p.people.map(function (person) {
      var doors = person.identities.map(function (item) {
        return '<div class="mono dim" style="font-size:11px">' + esc(item.door) + (item.doorType && item.doorType !== item.door ? " (" + esc(item.doorType) + ")" : "") +
          " · " + esc(item.identity) + " · {{ui.merge.last-heard}} " + esc(day(item.lastSeen)) + "</div>";
      }).join("");
      return '<div data-merge-person style="padding:6px 0;border-top:1px solid var(--border)"><b>' + esc(person.name) + '</b> <span class="dim" style="font-size:12px">' + esc(person.role) +
        " · {{ui.merge.last-active}} " + esc(day(person.lastActive)) + "</span>" + doors + "</div>";
    }).join("");
    var hints = p.hints.map(function (h) {
      return "<li>" + (h.kind === "same-name" ? esc(h.name) + " — {{ui.merge.hint-same-name}} (" + h.count + ")" : esc(h.door) + " — {{ui.merge.hint-same-door}} (" + h.count + ")") + "</li>";
    }).join("");
    var changes = '<li>{{ui.merge.people-become-one}} (' + p.people.length + " → 1)</li>" + p.changes.map(function (c) {
      return "<li>" + esc(STORES[c.store] || c.store) + ": " + c.records + "</li>";
    }).join("");
    return '<h3>{{ui.merge.title}}</h3><div style="font-size:13px;line-height:1.6">{{ui.merge.lead}}</div>' +
      '<div style="max-height:220px;overflow:auto;margin:8px 0">' + people + "</div>" +
      (hints ? '<div style="font-size:13px"><b>{{ui.merge.what-points-to-you}}</b><ul style="margin:4px 0 8px 18px">' + hints + "</ul></div>" : "") +
      '<div style="font-size:13px"><b>{{ui.merge.what-changes}}</b><ul data-merge-changes style="margin:4px 0 8px 18px">' + changes + "</ul>" +
      '<div class="fieldnote">{{ui.merge.kept}}</div></div>' +
      '<label style="display:block;font-size:13px;margin-top:8px">{{ui.merge.owner-name}} <input data-merge-name value="' + esc(p.ownerName) + '" style="width:60%"></label>' +
      '<label style="display:block;font-size:13px;margin-top:8px"><input type="checkbox" data-merge-sure> {{ui.merge.all-me}}</label>' +
      '<div class="fieldnote" data-merge-status></div>' +
      '<div class="actions"><button class="btn ghost" data-merge-cancel>{{ui.merge.not-now}}</button><button class="btn accent" data-merge-go disabled>{{ui.merge.merge}}</button></div>';
  }
  function review(preview) {
    var dialog = document.getElementById("selfmerge");
    if (!dialog) { dialog = document.createElement("dialog"); dialog.id = "selfmerge"; dialog.className = "modal"; document.body.appendChild(dialog); }
    dialog.innerHTML = previewHtml(preview);
    var go = dialog.querySelector("[data-merge-go]");
    var status = dialog.querySelector("[data-merge-status]");
    dialog.querySelector("[data-merge-sure]").onchange = function (event) { go.disabled = !event.target.checked; };
    dialog.querySelector("[data-merge-cancel]").onclick = function () { dialog.close(); };
    go.onclick = function () {
      go.disabled = true;
      status.textContent = "…";
      fetch("/api/installation/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, digest: preview.digest, name: dialog.querySelector("[data-merge-name]").value }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { status.textContent = res.d.error || "{{ui.merge.failed}}"; return; }
          status.textContent = "{{ui.merge.restarting}}";
          return fetch("/api/restart", { method: "POST" }).then(function () { if (window.waitForRestart) window.waitForRestart(); else setTimeout(function () { location.reload(); }, 1500); });
        })
        .catch(function () { status.textContent = "{{ui.merge.failed}}"; });
    };
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
  }
  window.afterPeople = function () {
    var field = document.getElementById("setpeople");
    if (!field) return;
    var select = document.getElementById("setinvrole");
    var button = document.getElementById("setinvite");
    if (single()) {
      if (select) select.style.display = "none";
      if (button) button.textContent = "{{ui.installation.link-my-account}}";
      var owner = (window.rosterPeople || []).filter(function (p) { return p.id === window.installation.ownerId; })[0];
      var badge = document.querySelector("[data-owner-badge]");
      if (badge && owner && owner.aliases && owner.aliases.length) badge.setAttribute("title", "{{ui.installation.the-one-person-on-this}} {{ui.merge.aliases}} " + owner.aliases.join(", "));
      return;
    }
    if (document.getElementById("selfmergebanner")) return;
    fetch("/api/installation/merge").then(function (r) { return r.ok ? r.json() : undefined; }).then(function (preview) {
      if (!preview || !preview.offered || document.getElementById("selfmergebanner")) return;
      var banner = document.createElement("div");
      banner.id = "selfmergebanner";
      banner.className = "fieldnote";
      banner.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 6px";
      banner.innerHTML = "<span>{{ui.merge.banner}}</span>";
      var open = document.createElement("button");
      open.className = "btn sm";
      open.textContent = "{{ui.merge.review}}";
      open.onclick = function (event) { event.preventDefault(); fetch("/api/installation/merge").then(function (r) { return r.json(); }).then(review); };
      banner.appendChild(open);
      field.parentNode.insertBefore(banner, field);
    }).catch(function () {});
  };
  window.rosterFetch = function (url, init) {
    return fetch(url, init).then(function (response) {
      if (response.status !== 409) return response;
      return response.clone().json().catch(function () { return {}; }).then(function (body) {
        if (body.needs !== "organisation") return response;
        explain();
        if (window.renderChannels) window.renderChannels();
        return response;
      });
    });
  };
})();
`;
