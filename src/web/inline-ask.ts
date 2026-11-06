/**
 * `askInline`: the page's way to ask for one line of text (INV-1540). The desktop app is Electron,
 * and Electron has no `prompt()` — it throws "prompt() is not supported", so an action built on it
 * did nothing when clicked. This opens a small card under the element that was clicked, with the
 * question, a field, OK and Cancel, and resolves with what was typed, or null when cancelled
 * (Cancel, Escape, or another question opening). `type` is the input's type, e.g. "date".
 *
 * Loaded with the page's other scripts (`/app/supervision.js`), before the main one, so the page
 * can call `askInline` anywhere.
 */

export const INLINE_ASK_JS = `(function () {
  var open = null;
  function close(value) { if (!open) return; var o = open; open = null; o.card.remove(); o.resolve(value); }
  window.askInline = function (anchor, question, initial, type) {
    close(null);
    return new Promise(function (resolve) {
      var card = document.createElement("div");
      card.id = "inlineask";
      card.className = "ui-ask";
      var text = document.createElement("div");
      text.className = "ui-pre";
      text.textContent = question;
      var field = document.createElement("input");
      field.type = type || "text";
      field.id = "inlineaskfield";
      field.value = initial || "";
      var ok = document.createElement("button"); ok.className = "btn accent"; ok.id = "inlineaskok"; ok.textContent = "OK";
      var cancel = document.createElement("button"); cancel.className = "btn ghost"; cancel.textContent = "{{ui.inline-ask.cancel}}";
      var row = document.createElement("div"); row.className = "ui-actions";
      row.appendChild(cancel); row.appendChild(ok);
      card.appendChild(text); card.appendChild(field); card.appendChild(row);
      document.body.appendChild(card);
      var at = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 20, bottom: 20 };
      card.style.left = Math.max(8, Math.min(at.left, window.innerWidth - card.offsetWidth - 8)) + "px";
      card.style.top = Math.max(8, Math.min(at.bottom + 4, window.innerHeight - card.offsetHeight - 8)) + "px";
      open = { card: card, resolve: resolve };
      ok.onclick = function () { close(field.value); };
      cancel.onclick = function () { close(null); };
      field.onkeydown = function (event) {
        if (event.key === "Enter") { event.preventDefault(); close(field.value); }
        if (event.key === "Escape") { event.preventDefault(); close(null); }
      };
      field.focus(); field.select();
    });
  };
})();
`;
