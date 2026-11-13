/**
 * A finished piece of work, as the person meets it on the rebuilt page (INV-1825).
 *
 * On 2026-11-12 four cards said "Bob delivered a result" at the foot of Bob's main conversation, each
 * with a title, Accept, Request changes and Open, and nothing else. The work had been asked for in
 * Feishu chats, produced by another agent and checked by Bob; what was reported sat in the record
 * where the card did not look. The person was asked to accept something they could not see, from a
 * request they could not place, with three buttons two of which did the same thing.
 *
 * So a card says where the work came from and what was reported, belongs to the conversation the
 * work was asked in, and its three buttons do three things. A result waiting in another conversation,
 * and a message not yet read in one, are each a line that goes there.
 */
export const NEXT_RESULT_JS = `
/** Markdown as the agent wrote it; raw HTML is off in the renderer, so what is said cannot become markup. */
function rich(text, name) {
  var node = el("div", name);
  if (markdown) node.innerHTML = markdown.render(String(text || "")); else node.textContent = String(text || "");
  node.querySelectorAll("a").forEach(function (link) { link.target = "_blank"; link.rel = "noopener noreferrer"; });
  return node;
}

/** Where a piece of work came from, in a line: who asked, through which door, when. */
function originOf(row) {
  var who = String(row.requester || ""), door = who.split(":")[0].split("-")[0];
  var from = next.agents[who] ? t("ui.next.origin.agent", { name: agentName(who) }) : MSG["ui.next.origin." + door] ? t("ui.next.origin." + door) : t("ui.next.origin.other");
  return from + (row.createdAt ? " · " + agoText(row.createdAt) : "");
}

/** The name on a conversation: what was first said in it, where the list has it. */
function conversationLabel(id) {
  if (!id || id === "main") return t("ui.next.chat.main");
  var row = chat.conversations.filter(function (entry) { return entry.id === id; })[0];
  return row && row.firstLine ? clip(row.firstLine, 40) : t("ui.next.chat.another");
}

/** Whether a chat has more than one conversation here: only then is it worth a heading of its own. */
function chatHasTopics(rows, chatKey) { return rows.filter(function (row) { return row.chat === chatKey; }).length > 1; }
/** A chat's name on the page: the door it is behind and how the chat itself began, or the end of its id where that is not loaded. */
function chatLabel(rows, chatKey) {
  var door = chatKey.split(":")[0].split("-")[0], root = rows.filter(function (row) { return row.chat === chatKey && !row.topic; })[0];
  var name = MSG["ui.next.door." + door] ? t("ui.next.door." + door) : door;
  return name + " · " + (root && root.firstLine ? clip(root.firstLine, 24) : chatKey.slice(-6)) + " (" + rows.filter(function (row) { return row.chat === chatKey; }).length + ")";
}

/** Another conversation of the agent being talked to, without leaving the page. */
function showConversation(agentId, conversation) {
  if (agentId !== chat.agentId) openChat(agentId);
  chat.conversation = conversation || "main"; chat.loadedFor = ""; chat.entries = []; chat.live = null; chat.plan = null; chat.liveSurfaces = {};
  next.view = "chat"; closePanel(); render();
}

/** Something the chat was sent that is not the agent speaking: a notice in LumenBox's own voice, a card, a file. */
function sentRow(entry) {
  var what = entry.what === "card" ? t("ui.next.sent.card." + (MSG["ui.next.sent.card." + entry.card] ? entry.card : "task")) : t("ui.next.sent." + entry.what);
  var row = el("div", "sent"), label = el("div", "why", t("ui.next.sent.label", { what: what, when: agoText(entry.at) }));
  row.appendChild(label);
  if (entry.what === "text") row.appendChild(rich(entry.text, "report"));
  else if (entry.text || entry.name) row.appendChild(el("div", "", entry.name || clip(entry.text, 160)));
  return row;
}

/** Whether the newest thing in the thread is the person's own request: then what runs now is theirs to watch. */
function ownTurn() {
  for (var i = chat.entries.length - 1; i >= 0; i--) {
    var entry = chat.entries[i];
    if (entry.kind === "background") return false;
    if (entry.kind === "text" && entry.role === "user") return true;
  }
  return true; // nothing said yet: whatever starts here was started from here
}

/** Whether the plan on record was made for something the person asked: its newest SetTodos is in their request, not behind a fold of other work. */
function planIsMine() {
  for (var i = chat.entries.length - 1; i >= 0; i--) {
    var entry = chat.entries[i];
    if (entry.kind === "background") return false;
    if (entry.kind === "tools" && (entry.tools || []).some(function (tool) { return tool.name === "SetTodos"; })) return true;
  }
  return false;
}

/** Work nobody asked for in this conversation, as one line: how much there was, and the way into it. */
function backgroundRow(entry) {
  var box = el("details", "fold"), body = el("ul"), when = entry.to || entry.from;
  box.appendChild(el("summary", "", t("ui.next.chat.background", { turns: entry.turns, steps: entry.steps }) + (when ? " · " + agoText(when) : "")));
  box.appendChild(el("div", "why", t("ui.next.chat.backgroundWhy")));
  box.appendChild(body);
  box.addEventListener("toggle", function () {
    if (!box.open || box.dataset.read) return;
    box.dataset.read = "1";
    getJson("/api/transcript?agent=" + encodeURIComponent(chat.agentId) + "&conversation=" + encodeURIComponent(chat.conversation) + "&span=" + entry.first + "-" + entry.last).then(function (got) {
      if (got.more) body.appendChild(el("li", "why", t("ui.next.chat.backgroundMore", { n: got.more })));
      (got.entries || []).forEach(function (row) {
        var line = el("li");
        if (row.kind === "tools") line.appendChild(el("span", "why", (row.tools || []).map(function (tool) { return tool.name; }).join(" · ")));
        else if (row.kind === "peer") (row.messages || []).forEach(function (message) { line.appendChild(el("b", "", message.from)); line.appendChild(el("span", "", " " + clip(message.text, 200))); });
        else if (row.kind === "trigger") line.appendChild(el("span", "why", clip(row.text, 200)));
        else if (row.text) line.appendChild(el("span", "", clip(row.text, 300)));
        if (line.childNodes.length) body.appendChild(line);
      });
    }, failed);
  });
  return box;
}

/** How a turn ended when the agent did not end it: stopped by the person, or out of its allowance. The host's own words are behind the line. */
function statusRow(entry) {
  var box = el("details", "fold");
  box.appendChild(el("summary", "", t("ui.next.chat.ended." + entry.what)));
  box.appendChild(rich(entry.text, "report"));
  return box;
}

/** What is older than what is drawn: asked for, it is read. */
function earlierRow(entry) {
  var more = el("button", "elsewhere", t("ui.next.chat.earlier", { n: entry.skipped }));
  more.addEventListener("click", function () { chat.tail = (chat.tail || 400) * 4; chat.loadedFor = ""; loadThread(); });
  return more;
}

/** Everything the person asked in this conversation, newest first: the way back to a request among everything else. */
function askedList() {
  var asked = chat.entries.map(function (entry, index) { return { entry: entry, index: index }; }).filter(function (row) { return row.entry.kind === "text" && row.entry.role === "user"; });
  if (asked.length < 3) return null;
  var box = el("details", "fold"), list = el("ul");
  box.appendChild(el("summary", "", t("ui.next.chat.yours", { n: asked.length })));
  asked.reverse().forEach(function (row) {
    var line = el("li"), go = el("button", "elsewhere", clip(row.entry.text, 80));
    go.addEventListener("click", function () { var node = document.querySelector("[data-entry='" + row.index + "']"); if (node) node.scrollIntoView({ block: "center" }); });
    if (row.entry.at) line.appendChild(el("span", "why", agoText(row.entry.at) + " "));
    line.appendChild(go); list.appendChild(line);
  });
  box.appendChild(list);
  return box;
}

/** A row of work belongs to the conversation it was asked in; one with none recorded is the main one's. */
function inThisConversation(row) { return (row.conversation || "main") === chat.conversation; }

/** What waits in the agent's other conversations: results to look at, and messages not read. Each line goes there. */
function elsewhereNotes(agent, waiting) {
  var notes = [], seen = {};
  function line(conversation, text) {
    var note = el("button", "elsewhere", text);
    note.addEventListener("click", function () { showConversation(agent.id, conversation); });
    notes.push(note);
  }
  waiting.forEach(function (row) {
    var where = row.conversation || "main";
    if (seen[where]) return;
    seen[where] = true;
    var n = waiting.filter(function (other) { return (other.conversation || "main") === where; }).length;
    line(where, t("ui.next.chat.resultsElsewhere", { n: n, where: conversationLabel(where) }));
  });
  ((agent.facts && agent.facts.unreadIn) || []).forEach(function (entry) {
    if (entry.conversation === chat.conversation || seen[entry.conversation]) return;
    line(entry.conversation, t("ui.next.chat.unreadElsewhere", { n: entry.count, where: conversationLabel(entry.conversation) }));
  });
  return notes;
}

/** A result waiting for the person: what it is, where it came from, what was reported, and the decision. */
function resultCard(row) {
  var card = el("div", "card-plain"), acts = el("div", "acts"), files = row.deliverables || [], report = row.report, maker = agentName(row.assigneeId);
  var accept = el("button", "act-primary", t("ui.next.act.accept")), changes = el("button", "act", t("ui.next.act.changes")), open = el("button", "act", t("ui.next.act.details"));
  card.dataset.result = row.id;
  card.appendChild(el("div", "card-head", t("ui.next.chat.review")));
  card.appendChild(el("div", "", row.title));
  card.appendChild(el("div", "why", originOf(row)));
  if (report && report.note) {
    card.appendChild(el("div", "why", t("ui.next.chat.reported", { name: agentName(report.by) || maker, when: agoText(report.at) })));
    card.appendChild(rich(report.note, "report"));
  }
  files.slice(0, 4).forEach(function (file) {
    var link = el("a", "file", file.name);
    link.href = "/api/tasks/deliverable?task=" + encodeURIComponent(row.id) + "&id=" + encodeURIComponent(file.id);
    card.appendChild(link);
  });
  ((row.reading && row.reading.evidence) || []).slice(0, 2).forEach(function (line) { card.appendChild(el("div", "why", line)); });
  if (files.length > 4) card.appendChild(el("div", "why", t("ui.next.chat.moreFiles", { n: files.length - 4 })));
  if (files.length === 0 && !(report && report.note)) card.appendChild(el("div", "why", t("ui.next.chat.noReport")));
  accept.addEventListener("click", function () {
    postJson("/api/tasks/update", { id: row.id, status: "done" }).then(function () { toast(t("ui.next.done.accepted")); refreshSoon(); }, failed);
  });
  open.addEventListener("click", function () { openPanel(row.id); });
  if (chat.changing === row.id) {
    // Said here, beside what it is about; the page's own redraw keeps what is being typed.
    var input = el("textarea"), send = el("button", "act-primary", t("ui.next.act.send")), back = el("button", "act", t("ui.next.act.cancel"));
    input.placeholder = t("ui.next.panel.changesPlaceholder");
    send.addEventListener("click", function () {
      if (!input.value.trim()) return;
      postJson("/api/tasks/update", { id: row.id, status: "doing", note: input.value.trim() }).then(function () { chat.changing = ""; toast(t("ui.next.done.sent", { name: maker })); refreshSoon(); }, failed);
    });
    back.addEventListener("click", function () { chat.changing = ""; render(); });
    card.appendChild(input); acts.appendChild(send); acts.appendChild(back); card.appendChild(acts);
    return card;
  }
  changes.addEventListener("click", function () { chat.changing = row.id; render(); var field = document.querySelector("[data-result='" + row.id + "'] textarea"); if (field) field.focus(); });
  acts.appendChild(accept); acts.appendChild(changes); acts.appendChild(open); card.appendChild(acts);
  card.appendChild(el("div", "why", t("ui.next.chat.reviewHint", { name: maker })));
  return card;
}
`;
