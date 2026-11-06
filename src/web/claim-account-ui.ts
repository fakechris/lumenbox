/**
 * The review card's account of a claimed goal (INV-1574): what the agent decided on the person's
 * behalf, what its checks did not cover, and the verifier's check of those decisions — shown on the
 * task above its history, so a person accepting the work reads them before the verdict.
 */
export const CLAIM_ACCOUNT_JS = `(function () {
  function list(title, entries) {
    if (!entries || !entries.length) return "";
    return '<div style="margin:4px 0"><div style="font-size:12px;font-weight:600">' + esc(title) + "</div>" +
      entries.map(function (entry) { return '<div style="font-size:12px;padding-left:12px">· ' + esc(entry) + "</div>"; }).join("") + "</div>";
  }
  window.claimAccountHtml = function (task) {
    var pursuit = task && task.pursuit;
    var claim = pursuit && pursuit.claim;
    if (!claim || (!(claim.decisions || []).length && !(claim.unchecked || []).length)) return "";
    var check = pursuit.lastVerdict && pursuit.lastVerdict.decisions;
    return '<div data-claim-account style="margin:0 0 8px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-md)">' +
      list("{{ui.claim-account.decided-on-your-behalf}}", claim.decisions) +
      list("{{ui.claim-account.not-covered-by-its-checks}}", claim.unchecked) +
      (check ? '<div class="dim" style="font-size:11px;margin-top:4px">{{ui.claim-account.verifier-on-these-decisions}} ' + esc(check) + "</div>" : "") +
    "</div>";
  };
})();
`;
