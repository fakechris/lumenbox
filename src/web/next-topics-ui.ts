/**
 * An agent's topics in other chats, inside its one conversation (INV-1896).
 *
 * Bob works almost only in Feishu topics. On 2026-11-15 they were cards at the foot of his main conversation, each a
 * "From Feishu" label over a line of raw markdown; a click swapped the whole page for that topic, and the way back was
 * a drop-down at the top. With several agents and several chats per agent the person no longer knew where they were.
 *
 * So an agent has one conversation. A topic sits in it at the time of its last answer, as the question that opened it
 * (marked with the chat it came through) and the agent's last answer as written; it opens in place, and the page never
 * leaves the agent. What is typed below always goes to the agent here.
 */
export const NEXT_TOPICS_JS = `
/** The chat a message came through, as its mark: a small icon, named in words for whoever cannot see it. */
var DOOR_MARKS = {
  feishu: { color: "#3370ff", path: "M5 7.5 12 4l7 3.5v6.2L12 20l-7-6.3Z M8.5 9.3l3.5 2 3.5-2" },
  dingtalk: { color: "#1677ff", path: "M7 5h7.5a3.5 3.5 0 0 1 0 7H10l3 7H9.6L7 12.5Z" },
  telegram: { color: "#2aabee", path: "M4.5 11.6 19 5.5l-2.6 13-4.6-3.6-2.4 2.3.3-3.6 6-5.6-7.6 4.7Z" }
};
function doorMark(door) {
  var mark = DOOR_MARKS[door], node = el("span", "door");
  if (!mark) return null;
  node.title = t("ui.next.door." + door); node.setAttribute("role", "img"); node.setAttribute("aria-label", node.title);
  node.style.background = mark.color;
  node.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="' + mark.path + '" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  return node;
}
function doorOf(conversation) { var door = /^(feishu|dingtalk|telegram)/.exec(conversation || ""); return door ? door[1] : ""; }

/** The topic state is one agent's: whichever way another agent was chosen, what was open for the last one is forgotten. */
function topicsOf(agentId) {
  if (chat.topicsFor === agentId) return;
  chat.topicsFor = agentId; chat.topics = {}; chat.topicLive = {}; chat.topicSeen = {}; chat.topicExtra = []; chat.focusAsked = "";
  chat.conversations = []; chat.conversationsTotal = 0; chat.olderPending = false;
}

/**
 * The agent's conversations, thirty at a time with each one's last answer. The first page is the newest: read again, it
 * refreshes those rows and keeps the older ones the person asked for. A later page adds to the list, once.
 */
function loadConversations(id, offset) {
  if (offset) { if (chat.olderPending) return; chat.olderPending = true; }
  getJson("/api/conversations?agent=" + encodeURIComponent(id) + "&replies=1&limit=30&offset=" + offset).then(function (got) {
    if (offset) chat.olderPending = false;
    if (chat.agentId !== id) return;
    topicsOf(id);
    var fresh = got.conversations || [], have = {};
    (offset ? chat.conversations : fresh).forEach(function (row) { have[row.id] = true; });
    chat.conversations = offset ? chat.conversations.concat(fresh.filter(function (row) { return !have[row.id]; }))
      : fresh.concat(chat.conversations.filter(function (row) { return !have[row.id]; })); // a new topic moves the page down: keep by id, not by place
    chat.conversationsTotal = got.total || chat.conversations.length;
    topicsSeen(id);
    if (next.view === "chat") render();
  }, function () { if (offset) chat.olderPending = false; });
}

/** Everything said with the agent, here and in its topics, in time order: what search looks through and export writes. */
function conversationEntries() {
  var blocks = chat.conversations.concat(chat.topicExtra).filter(function (row) { return row.id !== chat.conversation; }).map(function (row) {
    var door = doorOf(row.id), state = chat.topics[row.id];
    var said = state && state.entries ? state.entries.map(function (entry) { return marked(entry, door); }) : [{ kind: "text", role: "user", text: row.firstLine || "", source: door || undefined }]
      .concat(row.lastReply ? [{ kind: "text", role: "assistant", text: row.lastReply.text }] : []);
    return { at: topicTime(row), entries: said };
  }).sort(function (x, y) { return x.at.localeCompare(y.at); });
  var out = [];
  chat.entries.forEach(function (entry) {
    var at = entry.at || entry.to || entry.from;
    while (at && blocks.length && blocks[0].at < String(at)) out = out.concat(blocks.shift().entries);
    out.push(entry);
  });
  blocks.forEach(function (block) { out = out.concat(block.entries); });
  return out;
}

/** Said in the chat, so marked with it: the record of a topic carries the chat in its name, not on each line. */
function marked(entry, door) { return entry.kind === "text" && entry.role === "user" && !entry.source && door ? Object.assign({}, entry, { source: door }) : entry; }

/** A topic whose last answer is on screen has been read there: its count is cleared as the main conversation's is. */
function topicsSeen(id) {
  var agent = next.agents[id];
  if (!agent || !chatVisible()) return;
  ((agent.facts && agent.facts.unreadIn) || []).forEach(function (entry) {
    var row = chat.conversations.filter(function (candidate) { return candidate.id === entry.conversation; })[0];
    if (!row || row.id === chat.conversation || chat.topicSeen[row.id] === topicTime(row)) return;
    chat.topicSeen[row.id] = topicTime(row);
    postJson("/api/agents/viewed", { id: id, conversation: row.id }).then(refreshSoon, function () {});
  });
}

function topicTime(row) { return String((row.lastReply && row.lastReply.at) || row.lastAt || ""); }

/**
 * The topics set among what was said here by time: \`before(entry)\` gives those older than it, \`rest()\` the newer ones.
 * A result asked for in a topic stands under that topic; one from a topic not loaded stands at the time it was reported.
 * Results asked for here are not this function's: they stand at the foot of the conversation, as they always have.
 */
function topicsBetween(delivered) {
  var agent = next.agents[chat.agentId], results = {}, unread = {}, seen = {};
  delivered.forEach(function (row) { var where = row.conversation || "main"; (results[where] = results[where] || []).push(row); });
  ((agent && agent.facts && agent.facts.unreadIn) || []).forEach(function (entry) { unread[entry.conversation] = entry.count; });
  var queue = chat.conversations.concat(chat.topicExtra).filter(function (row) {
    if (row.id === chat.conversation || seen[row.id]) return false;
    seen[row.id] = true; return true;
  }).map(function (row) { return { at: topicTime(row), draw: function () { return topicNode(row, results[row.id] || [], unread[row.id]); } }; });
  Object.keys(results).filter(function (where) { return where !== chat.conversation && !seen[where]; }).forEach(function (where) {
    results[where].forEach(function (row) { queue.push({ at: String((row.report && row.report.at) || row.createdAt || ""), draw: function () { return resultCard(row); } }); });
  });
  queue.sort(function (x, y) { return x.at.localeCompare(y.at); });
  function take(until) {
    var out = [];
    while (queue.length && (until === undefined || queue[0].at < until)) out.push(queue.shift().draw());
    return out;
  }
  return { before: function (entry) { var at = entry.at || entry.to || entry.from; return at ? take(String(at)) : []; }, rest: function () { return take(); } };
}

/** One topic: closed, the question and the last answer; open, everything said there, drawn as this conversation is. */
function topicNode(row, results, unread) {
  var id = row.id, door = doorOf(id), state = chat.topics[id], node = el("div", "topic"), foot = el("div", "why");
  node.dataset.topic = id; foot.classList.add("topic-foot");
  if (state && state.entries) {
    var body = el("div", "topic-body");
    drawEntries(body, state.entries.map(function (entry) { return marked(entry, door); }), null, id);
    node.appendChild(body);
  } else {
    var asked = el("div", "msg-me"), mark = doorMark(door);
    if (mark) asked.appendChild(mark);
    asked.appendChild(document.createTextNode(row.firstLine || t("ui.next.chat.another")));
    node.appendChild(asked);
    if (row.lastReply) node.appendChild(rich(row.lastReply.text + (row.lastReply.cut ? " …" : ""), "msg"));
  }
  var marks = [], agent = next.agents[chat.agentId];
  if (chat.topicLive[id]) marks.push(t("ui.next.chat.working", { name: agent ? agent.name : "" }));
  if (results.length) marks.push(t("ui.next.chat.waitsHere", { n: results.length }));
  if (unread) marks.push(t("ui.next.chat.unreadHere", { n: unread }));
  if (topicTime(row)) marks.push(agoText(topicTime(row)));
  foot.textContent = marks.join(" · ");
  var toggle = el("button", "elsewhere", t(state && state.entries ? "ui.next.chat.topicClose" : state ? "ui.next.chat.topicOpening" : "ui.next.chat.topicOpen"));
  toggle.addEventListener("click", function () { if (chat.topics[id]) { delete chat.topics[id]; render(); } else openTopic(id); });
  foot.appendChild(toggle);
  node.appendChild(foot);
  results.forEach(function (result) { node.appendChild(resultCard(result)); });
  return node;
}

/**
 * Read a topic, or read an open one again (what is shown stays until the new read lands). Only the newest read is kept.
 * Quiet while the page is being drawn: the answer's arrival draws it again. A longer \`tail\` reads further back.
 */
function openTopic(id, quiet, tail) {
  var agentId = chat.agentId, was = chat.topics[id] || {}, request = ++chat.topicAsked;
  chat.topics[id] = { entries: was.entries, loading: true, request: request, tail: tail || was.tail || 0 };
  if (!quiet) render();
  var url = "/api/transcript?sent=1&requests=1" + (chat.topics[id].tail ? "&tail=" + chat.topics[id].tail : "");
  getJson(url + "&agent=" + encodeURIComponent(agentId) + "&conversation=" + encodeURIComponent(id)).then(function (entries) {
    var state = chat.topics[id];
    if (chat.agentId !== agentId || !state || state.request !== request) return;
    chat.topics[id] = { entries: entries, request: request, tail: state.tail };
    postJson("/api/agents/viewed", { id: agentId, conversation: id }).then(refreshSoon, function () {});
    render();
  }, function (error) {
    var state = chat.topics[id];
    if (chat.agentId !== agentId || !state || state.request !== request) return;
    // Not opened: the person may open it again; a topic asked for by a link is not asked for again on its own.
    if (state.entries) chat.topics[id] = { entries: state.entries, request: request, tail: state.tail }; else delete chat.topics[id];
    if (chat.focus === id) chat.focus = "";
    failed(error); render();
  });
}

/** Older topics than the thirty newest, asked for. */
function olderTopicsButton() {
  if (!(chat.conversationsTotal > chat.conversations.length)) return null;
  var more = el("button", "elsewhere", t("ui.next.chat.older", { n: chat.conversationsTotal - chat.conversations.length }));
  more.disabled = chat.olderPending;
  more.addEventListener("click", function () { loadConversations(chat.agentId, chat.conversations.length); });
  return more;
}

/** A topic asked for by name (a link, the work panel): opened where it sits and brought into view. True while it is being brought. */
function focusTopic(view) {
  var id = chat.focus;
  if (!id) return false;
  var node = Array.prototype.filter.call(view.querySelectorAll("[data-topic]"), function (candidate) { return candidate.dataset.topic === id; })[0];
  if (!node) {
    // Older than the topics loaded: read that one by name, once; an answer for another agent or another ask is not this one's.
    if (chat.focusAsked !== id) {
      var agentId = chat.agentId;
      chat.focusAsked = id;
      getJson("/api/conversations?agent=" + encodeURIComponent(agentId) + "&replies=1&ids=" + encodeURIComponent(id)).then(function (got) {
        if (chat.agentId !== agentId || chat.focusAsked !== id) return;
        chat.topicExtra = chat.topicExtra.concat(got.conversations || []);
        if (!(got.conversations || []).length) chat.focus = ""; // gone, or never this agent's: the conversation as it is
        render();
      }, function () { if (chat.agentId === agentId && chat.focusAsked === id) { chat.focus = ""; render(); } });
    }
    return false;
  }
  if (!chat.topics[id]) openTopic(id, true);
  else if (chat.topics[id].entries) { chat.focus = ""; chat.focusAsked = ""; }
  node.scrollIntoView({ block: "start" });
  return true;
}

/** Another of the agent's conversations, asked for from elsewhere on the page: the agent's conversation, with that topic open. */
function showConversation(agentId, conversation) {
  if (agentId !== chat.agentId) openChat(agentId);
  next.view = "chat"; closePanel();
  if (conversation && conversation !== chat.conversation) chat.focus = conversation; else chat.jump = true;
  render();
}

/** What happens in a topic while the page is open: a line that it is being answered, and the answer when it is done. */
function topicEvent(event) {
  var id = event.conversation;
  if (!id) return;
  if (event.type === "turn_started") { chat.topicLive[id] = true; render(); return; }
  if (event.type !== "prompt" && event.type !== "turn_finished" && event.type !== "turn_failed" && event.type !== "turn_interrupted") return;
  if (event.type !== "prompt") delete chat.topicLive[id];
  loadConversations(chat.agentId, 0);
  if (chat.topics[id]) openTopic(id, true); // open or still opening: read again, and the read under way gives way to this one
}
`;
