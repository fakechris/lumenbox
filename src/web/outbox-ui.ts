/**
 * The Outbox on the Tasks panel (INV-1739): the panel above the board, where what has no task row
 * waits, shows each draft an agent wants to send as its own row — the target and the first words,
 * the full draft, the agent's case and the background one click away — with Approve, Edit and
 * Reject. The row is drawn by the page's `attentionRow`; this wraps it for `kind: "outbox"` once
 * the page's own script has defined it.
 */

export const OUTBOX_JS = `(function () {
  var open = {};
  function h(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function call(body) {
    return fetch("/api/outbox/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  function refresh() { if (typeof refreshTasks === "function") refreshTasks(); else if (typeof renderAttention === "function") renderAttention(); }
  function row(item) {
    var d = item.draft || {}, id = h(d.id || item.ref), shown = !!open[d.id];
    return '<div class="ui-gap" data-outbox="' + id + '" style="padding:4px 0;font-size:12.5px">' +
      '<div>' + (d.level ? '<span class="chip" style="font-size:10px">L' + h(d.level) + "</span> " : "") + h(item.title) + "</div>" +
      '<div class="dim" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + h(item.detail) + "</div>" +
      '<div style="display:flex;gap:6px;align-items:baseline;margin-top:3px">' +
        '<button class="btn sm ghost" data-outbox-toggle="' + id + '">' + (shown ? "{{ui.outbox.hide}}" : "{{ui.outbox.show}}") + "</button>" +
        '<button class="btn sm" data-outbox-approve="' + id + '">{{ui.outbox.approve}}</button>' +
        '<button class="btn sm ghost" data-outbox-edit="' + id + '">{{ui.outbox.edit}}</button>' +
        '<button class="btn sm ghost" data-outbox-reject="' + id + '">{{ui.outbox.reject}}</button>' +
      "</div>" +
      '<div data-outbox-detail="' + id + '" style="' + (shown ? "" : "display:none;") + 'margin:6px 0 4px 0;padding:8px 10px;border:1px solid var(--border);border-radius:6px">' +
        '<div class="dim" style="font-size:11px">' + "{{ui.outbox.to}} " + h(d.target) + " · " + h(d.kind) + (d.taskId ? " · " + h(d.taskId) : "") + "</div>" +
        '<div class="ui-pre" data-outbox-body="' + id + '" style="white-space:pre-wrap;margin:6px 0">' + h(d.body) + "</div>" +
        '<div style="font-size:12px"><span class="dim">' + "{{ui.outbox.agent-case}} " + "</span>" + h(d.why) + "</div>" +
        (d.background ? '<div style="font-size:12px"><span class="dim">' + "{{ui.outbox.background}} " + "</span>" + h(d.background) + "</div>" : "") +
      "</div>" +
    "</div>";
  }
  function install() {
    if (typeof attentionRow !== "function") return false;
    if (attentionRow.outbox) return true;
    var base = attentionRow;
    var wrapped = function (item, owed, onBoard) { return item && item.kind === "outbox" ? row(item) : base(item, owed, onBoard); };
    wrapped.outbox = true;
    window.attentionRow = wrapped;
    return true;
  }
  function editor(id) {
    var body = document.querySelector('[data-outbox-body="' + id + '"]');
    if (!body || body.querySelector("textarea")) return;
    var text = body.textContent;
    body.textContent = "";
    var area = document.createElement("textarea");
    area.value = text; area.rows = Math.min(14, Math.max(5, text.split("\\n").length + 3)); area.style.width = "100%"; area.style.minHeight = "9em"; area.style.resize = "vertical";
    var send = document.createElement("button"); send.className = "btn sm accent"; send.textContent = "{{ui.outbox.send-edited}}";
    var cancel = document.createElement("button"); cancel.className = "btn sm ghost"; cancel.textContent = "{{ui.outbox.cancel}}";
    var actions = document.createElement("div"); actions.className = "ui-actions"; actions.appendChild(cancel); actions.appendChild(send);
    body.appendChild(area); body.appendChild(actions);
    area.focus(); area.scrollIntoView({ block: "nearest" });
    cancel.onclick = function () { body.textContent = text; };
    send.onclick = function () { send.disabled = true; call({ id: id, decision: "edit", body: area.value }).then(refresh).catch(function (e) { send.disabled = false; alert(e.message); }); };
  }
  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var toggle = target.closest("[data-outbox-toggle]"), approve = target.closest("[data-outbox-approve]"), edit = target.closest("[data-outbox-edit]"), reject = target.closest("[data-outbox-reject]");
    if (toggle) {
      var id = toggle.getAttribute("data-outbox-toggle"); open[id] = !open[id];
      var detail = document.querySelector('[data-outbox-detail="' + id + '"]');
      if (detail) detail.style.display = open[id] ? "" : "none";
      toggle.textContent = open[id] ? "{{ui.outbox.hide}}" : "{{ui.outbox.show}}";
    } else if (approve) {
      approve.disabled = true;
      call({ id: approve.getAttribute("data-outbox-approve"), decision: "approve" }).then(refresh).catch(function (e) { approve.disabled = false; alert(e.message); });
    } else if (edit) {
      var editId = edit.getAttribute("data-outbox-edit"); open[editId] = true;
      var box = document.querySelector('[data-outbox-detail="' + editId + '"]');
      if (box) box.style.display = "";
      editor(editId);
    } else if (reject) {
      var rejectId = reject.getAttribute("data-outbox-reject");
      askInline(reject, "{{ui.outbox.reject-why}}", "").then(function (reason) {
        if (reason === null || reason.trim() === "") return;
        call({ id: rejectId, decision: "reject", reason: reason.trim() }).then(refresh).catch(function (e) { alert(e.message); });
      });
    }
  });
  if (!install()) { var tries = 0, wait = setInterval(function () { if (install() || ++tries > 40) clearInterval(wait); }, 100); }
  document.addEventListener("DOMContentLoaded", install);
})();
`;
