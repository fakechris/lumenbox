/**
 * Settings → Memory → what the organisation knows (INV-1730): each item a person may read, with
 * its state and its supersession chain, and the three correction verbs — unverify, supersede,
 * retract — each asking for its reason before it is applied. Nothing here edits or deletes.
 */

export const ORG_CORRECTION_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw Object.assign(new Error(d.error || ("HTTP " + r.status)), { data: d }); return d; }); });
  }
  var STATE = { standing: "{{ui.org-correction.state-standing}}", unverified: "{{ui.org-correction.state-unverified}}", stale: "{{ui.org-correction.state-stale}}", superseded: "{{ui.org-correction.state-superseded}}", retracted: "{{ui.org-correction.state-retracted}}", expired: "{{ui.org-correction.state-expired}}", restated: "{{ui.org-correction.state-restated}}" };
  var DONE = { unverify: "{{ui.org-correction.done-unverified}}", supersede: "{{ui.org-correction.done-superseded}}", retract: "{{ui.org-correction.done-retracted}}" };
  var list, note;
  function day(s) { return (s || "").slice(0, 10); }
  function form(row, item, verb) {
    var open = row.querySelector("[data-org-form]"); if (open) open.remove();
    var box = el("div", { class: "ui-row", "data-org-form": verb, style: "flex-wrap:wrap;gap:6px;margin-top:4px" });
    var text = verb === "supersede" ? el("input", { placeholder: "{{ui.org-correction.new-text}}", "data-org-text": "", style: "flex:1 1 100%" }) : null;
    var evidence = verb === "supersede" ? el("input", { placeholder: "{{ui.org-correction.evidence}}", "data-org-evidence": "", style: "flex:1 1 100%" }) : null;
    var reason = verb === "supersede" ? null : el("input", { placeholder: "{{ui.org-correction.reason}}", "data-org-reason": "", style: "flex:1;min-width:160px" });
    [text, evidence, reason].forEach(function (input) { if (input) box.appendChild(input); });
    var go = el("button", { class: "btn sm", "data-org-confirm": verb }, "{{ui.org-correction.confirm}}");
    var cancel = el("button", { class: "btn sm ghost" }, "{{ui.org-correction.cancel}}");
    cancel.onclick = function () { box.remove(); };
    go.onclick = function () {
      go.disabled = true;
      var body = { verb: verb, id: item.id, reason: reason ? reason.value : "" };
      if (text) { body.text = text.value; body.evidence = evidence.value.split(","); }
      call("POST", "/api/memory/org/correct", body)
        .then(function (d) { note.textContent = DONE[verb]; render(d); })
        .catch(function (e) { note.textContent = e.message; go.disabled = false; });
    };
    box.appendChild(go); box.appendChild(cancel);
    row.appendChild(box);
    (text || reason).focus();
  }
  function render(d) {
    list.textContent = "";
    var items = d.items || [];
    if (items.length === 0) { list.appendChild(el("div", { class: "fieldnote" }, "{{ui.org-correction.none}}")); return; }
    items.forEach(function (item) {
      var gone = item.state === "superseded" || item.state === "retracted" || item.state === "expired" || item.state === "restated";
      var row = el("div", { class: "ui-gap", "data-org-item": item.id, "data-org-state": item.state, style: gone ? "opacity:.6" : "" });
      var head = el("div", { class: "ui-list-row" });
      head.appendChild(el("span", { class: "ui-grow", title: item.text, style: gone ? "text-decoration:line-through" : "" }, item.text));
      head.appendChild(el("span", { class: "ui-badge dim", "data-state": item.state }, STATE[item.state] || item.state));
      head.appendChild(el("code", { class: "dim" }, item.id));
      row.appendChild(head);
      var facts = [item.scopeName, "{{ui.org-correction.owner}} " + (item.ownerName || item.owner || "?")];
      if (item.verifiedBy) facts.push("{{ui.org-correction.verified-by}} " + item.verifiedBy + " " + day(item.verifiedAt));
      if (item.reviewBy) facts.push("{{ui.org-correction.review-by}} " + day(item.reviewBy));
      if (item.surface === "cite-only") facts.push("{{ui.org-correction.cite-only}}");
      if (item.pinned) facts.push("{{ui.org-correction.pinned}}");
      if (item.evidence && item.evidence.length) facts.push(item.evidence.join(", "));
      row.appendChild(el("div", { class: "fieldnote", style: "margin:0" }, facts.join(" · ")));
      var chain = [];
      if (item.supersedes) chain.push("{{ui.org-correction.replaces}} " + item.supersedes);
      if (item.supersededBy) chain.push("{{ui.org-correction.replaced-by}} " + item.supersededBy + " " + day(item.validUntil));
      if (item.correction) chain.push((item.correction.verb === "retract" ? "{{ui.org-correction.retracted-by}} " : "{{ui.org-correction.unverified-by}} ") + item.correction.byName + " " + day(item.correction.at) + ": " + item.correction.reason);
      if (chain.length) row.appendChild(el("div", { class: "fieldnote", "data-org-chain": "", style: "margin:0" }, chain.join(" · ")));
      var actions = el("div", { class: "ui-row" });
      [["unverify", "{{ui.org-correction.unverify}}"], ["supersede", "{{ui.org-correction.supersede}}"], ["retract", "{{ui.org-correction.retract}}"]].forEach(function (pair) {
        if (!item.may || !item.may[pair[0]]) return;
        var b = el("button", { class: "btn sm", "data-org-verb": pair[0] }, pair[1]);
        b.onclick = function () { form(row, item, pair[0]); };
        actions.appendChild(b);
      });
      if (actions.childNodes.length) row.appendChild(actions);
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/memory/org/items").then(render).catch(function () {}); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var memory = modal && modal.querySelector('.field[data-settab="memory"]');
    if (!memory || document.getElementById("orgcorrections")) return false;
    var field = el("div", { class: "field settab-off", "data-settab": "memory", id: "orgcorrections" });
    field.appendChild(el("label", {}, "{{ui.org-correction.title}}"));
    field.appendChild(el("div", { class: "fieldnote", style: "margin:0" }, "{{ui.org-correction.about}}"));
    list = el("div", { id: "orgcorrectionlist", class: "ui-gap", style: "max-height:360px;overflow:auto" });
    note = el("div", { class: "fieldnote", id: "orgcorrectionnote", role: "status" }, "");
    field.appendChild(list); field.appendChild(note);
    var after = document.getElementById("orgknowledge") || memory; // below the review of what waits (INV-1729), when it is there
    after.parentNode.insertBefore(field, after.nextSibling);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "memory") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
