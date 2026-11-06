/**
 * The division of work, seen (INV-1667): the forks an agent split a job into, folded under the
 * conversation that started them in the thread picker, and listed on the task card with the chain
 * of each delegation — sent, started, (fenced,) reported, merged. Rendered by its own functions so
 * the picker and the task card each only have to call one:
 *
 * - `forkRowsHtml(conversation, viewed)` — the folded line under a thread, and its children when open
 * - `forkLabel(id, loaded)` — the picker button's label while a fork's thread is in view
 * - `divisionHtml(task)` — the task card's "Division of work" section
 *
 * The data is the host's fork history (fork-events.ts), served on `/api/conversations` (`forks` per
 * thread) and `/api/tasks` (`forks` per task). A fork's thread opens read-only: nobody but the turn
 * that forked it talks to a fork.
 */
export const DIVISION_JS = `(function () {
  var WORD = { running: "running", done: "done", stuck: "stuck", fenced: "fenced", dropped: "dropped" };
  var MEANS = { running: "still working", done: "handed off done", stuck: "handed off partial, blocked or without a verdict", fenced: "stopped by the fence: it tried something a fork may not do", dropped: "dropped by a restart before its findings reached the parent" };
  var COLOR = { running: "var(--accent)", done: "var(--success)", stuck: "var(--warn)", fenced: "var(--danger)", dropped: "var(--muted)" };
  var STEP = { "fork.spawned": "sent", "fork.started": "started", "fork.fenced": "fenced", "fork.reported": "reported", "fork.merged": "merged", "fork.dropped": "dropped" };
  var open = {};
  function e(text) { return typeof esc === "function" ? esc(text) : String(text == null ? "" : text); }
  function ago(iso) { return typeof fmtAgo === "function" ? fmtAgo(iso) : ""; }
  function chip(status) {
    return '<span data-fork-status="' + e(status) + '" title="' + e(MEANS[status] || "") + '" style="font-size:10px;font-weight:600;color:' + (COLOR[status] || "var(--muted)") + ';white-space:nowrap">' + e(WORD[status] || status) + "</span>";
  }
  function tally(forks) {
    var counts = {};
    forks.forEach(function (f) { counts[f.status] = (counts[f.status] || 0) + 1; });
    return ["done", "running", "stuck", "fenced", "dropped"].filter(function (s) { return counts[s]; })
      .map(function (s) { return counts[s] + " " + (WORD[s] || s); }).join(" · ");
  }

  window.forkRowsHtml = function (c, viewed) {
    var forks = (c && c.forks) || [];
    if (!forks.length) return "";
    var shown = open[c.id] !== undefined ? open[c.id] : forks.some(function (f) { return f.id === viewed; });
    var head = '<div class="row dim" data-forktoggle="' + e(c.id) + '" style="padding-left:20px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
      (shown ? "▾ " : "▸ ") + forks.length + " fork" + (forks.length === 1 ? "" : "s") + " · " + e(tally(forks)) + "</div>";
    if (!shown) return head;
    return head + forks.map(function (f) {
      return '<a href="#" class="row' + (f.id === viewed ? " on" : "") + '" data-conv="' + e(f.id) + '" data-fork-child style="padding-left:28px">' +
        '<span class="when">' + e(ago(f.lastAt)) + "</span>" + chip(f.status) + " " +
        '<span class="what" title="' + e(f.reason || f.brief) + '">' + e(f.brief || f.id) + "</span></a>";
    }).join("");
  };

  window.forkLabel = function (id, loaded) {
    for (var i = 0; i < (loaded || []).length; i++) {
      var forks = loaded[i].forks || [];
      for (var j = 0; j < forks.length; j++) if (forks[j].id === id) return "fork · " + String(forks[j].brief || id).slice(0, 40) + " (" + (WORD[forks[j].status] || forks[j].status) + ")";
    }
    return "fork · " + id.slice(5, 45);
  };

  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest("[data-forktoggle]") : null;
    if (!toggle) return;
    event.preventDefault();
    var id = toggle.getAttribute("data-forktoggle");
    open[id] = toggle.textContent.indexOf("▸") === 0;
    // After this click has finished travelling: re-rendered now, the row it started on is gone, and the page's "clicked outside" check closes the panel.
    if (typeof renderConvList === "function") setTimeout(renderConvList, 0);
  });

  window.divisionHtml = function (task) {
    var forks = (task && task.forks) || [];
    if (!forks.length) return "";
    var rows = forks.map(function (f, index) {
      var chain = (f.steps || []).map(function (s) {
        var word = STEP[s.event] || s.event;
        var extra = s.event === "fork.fenced" ? s.detail : s.event === "fork.reported" ? s.status : s.event === "fork.dropped" ? s.status : "";
        return '<span data-fork-step="' + e(s.event) + '" title="' + e(new Date(s.at).toLocaleString()) + '">' + e(word) + (extra ? " (" + e(extra) + ")" : "") +
          ' <span class="dim">' + e(new Date(s.at).toLocaleTimeString()) + "</span></span>";
      }).join(" → ");
      var link = task.assigneeId
        ? '<a href="#" data-openconv="' + e(f.child) + '" data-agent="' + e(task.assigneeId) + '">open</a>'
        : "";
      return '<div data-fork="' + e(f.child) + '" style="padding:4px 0;font-size:12px' + (index > 0 ? ";border-top:1px solid var(--border)" : "") + '">' +
        '<div style="display:flex;gap:8px;align-items:baseline">' + chip(f.status) +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + e(f.brief) + '">' + e(f.brief) + "</span>" +
          '<span class="dim" style="font-size:11px;white-space:nowrap">' + e(ago(f.lastAt)) + "</span>" + link +
        "</div>" +
        (f.reason ? '<div class="dim" style="font-size:11px">' + e(f.reason) + "</div>" : "") +
        '<div class="dim" style="font-size:11px">' + chain + "</div>" +
      "</div>";
    }).join("");
    return '<div data-division style="margin:0 0 8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md)">' +
      '<div style="font-size:12px;font-weight:600;margin-bottom:2px">Division of work <span class="dim" style="font-weight:400">' + forks.length + " fork" + (forks.length === 1 ? "" : "s") + " · " + e(tally(forks)) + "</span></div>" + rows + "</div>";
  };
})();
`;
