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

/** Another conversation of the agent being talked to, without leaving the page. */
function showConversation(agentId, conversation) {
  if (agentId !== chat.agentId) openChat(agentId);
  chat.conversation = conversation || "main"; chat.loadedFor = ""; chat.entries = []; chat.live = null; chat.plan = null; chat.liveSurfaces = {};
  next.view = "chat"; closePanel(); render();
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
