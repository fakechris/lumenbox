/** Keyed, paged board rows; a refresh never replaces the entire list (INV-1786). */
export const TASK_BOARD_STYLE = String.raw`
 .task-row{padding:var(--sp-4);border-bottom:1px solid var(--border);min-width:0}.task-row.is-open{background:var(--surface)}.task-row-head{display:flex;flex-direction:column;gap:var(--sp-1);align-items:flex-start}.task-id{font-size:var(--fs-xs);color:var(--muted);text-decoration:none}.task-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:var(--fs-body);line-height:1.5;font-weight:500;color:var(--text);text-decoration:none;overflow-wrap:anywhere}.task-title:hover{text-decoration:underline}.task-controls{margin-top:var(--sp-3)}.task-meta,.task-attention{font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}.task-meta{margin-top:var(--sp-2)}.task-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-style:normal}.task-badges{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);margin-top:var(--sp-2);min-width:0}.task-badges:empty{display:none}.task-badges .chip{font-size:var(--fs-xs);white-space:normal;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}.task-attention{margin-top:var(--sp-2);padding-top:var(--sp-2);border-top:1px solid var(--border)}.task-warn{color:var(--warn)}.task-danger{color:var(--danger)}.task-muted{color:var(--muted)}.task-select-field{margin:0;display:flex;gap:var(--sp-2);align-items:center}.task-select-field label{font-size:var(--fs-xs);color:var(--muted);margin:0}.task-select-field select{font-size:var(--fs-sm);padding:var(--sp-1) var(--sp-5) var(--sp-1) var(--sp-2);max-width:100%}.task-status-doing{color:var(--accent)}.task-status-blocked{color:var(--warn)}.task-status-review{color:var(--accent-2)}.task-status-done{color:var(--success)}

`;
export const TASK_BOARD_JS = String.raw`function taskBoardMarkup(task, mark) {
  var assignee = task.assigneeId ? nameOf(task.assigneeId) : "{{ui.app.unassigned}}";
  var reviewer = task.reviewerId ? " {{ui.app.review-by}} " + esc(nameOf(task.reviewerId)) : "";
  var last = task.history && task.history.length ? task.history[task.history.length - 1] : null;
  var lastNote = last && last.note ? esc(last.note) : "";
  var proposed = task.proposedBy ? ' <span class="chip ui-badge">{{ui.app.proposed}}</span> <button class="btn sm accent" data-commit="' + esc(task.id) + '" title="{{ui.app.make-this-proposal-real-work}}">{{ui.app.commit}}</button>' + (task.status !== "dropped" ? ' <button class="btn sm ghost" data-dismiss="' + esc(task.id) + '" title="{{ui.app.not-worth-doing-closes-it}}">{{ui.app.dismiss}}</button>' : '') + (task.discovery ? ' <span class="chip ui-badge" title="' + esc(task.discovery.evidence) + '">' + esc(task.discovery.kind) + ' {{ui.app.from-3}} ' + esc(task.discovery.source) + (task.discovery.whyNow ? ' — ' + esc(task.discovery.whyNow) : '') + '</span>' : '') : '';
  var progress = task.progress && window.taskProgressHtml ? '<div class="dim task-meta">' + esc(progressLines(task.progress,MSG_LOCALE)[0]) + '</div>' : "";
  var live = task.status !== "done" && task.status !== "dropped";
  var overdue = live && task.due && Date.parse(task.due) < Date.now();
  var dueChip = task.due ? ' <span class="chip ui-badge' + (overdue ? ' task-danger' : '') + '" title="{{ui.app.due}}">' + (overdue ? '{{ui.app.overdue}} ' : '{{ui.app.due}} ') + esc(String(task.due).slice(0,10)) + '</span>' : '';
  var agingChip = live && task.aging ? ' <span class="chip ui-badge task-warn" title="{{ui.app.nudged}} ' + task.aging.nudges + '/2">{{ui.app.nudged}} ' + task.aging.nudges + '/2</span>' : '';
  var closeChip = live && task.closeProposal ? ' <span class="chip ui-badge task-warn" title="' + esc(task.closeProposal.reason) + '">{{ui.app.close-proposed-by}} ' + esc(nameOf(task.closeProposal.by)) + '{{ui.app.closes}} ' + esc(String(task.closeProposal.decideBy).slice(0,16).replace('T',' ')) + '</span> <button class="btn ghost sm" data-oppose="' + esc(task.id) + '">{{ui.app.keep-open}}</button>' : '';
  var waitingChip = live && task.waitingOn ? ' <span class="chip ui-badge" title="{{ui.app.waiting-on-somebody-outside-this}}">{{ui.app.waiting-on}} ' + esc(String(task.waitingOn).slice(0,40)) + '</span>' : '';
  var snoozeChip = live && task.snoozeUntil && Date.parse(task.snoozeUntil) > Date.now() ? ' <span class="chip ui-badge task-muted" title="{{ui.app.quiet-until-then}}">{{ui.app.not-until}} ' + esc(String(task.snoozeUntil).slice(0,10)) + '</span>' : '';
  proposed += dueChip + waitingChip + snoozeChip + agingChip + closeChip + (window.taskDepsChip ? window.taskDepsChip(task) : '') + (live && window.exceptionRetryHtml ? window.exceptionRetryHtml(task) : '');
  var level = task.level ? '<div class="field task-select-field"><label for="task-level-' + esc(task.id) + '">{{ui.tf.autonomy}}</label><select id="task-level-' + esc(task.id) + '" data-level="' + esc(task.id) + '" title="{{ui.tf.autonomy}}">' + [1,2,3,4,5].map(function (n) { return '<option value="' + n + '"' + (n === task.level ? ' selected' : '') + '>L' + n + '</option>'; }).join('') + '</select></div>' : '';
  var status = '<div class="field task-select-field"><label for="task-state-' + esc(task.id) + '">{{ui.tf.taskStatus}}</label><select id="task-state-' + esc(task.id) + '" data-task="' + esc(task.id) + '" class="task-status-' + esc(task.status) + '">' + TASK_STATUSES.map(function (value) { return '<option value="' + value + '"' + (value === task.status ? ' selected' : '') + '>' + t('ui.tf.board.' + value) + '</option>'; }).join('') + '</select></div>';
  return '<div class="task-row' + (task.id === openTask ? ' is-open' : '') + '"><div class="task-row-head"><a href="#" data-open="' + esc(task.id) + '" class="mono task-id">' + esc(task.id) + '</a><a href="#" data-open="' + esc(task.id) + '" class="task-title" title="' + esc(task.title) + '">' + esc(task.title) + '</a></div><div class="dim task-meta">' + esc(assignee) + reviewer + '</div>' + (lastNote ? '<div class="dim task-meta task-preview">' + lastNote + '</div>' : '') + progress + '<div class="ui-row task-controls">' + status + level + '</div><div class="task-badges">' + proposed + '</div>' + (mark ? '<div class="task-attention">' + mark + '</div>' : '') + '</div>';
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
