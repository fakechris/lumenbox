/**
 * Settings → Team → People on a single-machine installation (INV-1685, docs/22 §1a): the Owner's row
 * says "Owner · 机主" instead of a role picker, and any act that would let a second person in asks
 * first. `rosterFetch` is `fetch` for the roster's writes: when the server answers 409 with
 * `needs: "owner-conversion"`, it shows the dialog; on the person's yes it posts the conversion
 * with `confirm: true` and repeats the request, and on no it hands back the refusal and reloads
 * the list.
 */
export const INSTALLATION_JS = `(function () {
  function single() { var i = window.installation; return !!(i && i.mode === "single-machine"); }
  window.ownerBadge = function (person) {
    if (!single() || person.id !== window.installation.ownerId) return "";
    return '<span data-owner-badge class="dim" style="font-size:12px" title="{{ui.installation.the-one-person-on-this}}">{{ui.installation.owner}}</span>';
  };
  function ask(ownerName) {
    return new Promise(function (resolve) {
      var dialog = document.getElementById("ownerconvert");
      if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "ownerconvert";
        dialog.className = "modal";
        dialog.innerHTML = '<h3>{{ui.installation.add-a-second-person}}</h3>' +
          '<div style="font-size:13px;line-height:1.6">{{ui.installation.this-computer-has-one-owner}} <b data-owner-name></b>. ' +
          '{{ui.installation.adding-someone-makes-this-an}} ' +
          '{{ui.installation.the-change-is-recorded-with}}</div>' +
          '<div class="actions"><button class="btn accent" data-owner-confirm>{{ui.installation.convert-and-continue}}</button><button class="btn ghost" data-owner-cancel>{{ui.installation.cancel}}</button></div>';
        document.body.appendChild(dialog);
      }
      dialog.querySelector("[data-owner-name]").textContent = ownerName || "{{ui.installation.the-owner}}";
      var done = function (answer) { dialog.close(); resolve(answer); };
      dialog.querySelector("[data-owner-confirm]").onclick = function () { done(true); };
      dialog.querySelector("[data-owner-cancel]").onclick = function () { done(false); };
      dialog.oncancel = function (event) { event.preventDefault(); done(false); };
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    });
  }
  window.rosterFetch = function (url, init) {
    return fetch(url, init).then(function (response) {
      if (response.status !== 409) return response;
      return response.clone().json().catch(function () { return {}; }).then(function (body) {
        if (body.needs !== "owner-conversion") return response;
        var owner = (window.people || []).filter(function (p) { return window.installation && p.id === window.installation.ownerId; })[0];
        return ask(owner && owner.name).then(function (yes) {
          if (!yes) { if (window.renderChannels) window.renderChannels(); return response; }
          return fetch("/api/installation/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) })
            .then(function (converted) {
              if (!converted.ok) return converted;
              if (window.installation) window.installation = { mode: "organisation", ownerId: window.installation.ownerId };
              return fetch(url, init);
            });
        });
      });
    });
  };
})();
`;
