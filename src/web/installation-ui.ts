/**
 * Settings → Team → People on a personal installation (INV-1685, INV-1689, docs/22 §1a): the Owner's
 * row says "Owner · 机主" instead of a role picker, and any act that would let a second person in is
 * refused. `rosterFetch` is `fetch` for the roster's writes: when the server answers 409 with
 * `needs: "organisation"`, it shows why — this installation has only you; to work with others, join
 * or create an organisation — with the manual page in the page's language, reloads the list, and hands
 * back the refusal. Nothing here converts the installation: there is no conversion.
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
