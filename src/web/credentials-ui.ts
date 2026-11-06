/**
 * The page's half of the check before work starts (INV-1666). Its own script, like the other
 * sections: the page is at its size ceiling.
 *
 * - The "before this can start" card in an agent's thread: what is missing, why, and a button to
 *   the settings tab that fixes it. It settles by itself when the credential lands.
 * - The same list above the Tasks panel, when a task just created there is waiting.
 * - Settings → Team → Secrets: who needs each secret, and a Remove that says what it would break.
 */

export const CREDENTIALS_JS = `(function () {
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var STATE = { missing: ["{{ui.credentials.missing}}", "var(--danger)"], expiring: ["{{ui.credentials.expiring}}", "var(--warn)"], present: ["{{ui.credentials.in-place}}", "var(--muted)"] };

  function rows(items) {
    return (items || []).map(function (item) {
      var s = STATE[item.state] || STATE.missing;
      return '<div data-credential="' + esc(item.id) + '" style="display:flex;gap:8px;align-items:baseline;font-size:13px;padding:2px 0">' +
        '<span class="chip" style="font-size:10px;color:' + s[1] + '">' + esc(s[0]) + "</span>" +
        '<span style="flex:1;min-width:0"><b>' + esc(item.kind === "connector" ? "{{ui.credentials.connector}}" : "{{ui.credentials.secret}}") + " " + esc(item.id) + "</b> — " + esc(item.why) +
        ' <span class="dim" style="font-size:11px">{{ui.credentials.needed-by-2}} ' + esc((item.by || []).join(", ")) + ")</span></span>" +
        (item.state === "present" ? "" : '<a href="#" class="btn sm" data-open-settings="' + esc(item.where.tab) + '" style="text-decoration:none">' + esc(item.where.label.replace(/^Settings → /, "")) + "</a>") +
        "</div>";
    }).join("");
  }

  /** The card body; app-html draws the frame and settles it. */
  window.credentialsCardHtml = function (item, pending) {
    return '<div class="chead"><span class="dot"></span>{{ui.credentials.before}} ' + esc(item.agentName) + " {{ui.credentials.can-start}} " + esc(item.title) + "</div>" +
      (pending
        ? '<div class="note" style="margin:4px 0">{{ui.credentials.needed-and-not-here-yet}}</div>' + rows(item.items) +
          '<div class="note">{{ui.credentials.set-each-in-settings-the}}</div>'
        : '<div class="settledline"></div>');
  };

  /** Above the Tasks panel, for a task created there that is waiting. */
  window.showTaskCoverage = function (reply) {
    var list = document.getElementById("tasklist");
    if (!list || !reply || !reply.coverage) return;
    var box = document.getElementById("taskcoverage");
    if (!box) { box = document.createElement("div"); box.id = "taskcoverage"; list.parentNode.insertBefore(box, list); }
    box.innerHTML = '<div class="consent" style="margin:8px 16px">' +
      '<div class="chead"><span class="dot"></span>' + esc(reply.task.id) + " {{ui.credentials.is-waiting-before-it-can}}</div>" + rows(reply.coverage.items.filter(function (i) { return i.state !== "present"; })) +
      '<div class="note">{{ui.credentials.it-stays-blocked-on-the}} <a href="#" data-coverage-close="1">{{ui.credentials.dismiss}}</a></div></div>';
  };

  /** Settings → Team → Secrets: who needs this one, from the list's own read. */
  window.neededByHtml = function (id) {
    var who = (window.secretNeeds || {})[id];
    return who && who.length ? " {{ui.credentials.needed-by}} " + esc(who.join(", ")) : " {{ui.credentials.needed-by-nothing-here}}";
  };
  window.confirmRemoveSecret = function (id) {
    var who = (window.secretNeeds || {})[id];
    if (!who || !who.length) return true;
    return window.confirm(id + " {{ui.credentials.is-needed-by}} " + who.join(", ") + "{{ui.credentials.their-work-will-wait-for}}");
  };

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target.closest("[data-open-settings],[data-coverage-close]") : null;
    if (!target) return;
    event.preventDefault();
    if (target.getAttribute("data-coverage-close")) { var box = document.getElementById("taskcoverage"); if (box) box.innerHTML = ""; return; }
    if (typeof openSettings === "function") openSettings(target.getAttribute("data-open-settings"));
  });
})();
`;
