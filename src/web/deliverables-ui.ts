/**
 * The task card's "Deliverables" section (INV-1663): every file the agent marked as what the task
 * produced, newest first — name, size, what it is, when, and a download of the copy the host kept.
 * Rendered by its own function so the task card only has to call it.
 */
export const DELIVERABLES_JS = `(function () {
  function size(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }
  window.deliverablesHtml = function (task) {
    var items = (task && task.deliverables) || [];
    if (!items.length) return "";
    var rows = items.slice().reverse().map(function (d, index) {
      var href = "/api/tasks/deliverable?task=" + encodeURIComponent(task.id) + "&id=" + encodeURIComponent(d.id);
      return '<div data-deliverable="' + esc(d.id) + '" style="padding:4px 0;font-size:12px' + (index > 0 ? ";border-top:1px solid var(--border)" : "") + '">' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<span class="mono" style="font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(d.path || d.name) + '">' + esc(d.name) + "</span>" +
          '<span class="dim" style="white-space:nowrap;font-size:11px">' + esc(size(d.size)) + "</span>" +
          '<a class="btn sm ghost" href="' + esc(href) + '" download="' + esc(d.name) + '">Download</a>' +
        "</div>" +
        '<div class="dim" style="font-size:11px">' + (d.note ? esc(d.note) + " · " : "") + esc(new Date(d.at).toLocaleString()) + "</div>" +
      "</div>";
    }).join("");
    return '<div data-deliverables style="margin:0 0 8px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-md)">' +
      '<div style="font-size:12px;font-weight:600;margin-bottom:2px">Deliverables</div>' + rows + "</div>";
  };
})();
`;
