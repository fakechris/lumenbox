/**
 * The rest of the computers pane on the rebuilt page (INV-1825), for an organisation's admin: how
 * many personal computers each person and department may hold, the machines enrolled as nodes, and
 * what the host process itself is using. Each is shown only where the installation has it.
 */
export const NEXT_SET_BOXES_MORE_JS = `
var boxMore = { quotas: null, directories: null, nodes: null, resources: null, snapshot: "" };

function loadBoxMore() {
  var also = function (path, keep) { getJson(path).then(function (got) { keep(got); if (next.view === "settings") render(); }, function () {}); };
  also("/api/quotas", function (got) { boxMore.quotas = got; });
  also("/api/directories", function (got) { boxMore.directories = got.directories || []; });
  also("/api/nodes", function (got) { boxMore.nodes = got.nodes || []; });
}

/** A quota typed into a field: empty inherits (null), otherwise a whole number from 0 to 99; anything else is not sent. */
function quotaValue(text) {
  var trimmed = String(text || "").trim();
  if (trimmed === "") return { ok: true, value: null };
  var number = Number(trimmed);
  return Number.isInteger(number) && number >= 0 && number <= 99 ? { ok: true, value: number } : { ok: false };
}

function quotaBlock() {
  var quotas = boxMore.quotas;
  if (!quotas) return null;
  var box = el("section", "setting"), everyone = el("input"), inputs = [], save = el("button", "act-primary", t("ui.next.settings.save"));
  var numberInput = function (value) { var input = el("input"); input.inputMode = "numeric"; input.value = value === null || value === undefined ? "" : String(value); return input; };
  box.appendChild(el("h2", "group", t("ui.next.boxset.quotas")));
  box.appendChild(el("p", "why", t("ui.next.boxset.quotasNote")));
  everyone = numberInput(quotas.personalBoxQuota);
  box.appendChild(labelled(t("ui.next.boxset.quotaAll"), everyone));
  (boxMore.directories || []).forEach(function (directory) {
    var line = el("div", "fact"), sync = el("button", "act", t("ui.next.boxset.sync"));
    line.appendChild(el("span", "", directory.channelId + " · " + directory.status + " · " + t("ui.next.boxset.directory", { people: directory.people || 0, departments: directory.departments || 0 })));
    sync.addEventListener("click", function () { sync.disabled = true; postJson("/api/directories/sync", { channelId: directory.channelId }).then(loadBoxMore, function (error) { sync.disabled = false; failed(error); }); });
    line.appendChild(sync); box.appendChild(line);
  });
  [["department", quotas.departments || [], "key"], ["person", quotas.people || [], "id"]].forEach(function (group) {
    if (!group[1].length) return;
    var fold = el("details", "fold"), body = el("div", "fold-body");
    fold.appendChild(el("summary", "", t("ui.next.boxset.quota." + group[0]) + " · " + group[1].length));
    group[1].forEach(function (row) {
      var input = numberInput(row.override);
      inputs.push({ kind: group[0], id: row[group[2]], input: input });
      body.appendChild(labelled(row.name + (group[0] === "person" ? " · " + t("ui.next.boxset.held", { n: row.held || 0 }) : ""), input));
    });
    fold.appendChild(body); box.appendChild(fold);
  });
  save.addEventListener("click", function () {
    var all = quotaValue(everyone.value), bad = all.ok ? null : everyone, body = { personalBoxQuota: all.value, personBoxQuotas: {}, departmentBoxQuotas: {} };
    inputs.forEach(function (row) {
      var read = quotaValue(row.input.value);
      if (!read.ok) { bad = bad || row.input; return; }
      body[row.kind === "person" ? "personBoxQuotas" : "departmentBoxQuotas"][row.id] = read.value;
    });
    if (bad) { bad.focus(); toast(t("ui.next.boxset.quotaRange")); return; }
    postJson("/api/quotas", body).then(function (got) { boxMore.quotas = got; toast(t("ui.next.settings.saved2")); render(); }, failed);
  });
  box.appendChild(save);
  return box;
}

/** Machines enrolled to carry computers for the organisation; revoking one takes its computers away with it, so it is asked for twice. */
function nodesBlock() {
  var nodes = boxMore.nodes;
  if (!nodes || !nodes.length) return null;
  var box = el("section", "setting");
  box.appendChild(el("h2", "group", t("ui.next.boxset.nodes")));
  nodes.forEach(function (node) {
    var line = el("div", "fact"), text = el("span", ""), boxes2 = (node.boxes || []).map(function (row) { return row.name + " (" + row.state + ")"; }).join(", ");
    text.appendChild(el("b", "", node.name));
    text.appendChild(el("div", "why", [node.revoked ? t("ui.next.boxset.revoked") : "", node.version || "", node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : "", boxes2].filter(Boolean).join(" · ")));
    line.appendChild(text);
    if (!node.revoked) {
      var revoke = el("button", "act", t("ui.next.mine.revoke"));
      revoke.addEventListener("click", function () {
        var sure = el("button", "act-danger", t("ui.next.boxset.revokeSure", { n: (node.boxes || []).length }));
        sure.addEventListener("click", function () { postJson("/api/nodes/revoke", { node: node.id }).then(function () { loadBoxMore(); refreshSoon(); }, failed); });
        revoke.replaceWith(sure);
      });
      line.appendChild(revoke);
    }
    box.appendChild(line);
  });
  return box;
}

function megabytes(bytes2) { return typeof bytes2 === "number" ? Math.round(bytes2 / 1048576) + " MB" : "—"; }

/** What the host process is using, read when asked for; a heap snapshot is large and is asked for twice. */
function diagnosticsBlock() {
  if (!(settings.me && settings.me.role === "admin")) return null;
  var box = el("section", "setting"), fold = el("details", "fold"), body = el("div", "fold-body");
  fold.appendChild(el("summary", "", t("ui.next.boxset.diagnostics"))); fold.appendChild(body); box.appendChild(fold);
  fold.open = boxMore.resources !== null;
  fold.addEventListener("toggle", function () {
    if (!fold.open || boxMore.resources !== null) return;
    getJson("/api/diagnostics/resources").then(function (got) { boxMore.resources = got; render(); }, function (error) { boxMore.resources = { error: error.message }; render(); });
  });
  var data = boxMore.resources;
  if (!data) return box;
  if (data.error) { body.appendChild(el("p", "why", data.error)); return box; }
  var process2 = data.process || {}, loop = data.eventLoop || {}, memory = data.box || {};
  body.appendChild(fact(t("ui.next.boxset.diag.memory"), megabytes(process2.rss) + " · " + megabytes(process2.heapUsed) + " / " + megabytes(process2.heapTotal)));
  body.appendChild(fact(t("ui.next.boxset.diag.uptime"), duration((process2.uptimeSeconds || 0) * 1000)));
  body.appendChild(fact(t("ui.next.boxset.diag.loop"), t("ui.next.boxset.diag.loopValue", { p50: Math.round(loop.p50Ms || 0), p99: Math.round(loop.p99Ms || 0), max: Math.round(loop.maxMs || 0) })));
  body.appendChild(fact(t("ui.next.boxset.diag.readers"), String(data.eventSubscribers || 0)));
  if (memory.memoryCurrent !== undefined) body.appendChild(fact(t("ui.next.boxset.diag.box"), megabytes(memory.memoryCurrent) + " / " + (memory.memoryMax === "max" ? "∞" : megabytes(memory.memoryMax))));
  (data.agents || []).filter(function (row) { return row.activeTurns || row.queued || row.watchedJobs; }).forEach(function (row) {
    body.appendChild(fact(row.name, t("ui.next.boxset.diag.agent", { turns: row.activeTurns || 0, queued: row.queued || 0, jobs: row.watchedJobs || 0 })));
  });
  var again = el("button", "act", t("ui.next.boxset.diag.again")), heap = el("button", "act", t("ui.next.boxset.diag.heap")), acts = el("div", "acts");
  again.addEventListener("click", function () { boxMore.resources = null; getJson("/api/diagnostics/resources").then(function (got) { boxMore.resources = got; render(); }, failed); });
  heap.addEventListener("click", function () {
    var sure = el("button", "act-danger", t("ui.next.boxset.diag.heapSure"));
    sure.addEventListener("click", function () { sure.disabled = true; postJson("/api/diagnostics/heap-snapshot", {}).then(function (got) { boxMore.snapshot = got.path + " · " + megabytes(got.bytes); render(); }, failed); });
    heap.replaceWith(sure);
  });
  acts.appendChild(again); acts.appendChild(heap); body.appendChild(acts);
  if (boxMore.snapshot) body.appendChild(el("p", "why", boxMore.snapshot));
  return box;
}
`;
