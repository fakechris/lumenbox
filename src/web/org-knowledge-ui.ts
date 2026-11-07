/**
 * The organisation's knowledge on the page (INV-1729, docs/98 §5): Admin only.
 *
 * - Settings → Memory gains "Organisation knowledge": what waits for review, each with its scope
 *   and who will read it once approved, the person accountable, who proposed it and what it rests
 *   on; Approve (optionally pinned, read on every turn) or Reject. No switch: review is always on.
 * - Each live line in an agent's memory gets "Promote", and a task card gets the same for a
 *   finished task's outcome and for each receipt written about the task (`orgPromoteHtml(task)`).
 *   Promoting asks for the statement and the scope, and makes a proposal that waits here too.
 */

export const ORG_KNOWLEDGE_JS = `(function () {
  function admin() { return typeof myRole === "undefined" || myRole === "admin"; }
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw Object.assign(new Error(d.error || ("HTTP " + r.status)), { data: d }); return d; }); });
  }
  function readersText(r) {
    if (!r || r.kind === "nobody") return "{{ui.org-knowledge.readers-nobody}}";
    if (r.kind === "org") return "{{ui.org-knowledge.readers-org}}";
    var who = r.members === "everyone" ? "{{ui.org-knowledge.readers-box-everyone}}" : r.members.length ? r.members.join(", ") : "{{ui.org-knowledge.readers-box-nobody}}";
    return "{{ui.org-knowledge.readers-box}} " + r.boxName + " — " + who;
  }

  /** The statement and the scope, in a card under the element clicked; resolves null when cancelled. */
  var asking = null;
  function askPromote(anchor, initial) {
    if (asking) asking.close(null);
    return new Promise(function (resolve) {
      var card = el("div", { id: "orgpromoteask", class: "ui-ask" });
      card.appendChild(el("div", { class: "ui-pre" }, "{{ui.org-knowledge.promote-question}}"));
      var field = el("input", { type: "text", id: "orgpromotetext" }); field.value = initial || "";
      var scope = el("select", { id: "orgpromotescope" });
      scope.appendChild(el("option", { value: "org" }, "{{ui.org-knowledge.scope-org}}"));
      scope.appendChild(el("option", { value: "box" }, "{{ui.org-knowledge.scope-box}}"));
      var ok = el("button", { class: "btn accent", id: "orgpromoteok" }, "{{ui.org-knowledge.propose}}");
      var cancel = el("button", { class: "btn ghost" }, "{{ui.inline-ask.cancel}}");
      var row = el("div", { class: "ui-actions" }); row.appendChild(cancel); row.appendChild(ok);
      card.appendChild(field); card.appendChild(scope); card.appendChild(el("div", { class: "fieldnote" }, "{{ui.org-knowledge.promote-waits}}")); card.appendChild(row);
      document.body.appendChild(card);
      var at = anchor.getBoundingClientRect();
      card.style.left = Math.max(8, Math.min(at.left, window.innerWidth - card.offsetWidth - 8)) + "px";
      card.style.top = Math.max(8, Math.min(at.bottom + 4, window.innerHeight - card.offsetHeight - 8)) + "px";
      asking = { close: function (value) { asking = null; card.remove(); resolve(value); } };
      ok.onclick = function () { asking.close({ text: field.value.trim(), scope: scope.value }); };
      cancel.onclick = function () { asking.close(null); };
      field.onkeydown = function (event) { if (event.key === "Escape") { event.preventDefault(); asking.close(null); } };
      field.focus();
    });
  }
  function promote(anchor, initial, body) {
    askPromote(anchor, initial).then(function (answer) {
      if (!answer) return;
      body.scope = answer.scope; if (answer.text) body.text = answer.text;
      call("POST", "/api/org-knowledge/promote", body)
        .then(function (d) { render(d); alert("{{ui.org-knowledge.proposed}}"); })
        .catch(function (e) { alert(e.message); });
    });
  }

  // Settings → Memory: what waits for review.
  var list, note;
  function render(d) {
    if (!list) return;
    list.textContent = "";
    var pending = (d && d.pending) || [];
    if (!pending.length) { list.appendChild(el("div", { class: "fieldnote" }, "{{ui.org-knowledge.nothing-waiting}}")); return; }
    pending.forEach(function (item) {
      var row = el("div", { class: "ui-gap", "data-org-review": item.version, style: "border-top:1px solid var(--border);padding-top:6px" });
      row.appendChild(el("div", { style: "font-size:13px" }, item.text));
      row.appendChild(el("div", { class: "dim", "data-readers": item.readers.kind, style: "font-size:12px" }, "{{ui.org-knowledge.will-be-read-by}} " + readersText(item.readers)));
      row.appendChild(el("div", { class: "dim", style: "font-size:12px" }, "{{ui.org-knowledge.owner}} " + (item.ownerName || item.owner || "") + (item.proposedBy ? " · {{ui.org-knowledge.proposed-by}} " + item.proposedBy : "") + " · " + (item.at || "").slice(0, 10)));
      row.appendChild(el("div", { class: "dim mono", style: "font-size:11px" }, "{{ui.org-knowledge.rests-on}} " + (item.evidence || []).join(", ")));
      if (item.replaces) row.appendChild(el("div", { class: "dim", "data-replaces": item.replaces.id, style: "font-size:12px" }, "{{ui.org-knowledge.replaces}} " + item.replaces.id + (item.replaces.text ? ": " + item.replaces.text : "")));
      var actions = el("div", { class: "ui-row" });
      var pinLabel = el("label", { style: "font-size:12px;display:flex;gap:4px;align-items:center" });
      var pin = el("input", { type: "checkbox", "data-pin": "1", style: "height:auto" });
      pinLabel.appendChild(pin); pinLabel.appendChild(document.createTextNode("{{ui.org-knowledge.pin}}"));
      actions.appendChild(pinLabel);
      [["approved", "{{ui.team-memory-review.approve}}"], ["rejected", "{{ui.team-memory-review.reject}}"]].forEach(function (pair) {
        var b = el("button", { class: "btn sm", "data-decision": pair[0] }, pair[1]);
        b.onclick = function () {
          b.disabled = true;
          call("POST", "/api/org-knowledge/review/decide", { version: item.version, decision: pair[0], pinned: pin.checked })
            .then(function (d) { note.textContent = pair[0] === "approved" ? "{{ui.org-knowledge.approved}}" : "{{ui.org-knowledge.rejected}}"; render(d); })
            .catch(function (e) { note.textContent = e.message; if (e.data && e.data.pending) render(e.data); });
        };
        actions.appendChild(b);
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }
  function refresh() {
    if (!list) return;
    fetch("/api/org-knowledge/review").then(function (r) {
      document.getElementById("orgknowledge").style.display = r.ok ? "" : "none";
      return r.ok ? r.json().then(render) : null;
    }).catch(function () {});
  }
  function mount() {
    var memory = document.getElementById("setmemlines");
    if (!memory) return false;
    if (document.getElementById("orgknowledge")) return true;
    var anchor = memory.closest(".field");
    var field = el("div", { class: "field settab-off", "data-tier": "installation", "data-settab": "memory", id: "orgknowledge" });
    field.appendChild(el("label", {}, "{{ui.org-knowledge.title}}"));
    field.appendChild(el("div", { class: "fieldnote", style: "margin:0" }, "{{ui.org-knowledge.always-reviewed}}"));
    list = el("div", { id: "orgknowledgelist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "orgknowledgenote" }, "");
    field.appendChild(list); field.appendChild(note);
    anchor.parentNode.insertBefore(field, anchor.nextSibling);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "memory") refresh(); });
    // A live memory line gets "Promote" beside Edit and Withdraw.
    new MutationObserver(function () {
      if (!admin()) return;
      memory.querySelectorAll("[data-memkey]").forEach(function (row) {
        if (row.querySelector("[data-org-promote]") || !row.querySelector("[data-memedit]")) return;
        var link = el("a", { href: "#", class: "dim", "data-org-promote": "memory", style: "font-size:11px" }, "{{ui.org-knowledge.promote}}");
        link.onclick = function (event) {
          event.preventDefault();
          promote(link, row.querySelector(".memtext").firstChild.textContent, { agent: window.memAgent, tier: row.getAttribute("data-memscope") === "shared" ? "shared" : "own", version: row.getAttribute("data-memver") });
        };
        row.appendChild(link);
      });
    }).observe(memory, { childList: true });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);

  // The task card: a finished task's outcome, and each receipt written about it.
  var receipts = {};
  function e(text) { return typeof esc === "function" ? esc(text) : String(text == null ? "" : text); }
  function receiptRows(id) {
    return (receipts[id] || []).map(function (r) {
      return '<div style="display:flex;gap:8px;font-size:12px"><span class="dim mono" style="white-space:nowrap">' + e((r.at || "").slice(0, 10)) + '</span><span style="flex:1">' + e(r.by + ": " + r.decision + (r.because ? " — " + r.because : "")) + '</span><a href="#" class="dim" style="font-size:11px" data-org-promote="receipt" data-receipt="' + e(r.id) + '" data-task="' + e(id) + '" data-initial="' + e(r.decision) + '">{{ui.org-knowledge.promote}}</a></div>';
    }).join("");
  }
  function paint(id) {
    document.querySelectorAll('[data-org-receipts="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').forEach(function (n) { n.innerHTML = receiptRows(id); });
  }
  window.orgPromoteHtml = function (task) {
    if (!task || !task.id || !admin()) return "";
    if (receipts[task.id] === undefined) {
      receipts[task.id] = [];
      fetch("/api/org-knowledge/receipts?task=" + encodeURIComponent(task.id)).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) { receipts[task.id] = d.receipts || []; paint(task.id); } }).catch(function () {});
    }
    var outcome = task.status === "done" ? '<a href="#" class="btn sm ghost" data-org-promote="task" data-task="' + e(task.id) + '" data-initial="' + e(task.title) + '">{{ui.org-knowledge.promote-outcome}}</a>' : "";
    return '<div data-org-task="' + e(task.id) + '" style="margin:0 0 8px">' + outcome + '<div data-org-receipts="' + e(task.id) + '">' + receiptRows(task.id) + "</div></div>";
  };
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest('[data-org-promote="task"],[data-org-promote="receipt"]') : null;
    if (!link) return;
    event.preventDefault();
    var body = link.getAttribute("data-org-promote") === "task" ? { task: link.getAttribute("data-task") } : { receipt: link.getAttribute("data-receipt"), task: link.getAttribute("data-task") };
    promote(link, link.getAttribute("data-initial") || "", body);
  });
})();
`;
