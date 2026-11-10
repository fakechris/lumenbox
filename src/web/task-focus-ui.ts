/** One task workspace, backed by the authorized execution projection (INV-1786). */
export const TASK_FOCUS_STYLE = String.raw`
html:has(#taskfocus:not([hidden])),body:has(> #taskfocus:not([hidden])){overflow:hidden}body:has(> #taskfocus:not([hidden])) #chat{content-visibility:hidden}#taskfocus[hidden]{display:none}#taskfocus{position:fixed;inset:40px 0 0 224px;z-index:25;background:var(--bg);display:flex;flex-direction:column;min-width:0}
.tf-head{padding:var(--sp-5) var(--sp-6) var(--sp-3);border-bottom:1px solid var(--border);background:var(--surface)}.tf-top,.tf-status,.tf-pager,.tf-filters{gap:var(--sp-3)}.tf-top{justify-content:space-between}.tf-head h1{font-size:var(--fs-xl);line-height:1.25;font-weight:500;margin:var(--sp-4) 0 var(--sp-3);max-width:1000px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.tf-status{font-size:var(--fs-sm)}.tf-status b{font-weight:500}.tf-status span{display:inline-flex;gap:var(--sp-2);align-items:center}.tf-status i{width:var(--sp-1);height:var(--sp-1);border-radius:var(--radius-pill);background:var(--accent)}.tf-activity{font-size:var(--fs-sm);line-height:1.7;margin-top:var(--sp-3);color:var(--text-soft)}.tf-needs{padding:var(--sp-3) 0;color:var(--warn)}
.tf-tabs{display:flex;gap:var(--sp-5);margin-top:var(--sp-4)}.tf-tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:var(--sp-2) 0;font:inherit;font-size:var(--fs-md);color:var(--muted);cursor:pointer}.tf-tabs button[aria-selected=true]{color:var(--text);border-color:var(--accent)}.tf-tabs button:focus-visible,.tf-step:focus-visible{outline:2px solid var(--accent);outline-offset:var(--sp-1)}
.tf-body{flex:1;min-height:0;overflow:auto}.tf-overview{max-width:1000px;padding:var(--sp-5) var(--sp-6);line-height:1.65}.tf-overview h2{font-size:var(--fs-md);margin:0 0 var(--sp-3);font-weight:600}.tf-overview section{margin-bottom:26px}.tf-overview p{white-space:pre-wrap;margin:var(--sp-2) 0}.tf-note{font-size:var(--fs-sm);color:var(--muted);line-height:1.6}.tf-execution{height:100%;display:flex;flex-direction:column}.tf-filters{padding:var(--sp-3) var(--sp-5);border-bottom:1px solid var(--border);font-size:var(--fs-sm)}.tf-filters .field{margin:0;display:flex;gap:var(--sp-2);align-items:center}.tf-filters label{margin:0}.tf-filters select{font:inherit;font-size:var(--fs-md);background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-input);padding:var(--sp-1);max-width:180px}.tf-split{display:grid;grid-template-columns:minmax(280px,38%) minmax(0,1fr);flex:1;min-height:0}.tf-list{overflow:auto;border-right:1px solid var(--border);padding:var(--sp-2) 0}.tf-step{display:block;width:100%;border:0;background:none;text-align:left;padding:var(--sp-3) var(--sp-5);color:var(--text);cursor:pointer;border-bottom:1px solid var(--border);font:inherit;font-size:var(--fs-sm)}.tf-step:hover{background:var(--surface-hover)}.tf-step[aria-pressed=true]{background:var(--accent-soft)}.tf-step strong{display:block;font-size:var(--fs-md);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tf-step small{display:block;color:var(--muted);font-size:var(--fs-xs);margin-top:var(--sp-1)}.tf-step .tf-failed,.tf-step .tf-unknown{color:var(--danger)}.tf-group{padding:var(--sp-3) var(--sp-5) var(--sp-1);font-size:var(--fs-xs);letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}.tf-detail{overflow:auto;padding:var(--sp-5) var(--sp-6);min-width:0}.tf-detail h2{font-size:var(--fs-lg);font-weight:500;margin:0 0 var(--sp-3)}.tf-detail h3{font-size:var(--fs-sm);font-weight:600;margin:var(--sp-5) 0 var(--sp-2)}.tf-detail pre{font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code-bg);color:var(--code-text);padding:var(--sp-3);border-radius:var(--radius-input)}.tf-detail code{overflow-wrap:anywhere}.tf-pager{padding:var(--sp-3) var(--sp-5);border-top:1px solid var(--border);font-size:var(--fs-sm);justify-content:space-between}.tf-backsteps{display:none}.tf-empty{padding:var(--sp-5);color:var(--muted);font-size:var(--fs-md)}.tf-loading{color:var(--muted)}.tf-taskpager{padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border);display:flex;gap:var(--sp-2);align-items:center;font-size:var(--fs-sm)}.tf-taskpager span{flex:1}
@media(max-width:900px){#taskfocus{left:0}.tf-head{padding:var(--sp-4) var(--sp-4) var(--sp-2)}.tf-overview{padding:var(--sp-5) var(--sp-4)}.tf-split{grid-template-columns:minmax(200px,42%) minmax(0,1fr)}.tf-detail{padding:var(--sp-4)}.tf-filters{padding:var(--sp-3) var(--sp-4)}.tf-step{padding:var(--sp-3) var(--sp-3)}}
@media(max-width:600px){.tf-split{display:flex;flex-direction:column;overflow:hidden}.tf-list{flex:1;min-height:0;max-height:none;border-right:0;border-bottom:1px solid var(--border)}.tf-detail{flex:1;min-height:0}.tf-backsteps{display:inline-block}#taskfocus.tf-detail-selected .tf-list{display:none}#taskfocus:not(.tf-detail-selected) .tf-detail{display:none}#taskfocus.tf-detail-selected .tf-filters,#taskfocus.tf-detail-selected .tf-coverage{display:none}.tf-tabs{gap:var(--sp-4)}.tf-head h1{font-size:var(--fs-xl)}.tf-status{gap:var(--sp-2)}.tf-body{overflow:hidden}.tf-overview{height:100%;overflow:auto;box-sizing:border-box}}
.tf-coverage{padding:var(--sp-2) var(--sp-5)}
`;

export const TASK_FOCUS_JS = String.raw`(function () {
  var views = new Map(), active = null, root = null, returnFocus = null;
  var TABS = ["overview","execution","artifacts","costs"];
  function word(key) { return t("ui.tf." + key); }
  function safe(text) { return esc(text == null ? "" : String(text)); }
  function by(id) { return document.getElementById("tf-" + id); }
  function get(path, signal) {
    return fetch(path, { signal: signal }).then(function (response) {
      return response.json().then(function (body) { if (!response.ok) { var error = new Error(body.error || word("error")); error.status = response.status; throw error; } return body; });
    });
  }
  function remember(view) {
    try { sessionStorage.setItem("lumen-task-view:" + view.id, JSON.stringify({ tab: view.tab, filters: view.filters, selected: view.selected, anchor: view.readingAnchor && view.readingAnchor.id || view.page && view.page.steps[0] && view.page.steps[0].id, listTop: view.listTop, readingAnchor: view.readingAnchor })); } catch (error) {}
    if (active !== view) return;
    var url = new URL(location.href); url.searchParams.set("task", view.id); url.searchParams.set("tasktab", view.tab);
    if (view.selected) url.searchParams.set("step", view.selected); else url.searchParams.delete("step");
    history.replaceState({}, "", url);
  }
  function ensure() {
    if (root) return;
    root = document.createElement("section"); root.id = "taskfocus"; root.hidden = true; root.setAttribute("aria-label", word("title"));
    root.innerHTML = '<header class="tf-head"><div class="ui-row tf-top"><button class="btn sm ghost" data-tf-close>' + word("back") + '</button><span class="dim mono" id="tf-id"></span><button class="btn sm ghost" data-tf-conversation>' + word("conversation") + '</button></div><h1 id="tf-title"></h1><div id="tf-status" class="ui-row tf-status"></div><div id="tf-activity" class="tf-activity"></div><div id="tf-needs" class="tf-needs"></div><button class="btn sm ghost" id="tf-new" data-tf-refresh hidden>' + word("new") + '</button><nav class="tf-tabs" role="tablist">' + TABS.map(function (tab) { return '<button role="tab" id="tf-tab-' + tab + '" data-tf-tab="' + tab + '" aria-controls="tf-body">' + word(tab) + '</button>'; }).join("") + '</nav></header><div id="tf-body" class="tf-body" role="tabpanel"></div>';
    document.body.appendChild(root);
    root.addEventListener("click", click);
    root.addEventListener("change", function (event) {
      if (event.target.hasAttribute("data-tf-status") && active) {
        var view = active;
        fetch("/api/tasks/update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:view.id,status:event.target.value})}).then(function (response) { return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || word("error")); return body; }); }).then(function (body) {
          if (body.note) feed(safe(body.note),"warn"); return window.refreshTaskExecution();
        }).then(function () { if (active === view && view.task) render(view); }).catch(function (error) { if (active === view) { by("needs").textContent = error.message; loadItem(view); } });
        return;
      }
      var filter = event.target.getAttribute("data-tf-filter"); if (!filter || !active) return;
      root.classList.remove("tf-detail-selected"); active.mobileDetail = false;
      active.filters[filter] = event.target.value; active.selected = ""; active.readingAnchor = null; active.detail = null; active.detailGeneration++; if (active.detailController) active.detailController.abort(); if (by("detail")) by("detail").textContent = word("select"); active.page = null; active.rowNodes = new Map(); remember(active); loadPage(active, null, null, true);
    });
    root.addEventListener("keydown", function (event) {
      var tab = event.target.getAttribute("data-tf-tab");
      if (tab && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
        event.preventDefault(); var tabs = ["overview","execution","artifacts","costs"], index = tabs.indexOf(tab);
        changeTab(tabs[(index + (event.key === "ArrowRight" ? 1 : 3)) % 4]); by("tab-" + active.tab).focus();
      }
      if (event.key === "Escape") close(true);
    });
  }
  function viewFor(id) {
    if (views.has(id)) return views.get(id);
    var saved = {}; try { saved = JSON.parse(sessionStorage.getItem("lumen-task-view:" + id) || "{}"); } catch (error) {}
    var view = { id: id, tab: saved.tab || "overview", filters: Object.fromEntries(["role","outcome","work"].filter(function (key) { return saved.filters && typeof saved.filters[key] === "string"; }).map(function (key) { return [key,saved.filters[key]]; })), selected: saved.selected || "", anchor: saved.anchor, listTop: saved.listTop, readingAnchor: saved.readingAnchor,
      rowNodes: new Map(), generation: 0, detailGeneration: 0, page: null, task: null, detail: null };
    if (["overview","execution","artifacts","costs"].indexOf(view.tab) < 0) view.tab = "overview";
    views.set(id, view); while (views.size > 8) views.delete(views.keys().next().value);
    return view;
  }
  function connection() { return document.documentElement.dataset.connection || "reconnecting"; }
  function status(task) {
    if (task.status === "done" || task.status === "dropped") return word(task.status === "done" ? "ended" : "dropped");
    if (task.pursuit && task.pursuit.status === "paused") return word("paused") + (task.pursuit.pausedReason ? " · " + t("ui.tf.pause." + task.pursuit.pausedReason) : "");
    if (task.pursuit && task.pursuit.status === "verifying") return word("verifying");
    if (task.needsApprovals && task.needsApprovals.length) return word("approval");
    var stage = task.stage || "";
    return stage === "working" ? word("working") : stage === "working/queued" ? word("queued") : stage.indexOf("person/") === 0 ? word("needs") : task.status === "done" ? word("ended") : task.status === "dropped" ? word("dropped") : word("idle");
  }
  function actionName(step) {
    if (!step) return word("noActivity");
    var names = { read_file: "read", bash: "command", WebSearch: "search", web_search: "search", compacted: "compacted", retrying: "retrying" };
    return (names[step.name] ? word(names[step.name]) : step.name) + (step.detail ? " · " + step.detail : "");
  }
  function header(view) {
    if (active !== view || !view.task) return;
    var task = view.task, activity = view.activity || {}, latest = view.liveAction || activity.current || activity.latest;
    by("title").textContent = task.pursuit && task.pursuit.objective || task.title; by("title").title = by("title").textContent;
    by("id").textContent = task.id;
    var review = task.status === "review" ? word("review") : task.status === "done" ? word("ended") : task.status === "dropped" ? word("dropped") : word("pending");
    var statuses = [["state",status(task)],["connection",word(connection())],["acceptance",review]];
    root.querySelector("[data-tf-conversation]").disabled = !task.assigneeId;
    by("status").innerHTML = statuses.map(function (pair) { return '<span><i></i><b>' + word(pair[0]) + '</b> ' + safe(pair[1]) + '</span>'; }).join("");
    by("activity").textContent = word("action") + ": " + actionName(latest) + (latest && (latest.endedAt || latest.startedAt) ? " · " + word("activity") + " " + new Date(latest.endedAt || latest.startedAt).toLocaleString() : "");
    var terminal = task.status === "done" || task.status === "dropped";
    var needs = terminal ? [] : (window.lastAttention && window.lastAttention.mine || []).filter(function (item) { return item.ref === task.id && (!item.stage || item.stage === task.stage) && (item.kind !== "review" || task.status === "review"); });
    by("needs").innerHTML = needs.map(function (item) { return attentionRow(item, true, true); }).join("") + (terminal ? [] : task.needsApprovals || []).map(function (item) {
      return '<div class="ui-row"><span>' + word("approval") + ': ' + safe(item.description) + '</span>' + (view.role === "admin" || view.role === "driver" ? '<button class="btn sm" data-att-approve="' + safe(item.id) + '">' + safe(t("consent.once")) + '</button><button class="btn sm ghost" data-att-deny="' + safe(item.id) + '">' + safe(t("consent.deny")) + '</button>' : '') + '</div>';
    }).join("");
    by("new").hidden = !view.dirty;
    ["overview","execution","artifacts","costs"].forEach(function (tab) { by("tab-" + tab).setAttribute("aria-selected", String(tab === view.tab)); by("tab-" + tab).tabIndex = tab === view.tab ? 0 : -1; });
  }
  function deny(view, error) {
    if (active !== view) return;
    view.generation++; view.detailGeneration++; view.costGeneration = (view.costGeneration || 0) + 1; view.cost = null; if (view.detailController) view.detailController.abort();
    view.detail = null; view.task = null; view.page = null; view.rowNodes.clear();
    by("title").textContent = error.status === 403 || error.status === 404 ? word("denied") : word("error");
    by("activity").textContent = ""; by("status").textContent = ""; by("needs").textContent = "";
    by("body").innerHTML = '<div class="tf-empty"><button class="btn sm" data-tf-refresh>' + word("refresh") + '</button></div>';
  }
  function overview(view) {
    var task = view.task, html = '<div class="tf-overview"><section><h2>' + word("goal") + '</h2><p>' + safe(task.pursuit && task.pursuit.objective || task.description || task.title) + '</p>';
    if (task.contract) html += ["outcome","scope","constraints"].filter(function (key) { return task.contract[key]; }).map(function (key) { return '<h2>' + t("ui.tf.contract." + key) + '</h2><p>' + safe(task.contract[key]) + '</p>'; }).join("");
    html += '</section><section><h2>' + word("state") + '</h2><p>' + safe(status(task)) + '</p>' + (window.taskProgressHtml ? window.taskProgressHtml(task) : '<p class="tf-note">' + word("phaseOnly") + '</p>') + '</section>';
    var reply = view.record && view.record.reply;
    if (reply) html += '<section><h2>' + word("latestReply") + '</h2><p>' + safe(reply.text) + '</p><div class="tf-note">' + safe(reply.by) + ' · ' + safe(new Date(reply.at).toLocaleString()) + '</div></section>';
    return html + '<section class="tf-note">' + word("coverage") + '</section></div>';
  }
  function artifacts(view) {
    var task = view.task, checks = task.pursuit && task.pursuit.checklist || [];
    var html = '<div class="tf-overview"><section><h2>' + word("artifacts") + '</h2>' + (window.deliverablesHtml && window.deliverablesHtml(task) || '<p class="tf-note">' + word("noArtifacts") + '</p>') + '</section><section><h2>' + word("reviewer") + '</h2><p>' + safe(task.reviewerId ? nameOf(task.reviewerId) || task.reviewerId : word("noReviewer")) + '</p></section>';
    if (view.role === "admin" || view.role === "driver") {
      var states = {open:"queued",doing:"working",blocked:"needs",review:"review",done:"ended",dropped:"dropped"};
      html += '<section><div class="field"><label for="tf-task-status">' + word("taskStatus") + '</label><select id="tf-task-status" data-tf-status>' + Object.keys(states).map(function (value) { return '<option value="' + value + '"' + (value === task.status ? ' selected' : '') + '>' + word(states[value]) + '</option>'; }).join("") + '</select></div></section>';
    }
    if (task.contract) html += ["acceptance","verification"].filter(function (key) { return task.contract[key]; }).map(function (key) { return '<section><h2>' + t("ui.tf.contract." + key) + '</h2><p>' + safe(task.contract[key]) + '</p></section>'; }).join("");
    if (checks.length) html += '<section><h2>' + word("checklist") + '</h2>' + checks.map(function (item) { return '<p>' + safe(item.text) + (item.verdict ? ' · ' + safe(item.verdict) : '') + '</p>'; }).join("") + '</section>';
    ["claimAccountHtml","orgPromoteHtml","divisionHtml","taskDepsHtml","configVersionsHtml"].forEach(function (fn) { if (window[fn]) html += window[fn](task); });
    if (task.recoveries && task.recoveries.length) html += '<section><h2>' + word("attempt") + '</h2>' + task.recoveries.map(function (attempt) { return '<p>' + safe(attempt.operationId) + ' · ' + word("attempt") + ' ' + attempt.attempt + ' · ' + safe(attempt.status) + '</p>'; }).join("") + '</section>';
    return html + '</div>';
  }
  function costs(view) {
    var pursuit = view.task.pursuit, html = '<div class="tf-overview"><section><h2>' + word("costs") + '</h2><p>' + word("noCost") + '</p></section>';
    if (view.cost && view.cost.report.records > 0) {
      var report = view.cost.report;
      html += '<section><h2>' + word("estimated") + '</h2><p>' + (typeof report.money === "number" ? '$' + report.money.toFixed(4) : word("unknown")) + '</p><p>' + word("inputTokens") + ': ' + report.totals.inputTokens + ' · ' + word("outputTokens") + ': ' + report.totals.outputTokens + '</p><p class="tf-note">' + word("costScope") + ((view.cost.coverage === "partial" || report.compacted) ? ' · ' + word("partial") : '') + '</p></section>';
    }
    if (pursuit) html += '<section><h2>' + word("budget") + '</h2><p>' + safe(pursuit.spent && pursuit.spent.cost) + ' / ' + safe(pursuit.limits && pursuit.limits.budget !== undefined ? pursuit.limits.budget : word("unknown")) + '</p><p class="tf-note">' + word("weighted") + '</p><p>' + word("continuations") + ': ' + safe(pursuit.spent && pursuit.spent.continuations) + '</p></section>';
    return html + '</div>';
  }
  function filters(view) {
    var f = view.filters, groups = view.activity && view.activity.groups || [];
    var work = Array.from(new Set(groups.map(function (g) { return g.workId; })));
    function select(key, values) { return '<div class="field"><label for="tf-filter-' + key + '">' + word(key) + '</label><select id="tf-filter-' + key + '" data-tf-filter="' + key + '"><option value="">' + word("all") + '</option>' + values.map(function (value) { return '<option value="' + safe(value) + '"' + (f[key] === value ? ' selected' : '') + '>' + (key === "work" ? safe(value.slice(0,12)) : word(value)) + '</option>'; }).join("") + '</select></div>'; }
    return select("role",["executor","child","verifier"]) + select("outcome",["running","succeeded","failed","unknown","waiting","refused"]) + select("work",work);
  }
  function syncWorkFilter(view) {
    if (active !== view || view.tab !== "execution") return;
    var select = root.querySelector('[data-tf-filter="work"]'); if (!select || document.activeElement === select) return;
    var values = Array.from(new Set((view.activity && view.activity.groups || []).map(function (group) { return group.workId; })));
    if (view.filters.work && values.indexOf(view.filters.work) < 0) values.push(view.filters.work);
    var html = '<option value="">' + word("all") + '</option>' + values.map(function (value) { return '<option value="' + safe(value) + '">' + safe(value.slice(0,12)) + '</option>'; }).join("");
    if (select.__options !== html) { select.innerHTML = html; select.value = view.filters.work || ""; select.__options = html; }
  }
  function render(view) {
    if (active !== view || !view.task) return;
    header(view); by("body").setAttribute("aria-labelledby","tf-tab-" + view.tab);
    if (view.tab !== "execution") { by("body").innerHTML = view.tab === "artifacts" ? artifacts(view) : view.tab === "costs" ? costs(view) : overview(view); return; }
    by("body").innerHTML = '<div class="tf-execution"><div class="ui-row tf-filters">' + filters(view) + '</div><div class="tf-note tf-coverage" id="tf-coverage"></div><div class="tf-split"><div id="tf-list" class="tf-list" aria-label="' + word("execution") + '"></div><article id="tf-detail" class="tf-detail"></article></div><div class="ui-row tf-pager"><button class="btn sm ghost" data-tf-prev>' + word("previous") + '</button><span id="tf-range"></span><button class="btn sm ghost" data-tf-next>' + word("next") + '</button></div></div>';
    root.classList.toggle("tf-detail-selected",!!view.selected && view.mobileDetail !== false);
    paintPage(view);
    if (view.selected) loadDetail(view, view.selected); else by("detail").textContent = word("select");
  }
  function captureListReading(view) {
    var list = by("list"); if (!list || !view.page) return;
    var top = list.getBoundingClientRect().top;
    var node = Array.from(list.querySelectorAll("[data-tf-step]")).find(function (node) { return node.getBoundingClientRect().bottom > top; });
    if (node) view.readingAnchor = { id:node.getAttribute("data-tf-step"), offset:node.getBoundingClientRect().top - top };
    view.listTop = list.scrollTop;
  }
  function paintPage(view) {
    if (active !== view || view.tab !== "execution" || !by("list")) return;
    var list = by("list"), page = view.page;
    if (!page) { list.innerHTML = '<div class="tf-empty">' + word("loading") + '</div>'; return; }
    by("coverage").textContent = (page.coverage === "partial" ? word("partial") + ' · ' : '') + word("coverage");
    by("range").textContent = page.from + '–' + page.to + ' / ' + page.total;
    root.querySelector("[data-tf-prev]").disabled = !page.previousCursor; root.querySelector("[data-tf-next]").disabled = !page.nextCursor;
    var retained = new Set(), lastGroup = "";
    list.querySelectorAll(".tf-group,.tf-empty").forEach(function (node) { node.remove(); });
    page.steps.forEach(function (step) {
      retained.add(step.id);
      var group = step.role + ' · ' + step.workId + ' · ' + step.conversation + ' · ' + step.attempt;
      if (group !== lastGroup) { var label = document.createElement("div"); label.className = "tf-group"; label.textContent = word(step.role) + ' · ' + word("work") + ' ' + step.workId.slice(0,8) + ' · ' + word("attempt") + ' ' + step.attempt + ' · ' + step.conversation; list.appendChild(label); lastGroup = group; }
      var node = view.rowNodes.get(step.id);
      if (!node) { node = document.createElement("button"); node.type = "button"; node.className = "tf-step"; node.setAttribute("data-tf-step",step.id); view.rowNodes.set(step.id,node); }
      var html = '<strong>' + safe(actionName(step)) + '</strong><small class="tf-' + step.outcome + '">' + word(step.outcome) + ' · ' + safe(new Date(step.startedAt || step.endedAt).toLocaleTimeString()) + '</small>';
      if (node.innerHTML !== html) node.innerHTML = html;
      node.setAttribute("aria-pressed",String(step.id === view.selected)); list.appendChild(node);
    });
    list.querySelectorAll("[data-tf-step]").forEach(function (node) { if (view.rowNodes.get(node.getAttribute("data-tf-step")) !== node) node.remove(); });
    view.rowNodes.forEach(function (node,id) { if (!retained.has(id)) { node.remove(); view.rowNodes.delete(id); } });
    if (!page.steps.length) list.innerHTML = '<div class="tf-empty">' + word("empty") + '</div>';
    var anchor = view.readingAnchor && view.rowNodes.get(view.readingAnchor.id);
    if (anchor) list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - view.readingAnchor.offset;
    else if (view.listTop !== undefined) list.scrollTop = view.listTop;
  }
  function paintDetail(view, detail) {
    if (active !== view || view.tab !== "execution" || !by("detail")) return;
    var panel = by("detail"); panel.textContent = "";
    var back = document.createElement("button"); back.className = "btn sm ghost tf-backsteps"; back.setAttribute("data-tf-list",""); back.textContent = word("backSteps"); panel.appendChild(back);
    var h = document.createElement("h2"); h.textContent = actionName(detail); panel.appendChild(h);
    var state = document.createElement("p"); state.className = "tf-note"; state.textContent = word(detail.role) + ' · ' + word("attempt") + ' ' + detail.attempt + ' · ' + word(detail.outcome); panel.appendChild(state);
    var note = document.createElement("p"); note.className = "tf-note"; note.textContent = word("historical") + (detail.coverage === "partial" ? " · " + word("partial") : ""); panel.appendChild(note);
    if (detail.gate) { var gate = document.createElement("p"); gate.textContent = detail.gate.basis; panel.appendChild(gate); }
    function section(title,text) { var label = document.createElement("h3"); label.textContent = word(title); var pre = document.createElement("pre"); pre.textContent = text; panel.appendChild(label); panel.appendChild(pre); }
    if (detail.kind === "maintenance") section("result",JSON.stringify(detail.maintenance,null,2));
    else { section("input",JSON.stringify(detail.input,null,2)); section("result",detail.result == null ? word("missing") : detail.result); }
    if (detail.sourceExpired || detail.inputTruncated || detail.resultTruncated) { var warning = document.createElement("p"); warning.className = "tf-note"; warning.textContent = detail.sourceExpired ? word("expired") : word("truncated"); panel.appendChild(warning); }
    var sources = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = word("sources"); sources.appendChild(summary);
    var code = document.createElement("pre"); code.textContent = [word("work") + ': ' + detail.workId,word("sourceTurn") + ': ' + detail.turnId,word("sourceExecution") + ': ' + detail.executionId].concat((detail.sourceRefs || []).concat(detail.parent ? [JSON.stringify(detail.parent)] : [])).join("\n"); sources.appendChild(code); panel.appendChild(sources);
    syncApproval(view,detail,panel);
  }
  function syncApproval(view,detail,panel) {
    if (view.role !== "admin" && view.role !== "driver") return;
    if (detail.gate && detail.gate.approvalId) get("/api/policy").then(function (data) {
      if (active !== view || view.selected !== detail.id || !panel || !panel.isConnected) return;
      panel.querySelectorAll("[data-tf-approval]").forEach(function (node) { node.remove(); });
      if (!(data.pending || []).some(function (item) { return item.id === detail.gate.approvalId; })) return;
      var actions = document.createElement("div"); actions.setAttribute("data-tf-approval",""); actions.innerHTML = '<button class="btn sm" data-att-approve="' + safe(detail.gate.approvalId) + '">' + safe(t("consent.once")) + '</button> <button class="btn sm ghost" data-att-deny="' + safe(detail.gate.approvalId) + '">' + safe(t("consent.deny")) + '</button>'; panel.appendChild(actions);
    }).catch(function () {});
  }
  function loadDetail(view,id,quiet) {
    view.selected = id; view.mobileDetail = true; root.classList.add("tf-detail-selected"); remember(view);
    if (!view.page || view.tab !== "execution") return Promise.resolve();
    var generation = ++view.detailGeneration, snapshot = view.page.snapshot;
    if (view.detailController) view.detailController.abort(); view.detailController = new AbortController();
    if (!quiet) by("detail").textContent = word("loading");
    by("list").querySelectorAll("[data-tf-step]").forEach(function (node) { node.setAttribute("aria-pressed",String(node.getAttribute("data-tf-step") === id)); });
    return get("/api/tasks/execution/step?" + new URLSearchParams({ task:view.id,snapshot:snapshot,step:id }),view.detailController.signal).then(function (detail) {
      if (active !== view || generation !== view.detailGeneration || !view.page || view.page.snapshot !== snapshot) return;
      if (quiet && JSON.stringify(view.detail) === JSON.stringify(detail)) { syncApproval(view,detail,by("detail")); return; }
      view.detail = detail; paintDetail(view,detail);
    }).catch(function (error) {
      if (error.name === "AbortError" || active !== view || generation !== view.detailGeneration) return;
      if (error.status === 403 || error.status === 404) deny(view,error);
      else { view.detail = null; if (by("detail")) by("detail").textContent = error.status === 409 ? word("expired") : word("error"); }
    });
  }
  function loadPage(view,cursor,anchor,fresh,fallback) {
    if (fresh && view.page && view.tab === "execution") { captureListReading(view); if (view.readingAnchor) anchor = view.readingAnchor.id; }
    var generation = ++view.generation, query = { task:view.id };
    Object.keys(view.filters).forEach(function (key) { if (view.filters[key]) query[key] = view.filters[key]; });
    if (!fresh && view.page) query.snapshot = view.page.snapshot;
    if (cursor) query.cursor = cursor; if (anchor) query.anchor = anchor;
    return get("/api/tasks/execution?" + new URLSearchParams(query)).then(function (page) {
      if (active !== view || view.generation !== generation) return;
      view.page = page; view.pageCursor = cursor; view.anchor = page.steps[0] && page.steps[0].id; view.dirty = false;
      if (!Object.values(view.filters).some(Boolean)) view.activity = page.activity;
      if (page.task) view.record = page.task;
      header(view); syncWorkFilter(view); if (view.tab === "execution") { paintPage(view); if (view.selected) loadDetail(view,view.selected); } else render(view);
      remember(view);
    }).catch(function (error) {
      if (active !== view || view.generation !== generation) return;
      if (error.status === 403 || error.status === 404) { deny(view,error); return; }
      if (error.status === 409 && !fallback) { view.readingAnchor = null; view.selected = ""; view.detail = null; root.classList.remove("tf-detail-selected"); view.detailGeneration++; if (view.detailController) view.detailController.abort(); view.page = null; view.listTop = 0; view.rowNodes.clear(); if (by("list")) by("list").textContent = word("loading"); if (by("detail")) by("detail").textContent = word("select"); return loadPage(view,null,null,true,true).then(function () { if (active === view && by("coverage")) by("coverage").textContent = word("expired"); }); }
      if (view.tab === "execution" && by("list")) by("list").innerHTML = '<div class="tf-empty">' + word("error") + '</div>';
    });
  }
  function loadItem(view) {
    var generation = view.itemGeneration = (view.itemGeneration || 0) + 1;
    return get("/api/tasks/item?task=" + encodeURIComponent(view.id)).then(function (data) { if (active !== view || view.itemGeneration !== generation) return; view.task = data.task; header(view); }).catch(function (error) { if (active === view && view.itemGeneration === generation) deny(view,error); });
  }
  function loadCosts(view) {
    var generation = view.costGeneration = (view.costGeneration || 0) + 1;
    return get("/api/tasks/execution/costs?task=" + encodeURIComponent(view.id)).then(function (data) {
      if (active !== view || view.costGeneration !== generation) return;
      var changed = JSON.stringify(view.cost) !== JSON.stringify(data); view.cost = data;
      if (changed && view.tab === "costs") render(view);
    }).catch(function () {
      if (active !== view || view.costGeneration !== generation) return;
      var changed = view.cost !== null; view.cost = null;
      if (changed && view.tab === "costs") render(view);
    });
  }
  function changeTab(tab) {
    if (!active) return;
    if (by("list")) captureListReading(active);
    active.tab = tab; remember(active); render(active);
    if (tab === "costs") loadCosts(active);
    if (tab === "execution" && !active.page) loadPage(active,null,active.anchor || active.selected,true);
  }
  function open(id,push) {
    ensure(); returnFocus = document.activeElement;
    var view = viewFor(id);
    if (!window.taskFocusVisible && typeof captureEventReading === "function") window.taskBackReading = { agent:current,conversation:currentConversation,reading:captureEventReading($("chat")) };
    view.generation++; view.detailGeneration++; if (view.detailController) view.detailController.abort(); view.task = null;
    active = view; window.taskFocusVisible = true; openTask = id; root.hidden = false; view.detail = null; view.page = null; view.activity = null; view.liveAction = null; view.record = null; view.role = null; view.cost = null; view.costGeneration = (view.costGeneration || 0) + 1;
    var openGeneration = view.openGeneration = (view.openGeneration || 0) + 1;
    get("/api/me").then(function (me) { if (active !== view || view.openGeneration !== openGeneration) return; view.role = me.role || "viewer"; if (view.task) header(view); if (view.task && view.tab === "artifacts") render(view); if (view.detail && view.tab === "execution") syncApproval(view,view.detail,by("detail")); }).catch(function () {});
    by("title").textContent = word("loading"); by("body").textContent = ""; by("status").textContent = ""; by("activity").textContent = ""; by("needs").textContent = "";
    var url = new URL(location.href); url.searchParams.set("task",id); if (push !== false && url.href !== location.href) history.pushState({},"",url);
    var wantedTab = url.searchParams.get("tasktab"), wantedStep = url.searchParams.get("step");
    if (["overview","execution","artifacts","costs"].indexOf(wantedTab) >= 0) view.tab = wantedTab;
    if (wantedStep) { if (wantedStep !== view.selected) { view.anchor = wantedStep; view.readingAnchor = null; view.listTop = 0; } view.selected = wantedStep; }
    return loadItem(view).then(function () { if (active !== view || !view.task || view.openGeneration !== openGeneration) return; render(view); by("tab-" + view.tab).focus(); if (view.tab === "costs") loadCosts(view); return loadPage(view,null,view.readingAnchor && view.readingAnchor.id || view.anchor || view.selected,true); });
  }
  function close(update) {
    if (!root) return;
    if (active) { if (by("list")) captureListReading(active); remember(active); active.detail = null; active.cost = null; active.costGeneration = (active.costGeneration || 0) + 1; if (active.detailController) active.detailController.abort(); }
    active = null; window.taskFocusVisible = false; openTask = ""; root.hidden = true; by("body").textContent = "";
    if (window.taskConversationDirty && current) {
      window.taskConversationDirty = false; var reading = window.taskBackReading, agent = current, conversation = currentConversation;
      select(agent,conversation).then(function () { if (reading && reading.agent === current && reading.conversation === currentConversation && typeof restoreEventReading === "function") restoreEventReading($("chat"),reading.reading); }).catch(function () {});
      $("feed").textContent = ""; loadActivity();
    }
    if (update) { var url = new URL(location.href); ["task","tasktab","step"].forEach(function (key) { url.searchParams.delete(key); }); history.pushState({},"",url); }
    refreshTasks();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  function click(event) {
    if (!active) return;
    var node = event.target.closest("button"); if (!node) return;
    if (node.hasAttribute("data-tf-list")) { active.mobileDetail = false; root.classList.remove("tf-detail-selected"); paintPage(active); return; }
    if (node.hasAttribute("data-tf-close")) { close(true); return; }
    if (node.hasAttribute("data-tf-conversation")) { var task = active.task; close(true); if (task && task.assigneeId) { select(task.assigneeId,task.conversation || "main"); showTab("desktop"); } return; }
    var tab = node.getAttribute("data-tf-tab"), step = node.getAttribute("data-tf-step");
    if (tab) { changeTab(tab); return; } if (step) { loadDetail(active,step); return; }
    if (node.hasAttribute("data-tf-refresh")) { var view = active; window.refreshTaskExecution().then(function () { if (active === view && view.task) render(view); }); }
    if (active.page && (node.hasAttribute("data-tf-next") || node.hasAttribute("data-tf-prev"))) { active.listTop = 0; active.readingAnchor = null; active.selected = ""; root.classList.remove("tf-detail-selected"); active.detail = null; if (by("detail")) by("detail").textContent = word("select"); loadPage(active,node.hasAttribute("data-tf-next") ? active.page.nextCursor : active.page.previousCursor,null,false); }
  }
  window.openTaskFocus = open;
  window.addEventListener("DOMContentLoaded",function () { if (active && active.task && active.tab !== "execution") render(active); });
  window.refreshTaskExecution = function () { if (!active) return Promise.resolve(); var view = active; return loadItem(view).then(function () { if (active === view && view.task && view.tab === "costs") loadCosts(view); if (active === view && view.task) return loadPage(view,null,view.readingAnchor && view.readingAnchor.id || view.anchor || view.selected,true); }); };
  function queueHeader(view) {
    if (view.headerQueued) return; view.headerQueued = true;
    requestAnimationFrame(function () { view.headerQueued = false; if (active === view) header(view); });
  }
  window.taskFocusEvent = function (event) {
    if (active && event.type === "approval_settled" && active.task && (active.task.needsApprovals || []).some(function (item) { return item.id === event.id; })) {
      var settledView = active; loadItem(settledView); if (settledView.detail) syncApproval(settledView,settledView.detail,by("detail")); return;
    }
    if (event.type === "task_changed" && window.noteTaskBoardChange) window.noteTaskBoardChange(event);
    if (!active || event.taskId !== active.id) return;
    if (event.type === "task_changed" && !active.itemQueued) {
      var view = active; view.itemQueued = true;
      setTimeout(function () { view.itemQueued = false; if (active === view) loadItem(view); },250);
    }
    if (event.type === "task_execution") { active.dirty = true; queueHeader(active); }
    if (event.type === "tool_start" || event.type === "tool_end") { active.liveAction = { name:event.tool,detail:toolDetail(event.tool,event.input || {}),startedAt:new Date().toISOString() }; queueHeader(active); }
  };
  window.addEventListener("lumen-connection",function () { if (active) header(active); });
  window.addEventListener("popstate",function () { var id = new URL(location.href).searchParams.get("task"); if (id) open(id,false); else close(false); });
  setInterval(function () {
    if (!active || document.visibilityState === "hidden") return;
    var view = active; loadItem(view).then(function () { if (active !== view || !view.task || !view.page) return; if (view.tab === "costs") loadCosts(view); return get("/api/tasks/execution?" + new URLSearchParams({ task:view.id,snapshot:view.page.snapshot,anchor:view.anchor || "" })).then(function (page) {
      if (active !== view) return;
      if (!page.steps.length && view.page.steps.length) { view.page = page; view.selected = ""; view.detail = null; if (view.tab === "execution") render(view); }
      else if (view.selected && view.tab === "execution") loadDetail(view,view.selected,true);
    }).catch(function (error) { if (error.status === 409) return window.refreshTaskExecution(); if (error.status === 403 || error.status === 404) deny(view,error); }); });
  },8000);
})();`;
