/**
 * What a task waits on, on its card (INV-1740). Two functions the board calls:
 *
 * - `taskDepsChip(task)` — on the row: "waiting on 2 of 3 · after t12, t15" while a blocker is
 *   open, "after t12, t15" once they are all finished, and "blocks t9" for the live tasks waiting
 *   on this one. Read from `blockers` / `blocks`, which `/api/tasks` adds (task-deps.ts).
 * - `taskDepsHtml(task)` — in the opened card: the ids it waits on, editable. Saving sends the
 *   whole set to `/api/tasks/update`; the board refuses an unknown id, the task itself and a
 *   cycle, and the refusal is shown as it came.
 */
export const TASK_DEPS_JS = `(function () {
  function e(text) { return typeof esc === "function" ? esc(text) : String(text == null ? "" : text); }
  function live(status) { return status !== "done" && status !== "dropped"; }
  var CHIP = "font-size:10px";

  window.taskDepsChip = function (task) {
    if (!task || !live(task.status)) return "";
    var blockers = task.blockers || [], open = blockers.filter(function (b) { return live(b.status); });
    var ids = blockers.map(function (b) { return b.id; }).join(", ");
    var html = "";
    if (open.length) html += ' <span class="chip" data-task-deps="waiting" style="' + CHIP + ';color:var(--warn)" title="{{ui.task-deps.not-ready-until-these-finish}} ' + e(open.map(function (b) { return b.id; }).join(", ")) + '">{{ui.task-deps.waiting-on}} ' + open.length + " {{ui.task-deps.of}} " + blockers.length + " · {{ui.task-deps.after}} " + e(ids) + "</span>";
    else if (blockers.length) html += ' <span class="chip" data-task-deps="after" style="' + CHIP + ';color:var(--muted)">{{ui.task-deps.after}} ' + e(ids) + "</span>";
    if (task.blocks && task.blocks.length) html += ' <span class="chip" data-task-deps="blocks" style="' + CHIP + ';color:var(--muted)" title="{{ui.task-deps.these-wait-for-this-one}}">{{ui.task-deps.blocks}} ' + e(task.blocks.join(", ")) + "</span>";
    return html;
  };

  window.taskDepsHtml = function (task) {
    if (!task || !task.id) return "";
    var ids = (task.blockedBy || []).join(", ");
    return '<div style="display:flex;gap:6px;align-items:center;margin:0 0 8px;font-size:12px">' +
      '<span class="dim">{{ui.task-deps.blocked-by}}</span>' +
      '<input data-deps-input="' + e(task.id) + '" value="' + e(ids) + '" placeholder="t12, t15" title="{{ui.task-deps.task-ids-separated-by-commas}}" style="flex:1;max-width:220px;height:24px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:12px;padding:0 6px">' +
      '<button class="btn sm ghost" data-deps-save="' + e(task.id) + '">{{ui.task-deps.save}}</button>' +
    "</div>";
  };

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-deps-save]") : null;
    if (!button) return;
    event.preventDefault();
    var id = button.getAttribute("data-deps-save");
    var input = document.querySelector('[data-deps-input="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    fetch("/api/tasks/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id, blockedBy: input ? input.value : "" }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.error) alert(d.error); if (typeof refreshTasks === "function") refreshTasks(); })
      .catch(function () {});
  });
})();
`;
