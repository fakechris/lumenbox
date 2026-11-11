/** Keyed, paged board rows; a refresh never replaces the entire list (INV-1786). */
export const TASK_BOARD_STYLE = String.raw`
 .task-row{padding:var(--sp-4);border-bottom:1px solid var(--border);min-width:0}.task-row.is-open{background:var(--surface)}.task-row-head{display:flex;flex-direction:column;gap:var(--sp-1);align-items:flex-start}.task-id{font-size:var(--fs-xs);color:var(--muted);text-decoration:none}.task-title{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:var(--fs-body);line-height:1.5;font-weight:500;color:var(--text);text-decoration:none;overflow-wrap:anywhere}.task-title:hover{text-decoration:underline}.task-meta,.task-attention{font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}.task-meta{margin-top:var(--sp-2)}.task-preview{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-style:normal}.task-badges{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);margin-top:var(--sp-2);min-width:0}.task-badges:empty{display:none}.task-badges .chip{font-size:var(--fs-xs);white-space:normal;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}.task-attention{margin-top:var(--sp-2);padding-top:var(--sp-2);border-top:1px solid var(--border)}.task-warn{color:var(--warn)}.task-danger{color:var(--danger)}.task-muted{color:var(--muted)}.task-status-doing{color:var(--accent)}.task-status-blocked{color:var(--warn)}.task-status-review{color:var(--accent-2)}.task-status-done{color:var(--success)}

.task-reading-status{font-size:var(--fs-sm);color:var(--text-soft);margin-bottom:var(--sp-2)}.task-card-footer{margin-top:var(--sp-3);font-size:var(--fs-xs);color:var(--muted)}.task-reading-action{font-size:var(--fs-sm);color:var(--accent);margin-top:var(--sp-3)}
`;
export const TASK_BOARD_JS = String.raw`
function taskBoardMarkup(task) {
  var state = t("ui.tf.board." + task.status), progress = task.progress && window.taskProgressHtml ? progressLines(task.progress,MSG_LOCALE)[0] : "";
  var meta = taskBoardState.mode === "team" ? esc(task.assigneeId ? nameOf(task.assigneeId) : t("ui.app.unassigned")) + ' · ' : '';
  var live = task.status !== "done" && task.status !== "dropped";
  var decision = live && (window.lastAttention && window.lastAttention.mine || []).find(function (item) { return item.ref === task.id && (item.kind !== "review" || task.status === "review") && (item.kind !== "close-proposal" || task.closeProposal); });
  var owed = decision ? decision.detail + (decision.deadline ? ' · ' + new Date(decision.deadline).toLocaleString() : '') : "";
  var hint = task.proposedBy ? t("ui.tc.proposal") : task.waitingOn || (task.status === "review" && !owed ? t("ui.tc.awaitReview") : "");
  return '<article class="task-row"><div class="task-reading-status task-status-' + esc(task.status) + '">' + esc(task.proposedBy ? t("ui.app.proposed") : state) + '</div><a href="#" class="task-title" data-open="' + esc(task.id) + '">' + esc(task.title) + '</a>' + (progress ? '<p class="task-meta">' + esc(progress) + '</p>' : '') + (hint ? '<p class="dim task-meta task-preview">' + esc(hint) + '</p>' : '') + (owed ? '<p class="task-meta task-warn task-preview">' + esc(t("ui.app.needs-you")) + ' ' + esc(owed) + '</p>' : '') + '<div class="task-card-footer">' + (task.conversation ? '' : esc(t("ui.tc.unlinked")) + ' · ') + meta + esc(new Date(task.updatedAt).toLocaleString()) + '</div><a href="#" class="task-reading-action" data-open="' + esc(task.id) + '">' + esc(t(task.status === "review" ? "ui.tc.viewResult" : "ui.tc.viewTask")) + ' →</a></article>';
}
function newBoardPage() { return {ids:[],nodes:new Map(),cursor:null,next:null,stack:[],query:"",loading:null,generation:0,total:0,dirty:false,refreshIds:false}; }
var internalTaskRecords = false;
var taskBoardState = Object.assign(newBoardPage(),{mode:"context",context:""}), taskOtherState = newBoardPage();
function boardKey() { return (taskBoardState.mode === "team" ? "team" : String(current || "") + ":" + String(currentConversation || "main")) + JSON.stringify(internalTaskRecords); }
function resetBoardPage(state,list) {
  state.generation++; state.loading = null; state.query = ""; state.ids = []; state.nodes.clear(); state.cursor = null; state.stack = []; state.next = null; state.refreshIds = false; state.total = 0; state.dirty = false;
  $(list).textContent = ""; $(list).scrollTop = 0;
}
$("task-records-toggle").onclick = function () { internalTaskRecords = !internalTaskRecords; refreshTasks(true); };
function taskScopeHeader() {
  $("task-records-toggle").textContent = t(internalTaskRecords ? "ui.tc.userRecords" : "ui.tc.internalRecords");
  var team = taskBoardState.mode === "team", member = current ? nameOf(current) : "";
  $("taskscope-title").textContent = team ? t("ui.tc.team") : current ? t("ui.tc.memberTasks",{name:member}) : t("ui.page.tasks");
  var conv = typeof conversationLabel === "function" ? conversationLabel((typeof convLoaded !== "undefined" ? convLoaded : []).find(function (c) { return c.id === currentConversation; }) || {id:currentConversation || "main"}) : currentConversation || "main";
  $("taskscope-note").textContent = internalTaskRecords ? t("ui.tc.internalNote") : team ? t("ui.tc.teamNote") : current ? t("ui.tc.conversation",{name:conv}) : t("ui.tc.chooseMember");
  $("taskscope-back").hidden = !team || !current; $("taskothers").hidden = team || !current;
  $("taskother-label").textContent = t("ui.tc.otherConversations",{name:member});
  document.body.classList.toggle("task-team-visible",team && $("tasksview").style.display !== "none");
}
window.taskBoardContextChanged = function () {
  taskBoardState.mode = "context"; taskBoardState.context = boardKey(); resetBoardPage(taskBoardState,"tasklist"); resetBoardPage(taskOtherState,"taskotherlist");
  $("taskothers").open = false; $("taskboard-error").hidden = true; taskScopeHeader();
  if (window.taskFocusVisible && window.closeTaskFocusForContext) window.closeTaskFocusForContext();
  if ($("tasksview").style.display !== "none") refreshTasks(true);
};
window.openTeamTasks = function () {
  if (window.taskFocusVisible && window.closeTaskFocusForContext) window.closeTaskFocusForContext();
  taskBoardState.mode = "team"; taskBoardState.context = "team"; resetBoardPage(taskBoardState,"tasklist"); resetBoardPage(taskOtherState,"taskotherlist");
  $("taskothers").open = false; showTab("tasks"); taskScopeHeader();
};
function taskBoardPager(state,other) {
  state = state || taskBoardState; var id = other ? "taskotherpager" : "taskpager", pager = $(id);
  if (!pager) { pager = document.createElement("div"); pager.id = id; pager.className = "ui-row tf-taskpager"; $("tasklist").before(pager); }
  pager.innerHTML = '<button class="btn sm ghost" data-board-prev' + (other ? ' data-other="1"' : '') + '>{{ui.tf.previous}}</button><span>' + (state.ids.length ? (state.stack.length * 50 + 1) + '–' + (state.stack.length * 50 + state.ids.length) : '0') + ' / ' + state.total + '</span><button class="btn sm ghost" data-board-next' + (other ? ' data-other="1"' : '') + '>{{ui.tf.next}}</button>' + (state.dirty ? '<button class="btn sm ghost" data-board-refresh' + (other ? ' data-other="1"' : '') + '>{{ui.tf.newTasks}}</button>' : '');
  pager.querySelector("[data-board-prev]").disabled = !state.stack.length; pager.querySelector("[data-board-next]").disabled = !state.next;
}
function paintTaskBoard(tasks,state,other) {
  state = state || taskBoardState; var list = $(other ? "taskotherlist" : "tasklist"), reading = $(other ? "taskotherlist" : "taskreading"), top = reading.scrollTop, byId = new Map(tasks.map(function (task) { return [task.id,task]; }));
  list.querySelectorAll("[data-board-empty]").forEach(function (node) { node.remove(); }); var position = list.firstElementChild;
  state.ids.forEach(function (id) {
    var task = byId.get(id); if (!task) return; var html = taskBoardMarkup(task), node = state.nodes.get(id);
    if (!node) { node = document.createElement("div"); node.setAttribute("data-task-row",id); state.nodes.set(id,node); }
    if (node.__taskHtml !== html && !node.contains(document.activeElement)) { node.innerHTML = html; node.__taskHtml = html; }
    if (node !== position) list.insertBefore(node,position); position = node.nextElementSibling;
  });
  state.nodes.forEach(function (node,id) { if (state.ids.indexOf(id) < 0) { node.remove(); state.nodes.delete(id); } });
  if (!state.ids.length) { var empty = document.createElement("div"); empty.className = "tf-empty"; empty.setAttribute("data-board-empty",""); empty.textContent = t(taskBoardState.mode === "team" ? "ui.tc.noTeamTasks" : other ? "ui.tc.noOtherTasks" : "ui.tc.noConversationTasks"); list.appendChild(empty); }
  reading.scrollTop = top; taskBoardPager(state,other);
}
function readTaskBoard(state,force,other) {
  if (state.loading) return state.loading;
  var full = force === true || !state.query, key = boardKey(), generation = ++state.generation;
  if (full) { state.cursor = null; state.stack = []; state.dirty = false; state.refreshIds = false; }
  var reading = renderAttention().then(function () {
    if (generation !== state.generation || key !== boardKey()) return null;
    if (full) {
      var priority = (window.lastAttention && window.lastAttention.mine || []).map(function (item) { return item.ref; }).filter(function (id) { return /^t\d+$/.test(id); }).slice(0,100);
      var query = new URLSearchParams({limit:"50",priority:priority.join(",")});
      query.set("records",internalTaskRecords ? "internal" : "user");
      if (taskBoardState.mode !== "team") { query.set("agent",current); query.set("conversation",currentConversation || "main"); if (other) query.set("other","1"); }
      state.query = query.toString();
    }
    var query = new URLSearchParams(state.query);
    if (!full && state.refreshIds) query.set("ids",state.ids.join(",")); else if (state.cursor) query.set("cursor",state.cursor);
    return fetch("/api/tasks/list?" + query).then(function (response) { return response.json().then(function (body) { if (!response.ok) { var error = new Error(body.error); error.status = response.status; throw error; } return body; }); });
  }).then(function (data) {
    if (!data || generation !== state.generation || key !== boardKey()) return;
    if (!state.refreshIds || full) { state.ids = data.tasks.map(function (task) { return task.id; }); state.next = data.nextCursor; }
    else { state.ids = state.ids.filter(function (id) { return data.tasks.some(function (task) { return task.id === id; }); }); if (!state.stack.length && JSON.stringify(data.head) !== JSON.stringify(state.ids)) state.dirty = true; }
    state.total = data.total; state.refreshIds = true; $("taskboard-error").hidden = true; paintTaskBoard(data.tasks,state,other);
  }).catch(function (error) {
    if (generation !== state.generation || key !== boardKey()) return;
    if ([401,403,404].indexOf(error.status) >= 0) { resetBoardPage(taskBoardState,"tasklist"); resetBoardPage(taskOtherState,"taskotherlist"); $("taskothers").open = false; }
    state.dirty = true; $("taskboard-error").hidden = false; taskBoardPager(state,other);
  }).finally(function () { if (state.loading === reading) state.loading = null; });
  state.loading = reading; return reading;
}
function refreshTasks(force) {
  var key = boardKey();
  if (taskBoardState.context !== key) { taskBoardState.context = key; resetBoardPage(taskBoardState,"tasklist"); resetBoardPage(taskOtherState,"taskotherlist"); $("taskothers").open = false; }
  taskScopeHeader();
  if (taskBoardState.mode !== "team" && !current) { $("tasklist").textContent = t("ui.tc.chooseMember"); return Promise.resolve(); }
  return readTaskBoard(taskBoardState,force,false).then(function () { if ($("taskothers").open) return readTaskBoard(taskOtherState,force,true); });
}
$("taskothers").addEventListener("toggle",function () { if (this.open && !this.hidden) readTaskBoard(taskOtherState,false,true); });
document.addEventListener("click",function (event) {
  var target = event.target && event.target.closest ? event.target : null; if (!target) return;
  if (target.closest("#alltasksnav")) { event.preventDefault(); window.openTeamTasks(); return; }
  if (target.closest("#taskscope-back")) { event.preventDefault(); window.taskBoardContextChanged(); return; }
  var next = target.closest("[data-board-next]"), previous = target.closest("[data-board-prev]"), reload = target.closest("[data-board-refresh]");
  var button = next || previous || reload; if (!button) return; event.preventDefault(); var other = button.hasAttribute("data-other"), state = other ? taskOtherState : taskBoardState;
  if (state.loading) return; if (reload) { if (other) readTaskBoard(state,true,true); else refreshTasks(true); return; }
  if (next && state.next) { state.stack.push(state.cursor); state.cursor = state.next; } else if (previous && state.stack.length) state.cursor = state.stack.pop(); else return;
  state.refreshIds = false; $(other ? "taskotherlist" : "tasklist").scrollTop = 0; readTaskBoard(state,false,other);
});
$("taskotherlist").addEventListener("click",function (event) { var link = event.target.closest("[data-open]"); if (link) { event.preventDefault(); window.openTaskFocus(link.getAttribute("data-open")); } });
var taskBoardChangeQueued = false;
window.noteTaskBoardChange = function (event) {
  // The authorized, audience-filtered head decides whether new user work arrived.
  if (window.taskFocusVisible || $("tasksview").style.display === "none" || taskBoardChangeQueued) return;
  taskBoardChangeQueued = true; setTimeout(function () { taskBoardChangeQueued = false; if (!window.taskFocusVisible && $("tasksview").style.display !== "none") refreshTasks(); },500);
};
window.openTasksForConversation = function () { window.taskBoardContextChanged(); showTab("tasks"); };
`;
