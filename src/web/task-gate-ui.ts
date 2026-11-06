/**
 * The task card's gate line (INV-1672): "Gate · 4 allowed · 1 asked you · 0 waiting for you ·
 * 1 refused", and, opened, every tool step of the task's turns with the mark the chat gives it
 * (`window.gateMark`, tool-permissions-ui.ts) and the gate's reason in words. Rendered by its own
 * function so the task card only has to call it:
 *
 * - `taskGateHtml(task)` — the section, filled from `/api/tasks/gate` (task-gate-routes.ts)
 *
 * The steps are read from the transcript only when a card is open, not on every board poll: the
 * line shows what was last fetched and asks again when it is older than a few seconds.
 */
export const TASK_GATE_JS = `(function () {
  var WORD = { allowed: "allowed", asked: "asked you", waiting: "waiting for you", refused: "refused" };
  var FRESH_MS = 10000;
  var cache = {}, open = {};
  function e(text) { return typeof esc === "function" ? esc(text) : String(text == null ? "" : text); }
  function body(id, data) {
    var total = data.steps.length + data.earlier;
    if (!total) return "";
    var c = data.counts;
    var line = ["allowed", "asked", "waiting", "refused"].map(function (k) { return '<span data-gate-count="' + k + '">' + (c[k] || 0) + " " + WORD[k] + "</span>"; }).join(" · ") +
      (data.unchecked ? ' · <span class="dim" data-gate-count="unchecked" title="The gate did not check these steps, or checked them longer ago than the verdicts it keeps.">' + data.unchecked + " not checked</span>" : "");
    var head = '<div data-task-gate-toggle="' + e(id) + '" style="font-size:12px;cursor:pointer"><span style="font-weight:600">' + (open[id] ? "▾" : "▸") + " Gate</span> " +
      '<span class="dim">' + total + " step" + (total === 1 ? "" : "s") + "</span> · " + line + "</div>";
    if (!open[id]) return head;
    var rows = data.steps.map(function (s, index) {
      return '<div data-gate-step style="padding:3px 0;font-size:12px' + (index > 0 ? ";border-top:1px solid var(--border)" : "") + '">' +
        '<div style="display:flex;gap:8px;align-items:baseline">' +
          '<span class="dim mono" style="font-size:11px;white-space:nowrap">' + (s.at ? e(new Date(s.at).toLocaleTimeString()) : "") + "</span>" +
          '<span class="mono" style="font-weight:600;white-space:nowrap">' + e(s.name) + "</span>" +
          '<span class="dim" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + e(s.detail) + '">' + e(s.detail) + "</span>" +
          (s.gate && window.gateMark ? window.gateMark(s.gate) : "") +
        "</div>" +
        (s.gate && s.gate.basis ? '<div class="dim" style="font-size:11px;padding-left:12px">' + e(s.gate.basis) + "</div>" : "") +
      "</div>";
    }).join("");
    var earlier = data.earlier ? '<div class="dim" style="font-size:11px">' + data.earlier + " earlier steps are counted above and not listed.</div>" : "";
    return head + '<div style="max-height:260px;overflow:auto;margin-top:4px">' + earlier + rows + "</div>";
  }
  function paint(id) {
    var entry = cache[id];
    var html = entry && entry.data ? body(id, entry.data) : "";
    document.querySelectorAll('[data-task-gate="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]').forEach(function (el) { el.innerHTML = html; el.style.display = html ? "" : "none"; });
  }
  function load(id) {
    var entry = cache[id] = cache[id] || {};
    if (entry.loading || (entry.at && Date.now() - entry.at < FRESH_MS)) return;
    entry.loading = true;
    fetch("/api/tasks/gate?task=" + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { entry.loading = false; entry.at = Date.now(); if (data && data.steps) entry.data = data; paint(id); })
      .catch(function () { entry.loading = false; entry.at = Date.now(); });
  }

  window.taskGateHtml = function (task) {
    if (!task || !task.id || !task.assigneeId) return "";
    setTimeout(function () { load(task.id); }, 0);
    var entry = cache[task.id];
    var html = entry && entry.data ? body(task.id, entry.data) : "";
    return '<div data-task-gate="' + e(task.id) + '" style="margin:0 0 8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md)' + (html ? "" : ";display:none") + '">' + html + "</div>";
  };

  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest("[data-task-gate-toggle]") : null;
    if (!toggle) return;
    event.preventDefault();
    var id = toggle.getAttribute("data-task-gate-toggle");
    open[id] = !open[id];
    paint(id);
  });
})();
`;
