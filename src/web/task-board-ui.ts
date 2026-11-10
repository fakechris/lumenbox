/** Keyed, paged board rows; a refresh never replaces the entire list (INV-1786). */
export const TASK_BOARD_STYLE = String.raw`
.task-row{padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border)}.task-row.is-open{background:var(--surface)}.task-row-head{align-items:baseline}.task-row-head .chip{font-size:var(--fs-xs)}.task-id{font-size:var(--fs-xs);color:var(--muted);text-decoration:none}.task-title{flex:1;min-width:0;font-size:var(--fs-md);font-weight:500;color:var(--text);text-decoration:none;overflow-wrap:anywhere}.task-meta,.task-attention{padding-left:var(--sp-5);font-size:var(--fs-xs)}.task-warn{color:var(--warn)}.task-danger{color:var(--danger)}.task-muted{color:var(--muted)}.task-select-field{margin:0}.task-select-field select{font-size:var(--fs-xs);height:var(--sp-5);padding:0 var(--sp-3);background-position:right var(--sp-1) center}.task-status-doing{color:var(--accent)}.task-status-blocked{color:var(--warn)}.task-status-review{color:var(--accent-2)}.task-status-done{color:var(--success)}
`;
export const TASK_BOARD_JS = String.raw`function taskBoardMarkup(t, mark) {
  var assignee = t.assigneeId ? nameOf(t.assigneeId) : "{{ui.app.unassigned}}";
  var reviewer = t.reviewerId ? " {{ui.app.review-by}} " + esc(nameOf(t.reviewerId)) : "";
  var last = t.history && t.history.length ? t.history[t.history.length - 1] : null;
  var lastNote = last && last.note ? esc(last.note) : "";
  var proposed = t.proposedBy ? ' <span class="chip ui-badge">{{ui.app.proposed}}</span> <button class="btn sm accent" data-commit="' + esc(t.id) + '" title="{{ui.app.make-this-proposal-real-work}}">{{ui.app.commit}}</button>' + (t.status !== "dropped" ? ' <button class="btn sm ghost" data-dismiss="' + esc(t.id) + '" title="{{ui.app.not-worth-doing-closes-it}}">{{ui.app.dismiss}}</button>' : '') + (t.discovery ? ' <span class="chip ui-badge" title="' + esc(t.discovery.evidence) + '">' + esc(t.discovery.kind) + ' {{ui.app.from-3}} ' + esc(t.discovery.source) + (t.discovery.whyNow ? ' — ' + esc(t.discovery.whyNow) : '') + '</span>' : '') : '';
  var progress = t.progress && window.taskProgressHtml ? '<div class="dim task-meta">' + esc(progressLines(t.progress,MSG_LOCALE)[0]) + '</div>' : "";
  var live = t.status !== "done" && t.status !== "dropped";
  var overdue = live && t.due && Date.parse(t.due) < Date.now();
  var dueChip = t.due ? ' <span class="chip ui-badge' + (overdue ? ' task-danger' : '') + '" title="{{ui.app.due}}">' + (overdue ? '{{ui.app.overdue}} ' : '{{ui.app.due}} ') + esc(String(t.due).slice(0,10)) + '</span>' : '';
  var agingChip = live && t.aging ? ' <span class="chip ui-badge task-warn" title="{{ui.app.nudged}} ' + t.aging.nudges + '/2">{{ui.app.nudged}} ' + t.aging.nudges + '/2</span>' : '';
  var closeChip = live && t.closeProposal ? ' <span class="chip ui-badge task-warn" title="' + esc(t.closeProposal.reason) + '">{{ui.app.close-proposed-by}} ' + esc(nameOf(t.closeProposal.by)) + '{{ui.app.closes}} ' + esc(String(t.closeProposal.decideBy).slice(0,16).replace('T',' ')) + '</span> <button class="btn ghost sm" data-oppose="' + esc(t.id) + '">{{ui.app.keep-open}}</button>' : '';
  var waitingChip = live && t.waitingOn ? ' <span class="chip ui-badge" title="{{ui.app.waiting-on-somebody-outside-this}}">{{ui.app.waiting-on}} ' + esc(String(t.waitingOn).slice(0,40)) + '</span>' : '';
  var snoozeChip = live && t.snoozeUntil && Date.parse(t.snoozeUntil) > Date.now() ? ' <span class="chip ui-badge task-muted" title="{{ui.app.quiet-until-then}}">{{ui.app.not-until}} ' + esc(String(t.snoozeUntil).slice(0,10)) + '</span>' : '';
  proposed += dueChip + waitingChip + snoozeChip + agingChip + closeChip + (window.taskDepsChip ? window.taskDepsChip(t) : '') + (live && window.exceptionRetryHtml ? window.exceptionRetryHtml(t) : '');
  var level = t.level ? '<div class="field task-select-field ui-w-xs"><select data-level="' + esc(t.id) + '" title="{{ui.tf.autonomy}}">' + [1,2,3,4,5].map(function (n) { return '<option value="' + n + '"' + (n === t.level ? ' selected' : '') + '>L' + n + '</option>'; }).join('') + '</select></div>' : '';
  var status = '<div class="field task-select-field ui-w-sm"><select data-task="' + esc(t.id) + '" class="task-status-' + esc(t.status) + '">' + TASK_STATUSES.map(function (value) { return '<option value="' + value + '"' + (value === t.status ? ' selected' : '') + '>' + value + '</option>'; }).join('') + '</select></div>';
  return '<div class="task-row' + (t.id === openTask ? ' is-open' : '') + '"><div class="ui-row task-row-head"><a href="#" data-open="' + esc(t.id) + '" class="mono task-id">' + esc(t.id) + '</a><a href="#" data-open="' + esc(t.id) + '" class="task-title">' + esc(t.title) + '</a>' + proposed + level + status + '</div><div class="dim task-meta">' + esc(assignee) + reviewer + (lastNote ? ' — <em>' + lastNote + '</em>' : '') + '</div>' + progress + (mark ? '<div class="task-attention">' + mark + '</div>' : '') + '</div>';
}
var taskBoardState = { ids: [], nodes: new Map(), cursor: null, next: null, stack: [], query: "", inbox: false, scope: null, loading: null, dirty: false, total: 0 };
function taskBoardPager() {
  var pager = document.getElementById("taskpager");
  if (!pager) { pager = document.createElement("div"); pager.id = "taskpager"; pager.className = "ui-row tf-taskpager"; $("tasklist").before(pager); }
  pager.innerHTML = '<button class="btn sm ghost" data-board-prev>{{ui.tf.previous}}</button><span>' + (taskBoardState.scope ? '{{ui.tf.taskContext}} · ' : '') + taskBoardState.ids.length + ' / ' + taskBoardState.total + '</span><button class="btn sm ghost" data-board-next>{{ui.tf.next}}</button>' + (taskBoardState.dirty ? '<button class="btn sm ghost" data-board-refresh>{{ui.tf.newTasks}}</button>' : '') + (taskBoardState.scope ? '<button class="btn sm ghost" data-board-clear>{{ui.tf.clear}}</button>' : '');
  pager.querySelector("[data-board-prev]").disabled = !taskBoardState.stack.length; pager.querySelector("[data-board-next]").disabled = !taskBoardState.next;
}
function paintTaskBoard(tasks) {
  var state = taskBoardState, list = $("tasklist"), top = list.scrollTop;
  var attention = window.lastAttention || {}, rows = typeof boardOrder === "function" ? boardOrder(tasks,attention.mine || [],attention.theirs || []) : tasks.map(function (task) { return { task:task }; });
  var byId = new Map(rows.map(function (row) { return [row.task.id,row]; }));
  list.querySelectorAll("[data-board-empty]").forEach(function (node) { node.remove(); });
  var position = list.firstElementChild;
  state.ids.forEach(function (id) {
    var row = byId.get(id); if (!row) return;
    var mark = row.mine ? attentionRow(row.mine,true,true) : row.theirs ? attentionRow(row.theirs,false,true) : "";
    var html = taskBoardMarkup(row.task,mark), node = state.nodes.get(id);
    if (!node) { node = document.createElement("div"); node.setAttribute("data-task-row",id); state.nodes.set(id,node); }
    if (node.__taskHtml !== html && !node.contains(document.activeElement)) { node.innerHTML = html; node.__taskHtml = html; }
    if (node !== position) list.insertBefore(node,position); position = node.nextElementSibling;
  });
  state.nodes.forEach(function (node,id) { if (state.ids.indexOf(id) < 0) { node.remove(); state.nodes.delete(id); } });
  if (!state.ids.length) { var empty = document.createElement("div"); empty.className = "tf-empty"; empty.setAttribute("data-board-empty",""); empty.textContent = "{{ui.app.nothing-on-the-board-add}}"; list.appendChild(empty); }
  list.scrollTop = top; taskBoardPager();
}
function refreshTasks(force) {
  var state = taskBoardState;
  if (state.loading) return state.loading;
  if (state.inbox !== !!window.inboxOnly) { force = true; state.inbox = !!window.inboxOnly; }
  var picker = $("taskassign"), selected = picker.value;
  var options = '<option value="">{{ui.app.unassigned}}</option>' + agents.map(function (agent) { return '<option value="' + esc(agent.id) + '">' + esc(agent.name) + '</option>'; }).join("");
  if (picker.innerHTML !== options && document.activeElement !== picker) { picker.innerHTML = options; picker.value = selected; }
  var full = force === true || !state.query;
  if (full) { state.cursor = null; state.stack = []; state.dirty = false; }
  state.loading = renderAttention().then(function () {
    if (full) {
      var priority = (window.lastAttention && window.lastAttention.mine || []).map(function (item) { return item.ref; }).filter(function (id) { return /^t\d+$/.test(id); }).slice(0,100);
      var query = new URLSearchParams({limit:"50",priority:priority.join(",")});
      if (state.inbox) query.set("inbox","1"); if (state.scope) { query.set("agent",state.scope.agent); query.set("conversation",state.scope.conversation); }
      state.query = query.toString();
    }
    var query = new URLSearchParams(state.query);
    if (!full && state.refreshIds) query.set("ids",state.ids.join(",")); else if (state.cursor) query.set("cursor",state.cursor);
    return fetch("/api/tasks/list?" + query).then(function (response) { return response.json().then(function (body) { if (!response.ok) { var error = new Error(body.error); error.status = response.status; throw error; } return body; }); });
  }).then(function (data) {
    if (!state.refreshIds || full) { state.ids = data.tasks.map(function (task) { return task.id; }); state.next = data.nextCursor; }
    else { state.ids = state.ids.filter(function (id) { return data.tasks.some(function (task) { return task.id === id; }); }); if (!state.stack.length && JSON.stringify(data.head) !== JSON.stringify(state.ids)) state.dirty = true; }
    state.total = data.total; state.refreshIds = true; paintTaskBoard(data.tasks);
  }).catch(function (error) { state.dirty = true; taskBoardPager(); if (error.status !== 409) feed("{{ui.tf.error}}", ""); }).then(function () { state.loading = null; });
  return state.loading;
}
document.addEventListener("click",function (event) {
  var target = event.target && event.target.closest ? event.target : null; if (!target) return;
  var next = target.closest("[data-board-next]"), previous = target.closest("[data-board-prev]"), reload = target.closest("[data-board-refresh]"), clear = target.closest("[data-board-clear]");
  if (!next && !previous && !reload && !clear) return;
  event.preventDefault(); var state = taskBoardState; if (state.loading) return;
  if (clear) { state.scope = null; refreshTasks(true); return; }
  if (reload) { refreshTasks(true); return; }
  if (next && state.next) { state.stack.push(state.cursor); state.cursor = state.next; }
  else if (previous && state.stack.length) state.cursor = state.stack.pop();
  else return;
  state.refreshIds = false; $("tasklist").scrollTop = 0; refreshTasks();
});
var taskBoardChangeQueued = false;
window.noteTaskBoardChange = function (event) {
  var state = taskBoardState;
  if (state.ids.indexOf(event.taskId) < 0) state.dirty = true;
  if (window.taskFocusVisible || $("tasksview").style.display === "none" || taskBoardChangeQueued) return;
  taskBoardChangeQueued = true;
  setTimeout(function () { taskBoardChangeQueued = false; if (!window.taskFocusVisible && $("tasksview").style.display !== "none") refreshTasks(); },500);
};
window.openTasksForConversation = function () {
  if (!current) return;
  var agent = current, conversation = currentConversation;
  return fetch("/api/tasks/list?" + new URLSearchParams({agent:agent,conversation:conversation,limit:"50"})).then(function (response) { return response.json(); }).then(function (data) {
    if (current !== agent || currentConversation !== conversation) return;
    if (data.total === 1) return window.openTaskFocus(data.tasks[0].id);
    taskBoardState.scope = {agent:agent,conversation:conversation}; taskBoardState.query = ""; showTab("tasks"); return refreshTasks(true);
  });
};
`;
