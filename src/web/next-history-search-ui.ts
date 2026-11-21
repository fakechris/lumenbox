/**
 * Searching what was said, on the system page beside the audit record (INV-1751): every conversation
 * of every agent the person may read, through `GET /api/history/search` — the same index and query
 * the agents' `SearchHistory` uses, so the page and an agent find the same things. A hit says who
 * said it, where and when, and opens that agent's conversation at the topic it is in.
 */
export const NEXT_HISTORY_SEARCH_JS = `
var historySearch = { q: "", agent: "", since: "", hosted: false, hits: null, more: false, incomplete: null, error: "", busy: false, asked: 0 };

/** Words, or /a regular expression/ between slashes. */
function runHistorySearch() {
  var state = historySearch, q = state.q.trim(), request = ++state.asked;
  if (!q) return;
  var regex = q.length > 2 && q.charAt(0) === "/" && q.charAt(q.length - 1) === "/";
  var query = (regex ? "regex=" + encodeURIComponent(q.slice(1, -1)) : "q=" + encodeURIComponent(q)) +
    (state.agent ? "&agent=" + encodeURIComponent(state.agent) : "") + (state.since ? "&since=" + state.since : "") +
    (state.hosted ? "&kinds=message,call,result,notice,summary,reminder" : "");
  state.busy = true; state.error = ""; render();
  getJson("/api/history/search?" + query).then(function (got) {
    if (request !== state.asked) return;
    state.hits = got.hits || []; state.more = !!got.more; state.incomplete = got.incomplete || null;
  }, function (error) { if (request === state.asked) { state.hits = null; state.error = error.message; } })
    .then(function () { if (request === state.asked) { state.busy = false; render(); } });
}

/** One hit: where and whose on one line, with the way to the conversation; what was said under it. */
function historyHitRow(hit) {
  var row = el("div"), head = el("div", "acts"), where = el("span", "why");
  row.style.padding = "8px 0"; row.style.borderTop = "1px solid var(--border)";
  var said = [clock(hit.at) ? new Date(hit.at).toLocaleDateString() + " " + clock(hit.at) : "", hit.agent, hit.conversation === "main" ? t("ui.next.search.main") : hit.conversation];
  where.textContent = said.filter(Boolean).join(" · ") + " · " + t("ui.next.search.role." + hit.role) + (hit.kind === "call" || hit.kind === "result" ? " (" + t("ui.next.search.kind." + hit.kind) + ")" : "");
  where.style.flex = "1"; where.style.whiteSpace = "normal"; where.title = hit.anchor;
  var open = el("button", "act", t("ui.next.search.open"));
  open.addEventListener("click", function () { openChat(hit.agentId); if (hit.conversation !== "main") { chat.focus = hit.conversation; render(); } });
  head.style.alignItems = "center"; head.appendChild(where); head.appendChild(open);
  var text = el("div", "", hit.snippet); text.style.overflowWrap = "anywhere"; text.style.marginTop = "4px";
  row.appendChild(head); row.appendChild(text);
  return row;
}

function historySearchFold() {
  return systemFold(t("ui.next.search.title"), "search", function (body) {
    var state = historySearch, form = el("form", "fields");
    var words = el("input"); words.type = "search"; words.value = state.q; words.placeholder = t("ui.next.search.placeholder"); words.setAttribute("aria-label", t("ui.next.search.title"));
    words.style.width = "240px";
    words.addEventListener("input", function () { state.q = words.value; });
    var who = el("select"); who.setAttribute("aria-label", t("ui.next.search.agent"));
    [{ id: "", name: t("ui.next.search.everyone") }].concat(Object.keys(next.agents).map(function (id) { return { id: id, name: next.agents[id].name }; })).forEach(function (agent) {
      var option = el("option", "", agent.name); option.value = agent.id; option.selected = agent.id === state.agent; who.appendChild(option);
    });
    who.addEventListener("change", function () { state.agent = who.value; });
    var when = el("select"); when.setAttribute("aria-label", t("ui.next.search.since"));
    [["", "anytime"], ["1d", "day"], ["7d", "week"], ["30d", "month"]].forEach(function (pair) {
      var option = el("option", "", t("ui.next.search." + pair[1])); option.value = pair[0]; option.selected = pair[0] === state.since; when.appendChild(option);
    });
    when.addEventListener("change", function () { state.since = when.value; });
    var hosted = el("label", "why"), box = el("input"); box.type = "checkbox"; box.checked = state.hosted; box.style.width = "auto";
    box.addEventListener("change", function () { state.hosted = box.checked; });
    hosted.style.flexDirection = "row"; hosted.style.alignItems = "center"; hosted.style.width = "auto";
    hosted.appendChild(box); hosted.appendChild(document.createTextNode(" " + t("ui.next.search.hosted")));
    var go = el("button", "act", t(state.busy ? "ui.next.search.searching" : "ui.next.search.go")); go.type = "submit"; go.disabled = state.busy;
    form.addEventListener("submit", function (event) { event.preventDefault(); runHistorySearch(); });
    [words, who, when, go, hosted].forEach(function (node) { form.appendChild(node); });
    body.appendChild(form);
    if (state.error) { body.appendChild(el("p", "why", state.error)); return; }
    if (state.hits === null) { body.appendChild(el("p", "why", t("ui.next.search.hint"))); return; }
    if (state.incomplete && state.incomplete.behind) body.appendChild(el("div", "needbox", t("ui.next.search.behind", { n: state.incomplete.behind })));
    if (state.incomplete && state.incomplete.reached) body.appendChild(el("div", "needbox", t("ui.next.search.reached", { at: new Date(state.incomplete.reached).toLocaleString() })));
    if (!state.hits.length) body.appendChild(el("p", "why", t("ui.next.search.none")));
    else body.appendChild(el("p", "why", t(state.more ? "ui.next.search.countMore" : "ui.next.search.count", { n: state.hits.length })));
    state.hits.forEach(function (hit) { body.appendChild(historyHitRow(hit)); });
  });
}
`;
