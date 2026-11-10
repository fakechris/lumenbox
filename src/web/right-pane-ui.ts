/** Bounded disclosures keep tasks the primary right-pane workspace (INV-1793). */
export const RIGHT_PANE_STYLE = String.raw`
.task-chat-back{display:none}
@media(max-width:900px){body.task-board-visible #sidebar,body.task-board-visible #middle{display:none}body.task-board-visible #rightpane{width:100%;flex:1;border-left:0}body #topbar{overflow-x:auto;overflow-y:hidden}body #topbar>*{flex-shrink:0;white-space:nowrap}body #topbar .mid{min-width:0}body:has(> #taskfocus:not([hidden])) #shell{overflow:hidden}body.task-board-visible .task-chat-back{display:block;grid-column:1/-1;justify-self:start}}
#tasksview{display:none;flex:1;min-height:0;flex-direction:column}.task-compose{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:var(--sp-2);padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border)}.task-compose input{grid-column:1/-1;min-width:0;padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-input);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font:inherit;font-size:var(--fs-md)}.task-compose .field{margin:0;min-width:0}.task-compose select{max-width:100%;font-size:var(--fs-sm)}.task-compose a{font-size:var(--fs-sm);align-self:center}
.pane-disclosure{flex:none;min-width:0;border-bottom:1px solid var(--border)}.pane-disclosure>summary{padding:var(--sp-3) var(--sp-4);cursor:pointer;font-size:var(--fs-sm);color:var(--text-soft)}.pane-disclosure>summary::marker{color:var(--muted)}.pane-disclosure>summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.pane-count{font-variant-numeric:tabular-nums;margin-left:var(--sp-2);color:var(--muted)}.attention-error{padding:var(--sp-3) var(--sp-4);font-size:var(--fs-sm);line-height:1.6}.attention-pager{display:flex;gap:var(--sp-2);align-items:center;justify-content:space-between;padding:var(--sp-2) var(--sp-4);font-size:var(--fs-xs)}.attention-pager[hidden]{display:none}.attention-body{max-height:28vh;overflow:auto;padding:0 var(--sp-4) var(--sp-2);overscroll-behavior:contain}.attention-row{padding:var(--sp-2) 0;font-size:var(--fs-sm);line-height:1.6;min-width:0}.attention-copy{overflow-wrap:anywhere}.attention-copy strong{font-weight:500}.attention-actions:empty{display:none}.attention-actions{margin-top:var(--sp-1)}.attention-actions .mono{font-size:var(--fs-xs)}.attention-label,.attention-owed{color:var(--warn)}.attention-label{font-size:var(--fs-xs)}.attention-waiting{color:var(--muted)}.attention-sidebar{display:flex;gap:var(--sp-2);align-items:baseline;font-size:var(--fs-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:none}
#activity-panel{border-top:1px solid var(--border);border-bottom:0}.feed{max-height:24vh;overflow-y:auto;padding:0 0 var(--sp-2);overscroll-behavior:contain}.activity-unread{color:var(--accent);font-size:var(--fs-xs);margin-left:var(--sp-2)}.activity-error{color:var(--danger)}.activity-retention{font-size:var(--fs-xs);color:var(--muted);padding:0 var(--sp-4) var(--sp-2)}
`;
export const TASKS_PANEL_HTML = String.raw`<div id="tasksview">
  <div class="task-compose">
    <button class="btn sm ghost task-chat-back" data-task-chat>{{ui.tf.backChat}}</button>
    <input id="tasknew" aria-label="{{ui.page.new-task-title}}" placeholder="{{ui.page.new-task-title}}" spellcheck="false">
    <div class="field"><select id="taskassign" aria-label="{{ui.tf.assignee}}"></select></div>
    <button class="btn sm" id="taskadd">{{ui.page.add}}</button>
    <a href="#" id="inboxonly" class="dim" title="{{ui.page.only-what-the-agents-found}}">{{ui.page.inbox}}</a>
  </div>
  <details id="attention" class="pane-disclosure" style="display:none">
    <summary>{{ui.tf.needsAction}}<span class="pane-count" id="attention-count"></span></summary>
    <div id="attention-error" class="attention-error" role="status" hidden>{{ui.tf.attentionUnavailable}} <button class="btn sm ghost" data-att-refresh>{{ui.tf.refresh}}</button></div>
    <div id="attention-body" class="attention-body"></div>
    <div id="attention-pager" class="attention-pager" hidden><button class="btn sm ghost" data-att-prev>{{ui.tf.previous}}</button><span id="attention-range"></span><button class="btn sm ghost" data-att-next>{{ui.tf.next}}</button></div>
  </details>
  <div class="scroll" id="tasklist" title="{{ui.page.the-board-what-waits-on}}"></div>
</div>`;
export const ACTIVITY_PANEL_HTML = String.raw`<details id="activity-panel" class="pane-disclosure">
  <summary>{{ui.page.activity-all-agents}}<span id="activity-count" class="pane-count"></span><span id="activity-unread" class="activity-unread" role="status" aria-live="polite"></span></summary>
  <div class="activity-retention" id="activity-retention" hidden>{{ui.tf.activityRetention}}</div>
  <div class="feed" id="feed"></div>
</details>`;
export const ACTIVITY_FEED_JS = String.raw`var activityCount = 0, activityUnread = 0, activityErrors = 0;
function activitySummary() {
  $("activity-count").textContent = String(activityCount);
  var badge = $("activity-unread");
  badge.textContent = activityErrors ? activityErrors + " {{ui.tf.newErrors}}" : activityUnread ? activityUnread + " {{ui.tf.newEvents}}" : "";
  badge.classList.toggle("activity-error",activityErrors > 0);
}
$("activity-panel").addEventListener("toggle",function () {
  if (this.open) { $("feed").scrollTop = $("feed").scrollHeight; activityUnread = 0; activityErrors = 0; activitySummary(); }
});
$("feed").addEventListener("scroll",function () {
  if ($("activity-panel").open && nearBottom(this)) { activityUnread = 0; activityErrors = 0; activitySummary(); }
});
function feed(html, cls, at) {
  var el = $("feed"), panel = $("activity-panel"), stick = nearBottom(el);
  if (!el.children.length && activityCount) { activityCount = 0; activityUnread = 0; activityErrors = 0; $("activity-retention").hidden = true; }
  var when = at ? new Date(at) : new Date();
  var stamp = isNaN(when.getTime()) ? "" : '<span class="t">' + ("0" + when.getHours()).slice(-2) + ":" + ("0" + when.getMinutes()).slice(-2) + "</span> ";
  var row = document.createElement("div"); row.className = "ev " + (cls || ""); row.innerHTML = stamp + html; el.appendChild(row);
  activityCount++;
  // Replayed history is not a new error. Live errors remain visible on the collapsed summary.
  if ((!panel.open || !stick) && !at) { activityUnread++; if (cls === "err") activityErrors++; }
  if (el.children.length > 200) { el.firstElementChild.remove(); $("activity-retention").hidden = false; }
  activitySummary(); if (stick && panel.open) el.scrollTop = el.scrollHeight;
}
`;
export const ATTENTION_PANEL_JS = String.raw`// One attention item as a line: in the panel above the board, or (onBoard) as the mark on its task's own row (INV-1654).
function attentionRow(item, owed, onBoard) {
  var act =
    item.kind === "box-update" ? '<button class="btn sm ghost" data-att-box-settings>{{ui.tf.boxSettings}}</button>' :
    item.kind === "approval" ? '<button class="btn sm" data-att-approve="' + esc(item.ref) + '">' + esc(t("consent.once")) + '</button><button class="btn sm ghost" data-att-deny="' + esc(item.ref) + '">' + esc(t("consent.deny")) + "</button>" :
    item.kind === "close-proposal" ? '<button class="btn sm ghost" data-att-keep="' + esc(item.ref) + '">' + esc(t("ui.attention.keepOpen")) + "</button>" :
    item.kind === "nudged" ? '<button class="btn sm ghost" data-att-drop="' + esc(item.ref) + '">' + esc(t("ui.attention.close")) + '</button><button class="btn sm ghost" data-att-snooze="' + esc(item.ref) + '">' + esc(t("ui.attention.notNow")) + "</button>" :
    item.kind === "question" && !/^t\d+$/.test(item.ref) ? '<button class="btn sm ghost" data-att-open="' + esc(item.ref) + '">' + esc(t("ui.attention.answer")) + "</button>" :
    item.kind === "paused" ? '<button class="btn sm ghost" data-att-open="' + esc(item.ref) + '">' + esc(t("ui.attention.open")) + "</button>" : item.kind === "routine-paused" ? '<button class="btn sm" data-routine-resume="' + esc(item.ref) + '">{{ui.app.resume}}</button>' : item.kind === "exception" ? '<button class="btn sm" data-exc-retry="' + esc(item.ref) + '">{{ui.exceptions.retry}}</button><button class="btn sm ghost" data-exc-dismiss="' + esc(item.ref) + '">{{ui.exceptions.dismiss}}</button>' : // routine-runs-ui.ts (INV-1665), exceptions-ui.ts (INV-1741)
    onBoard ? "" : '<button class="btn sm ghost" data-att-task="' + esc(item.ref) + '">' + esc(t("ui.attention.open")) + "</button>";
  return '<div class="attention-row' + (onBoard ? (owed ? ' attention-owed' : ' attention-waiting') : '') + '" title="' + esc(item.title + " — " + item.detail) + '">' +
    '<div class="attention-copy">' + (onBoard ? '<span class="attention-label">' + (owed ? "{{ui.app.needs-you}} " : "{{ui.tf.waitingFor}} ") + '</span>' : '<strong>' + esc(item.title) + '</strong> ') + '<span class="dim">' + esc(item.detail) + (item.stage && !onBoard ? " · " + esc(item.stage) : "") + '</span></div>' +
    '<div class="ui-row attention-actions">' + (item.deadline ? '<span class="dim mono">' + esc(whenOf(item.deadline)) + '</span>' : '') + (!onBoard && item.level ? '<span class="chip">L' + esc(item.level) + '</span>' : '') + (owed ? act : '') + '</div></div>';
}
var attentionNodes = new Map(), attentionItems = [], attentionOffset = 0;
function paintAttention() {
  var total = attentionItems.length;
  attentionOffset = Math.min(attentionOffset,Math.max(0,Math.ceil(total / 25) - 1) * 25);
  $("attention-count").textContent = String(total); $("attention").style.display = total ? "" : "none";
  $("attention-error").hidden = true; $("attention-pager").hidden = total <= 25;
  $("attention-range").textContent = (total ? attentionOffset + 1 : 0) + "–" + Math.min(total,attentionOffset + 25) + " / " + total;
  document.querySelector("[data-att-prev]").disabled = !attentionOffset;
  document.querySelector("[data-att-next]").disabled = attentionOffset + 25 >= total;
  var body = $("attention-body"), retained = new Set(), position = body.firstElementChild;
  attentionItems.slice(attentionOffset,attentionOffset + 25).forEach(function (item) {
    var key = item.kind + ":" + item.ref, node = attentionNodes.get(key), html = attentionRow(item,true); retained.add(key);
    if (!node) { node = document.createElement("div"); attentionNodes.set(key,node); }
    if (node.__html !== html && !node.contains(document.activeElement)) { node.innerHTML = html; node.__html = html; }
    if (node !== position) body.insertBefore(node,position); position = node.nextElementSibling;
  });
  attentionNodes.forEach(function (node,key) { if (!retained.has(key)) { node.remove(); attentionNodes.delete(key); } });
}
document.addEventListener("click",function (event) {
  if (event.target.closest("[data-task-chat]")) { event.preventDefault(); showTab("desktop"); }
  if (event.target.closest("[data-att-refresh]")) { event.preventDefault(); renderAttention(); }
  var previous = event.target.closest("[data-att-prev]"), next = event.target.closest("[data-att-next]");
  if (previous || next) { event.preventDefault(); attentionOffset = Math.max(0,attentionOffset + (next ? 25 : -25)); paintAttention(); $("attention-body").scrollTop = 0; }
});
function renderAttention() {
  return fetch("/api/attention")
    .then(function (r) { if (!r.ok) throw new Error("attention unavailable"); return r.json(); })
    .then(function (data) {
      var mine = data.mine || [];
      window.lastAttention = data; // the board merges these onto its rows (INV-1654)
      // The first screen (INV-1464) is the agents'. Above them there is at most one line (2026-11-06 rule): how many decisions wait,
      // how many reviews, and a way to open them on the board. Never rows here — twice a list in this column hid every agent.
      var needs = mine.filter(function (i) { return i.decision === true; }), reviews = mine.filter(function (i) { return !!i.stage && i.stage.indexOf("person/") === 0; }).length;
      $("needsme").style.display = needs.length || reviews ? "" : "none";
      $("needsme").innerHTML = '<a href="#" data-att-board="1" class="attention-sidebar"><span class="attention-label">' + esc(t("ui.attention.needsMe")) + "</span>" +
        (needs.length ? "<span>" + needs.length + " {{ui.app.decision}}" + (needs.length === 1 ? "" : "{{ui.plural.s}}") + "</span>" : "") + (reviews ? '<span class="dim">' + reviews + " {{ui.app.review}}" + (reviews === 1 ? "" : "{{ui.plural.s}}") + "</span>" : "") + '<span class="dim">' + esc(t("ui.attention.open")) + " ›</span></a>";
      // Only what has no task row (INV-1654): a consent, a question, a pause. Tasks carry their own mark on the board below.
      attentionItems = typeof looseItems === "function" ? looseItems(mine) : [];
      paintAttention();
    })
    .catch(function () {
      attentionItems = []; attentionNodes.forEach(function (node) { node.remove(); }); attentionNodes.clear(); window.lastAttention = {};
      $("needsme").style.display = "none"; $("attention").style.display = ""; $("attention-count").textContent = "?";
      $("attention-error").hidden = false; $("attention-pager").hidden = true;
    });
}

`;
