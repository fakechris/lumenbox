/**
 * Everything one agent waits on the person for, as one entry above its conversation (INV-1923).
 *
 * Each thing that waited was its own card at the foot of the conversation: three requests and a result
 * were four cards, a screen and a half of them, and what had been said was somewhere above. A person
 * answers one thing at a time. So what waits is one entry that stays at the top of the conversation
 * while the conversation scrolls under it: one card, "2 of 4" and the way to the next. It is redrawn
 * in place as the work moves; nothing is appended for a change. The inbox across agents is still there,
 * and is still the second way in.
 *
 * A reply typed while a card is shown is a reply to that card: the box says "replying to: …", and what
 * is sent is written on that work (person-word.ts), not dropped into the conversation for the agent to
 * guess what it is about. One press detaches it.
 *
 * Once answered, a card is one line where it was answered — what was decided, by whom, when — and the
 * work's panel behind it holds everything the card said. Work the host ended with nobody's word has
 * its line too.
 */
export const NEXT_DOCK_JS = `
/** How long a settled card's line stays in the conversation: after a day it is history, and the work view has it. */
var RECEIPT_KEEP = 86400000;

/** Whether a row still asks something of the person here: a result to look at, or a request nobody has answered. */
function waitsHere(row) {
  if (row.assigneeId !== chat.agentId || (row.conversation || "main") !== chat.conversation) return false;
  return waitsOnPerson(row); // next-line-ui.ts: answered is the agent's move now
}

/** What this agent waits on the person for in this conversation, longest-waiting first: its work, then what it holds for a consent or a secret. */
function dockEntries(agent) {
  var rows = next.rows.filter(waitsHere).sort(function (a, b) { return String(a.updatedAt).localeCompare(String(b.updatedAt)); });
  return rows.map(function (row) { return { id: row.id, row: row }; }).concat(pendingCards(agent).map(function (node, index) { return { id: "held-" + index, node: node }; }));
}

/** The entry being shown: the one the person paged to while it still waits, else the first. */
function dockShown(agent) {
  var entries = dockEntries(agent), at = 0;
  entries.forEach(function (entry, index) { if (entry.id === need.page[agent.id]) at = index; });
  return { entries: entries, at: at, entry: entries[at] };
}

/** The one entry above the conversation, or null when nothing waits. */
function needDock(agent) {
  var shown = dockShown(agent), total = shown.entries.length;
  if (!shown.entry) return null;
  var dock = el("div", "needdock"), entry = shown.entry;
  dock.dataset.dock = entry.id;
  if (total > 1) {
    // How many wait, and the way to the next said as a button: two small arrows were missed, and what they hid was too.
    var pager = el("div", "pager"), back = el("button", "act", "‹"), on = el("button", "act", t("ui.next.need.next", { n: (shown.at + 1) % total + 1, m: total }) + " ›");
    var turn = function (by) { need.page[agent.id] = shown.entries[(shown.at + by + total) % total].id; need.detached = ""; render(); };
    back.setAttribute("aria-label", t("ui.next.need.previous"));
    back.addEventListener("click", function () { turn(-1); }); on.addEventListener("click", function () { turn(1); });
    pager.appendChild(el("span", "", t("ui.next.need.page", { n: shown.at + 1, m: total })));
    pager.appendChild(back); pager.appendChild(on); dock.appendChild(pager);
  }
  dock.appendChild(entry.node || (nextNeedOf(entry.row) === "delivery" ? resultCard(entry.row) : needCard(entry.row)));
  return dock;
}

/** The entry stands above the conversation, outside what scrolls: the conversation starts below it, so no message is half under it. */
function placeDock(dock) { var bar = $("dock"); bar.replaceChildren(); bar.hidden = !dock; if (dock) bar.appendChild(dock); }

/**
 * The end of the conversation, with no message cut in half at its top edge: what the edge would cut is scrolled out whole, and
 * the room is made under the newest message instead. A message taller than a third of the view is left as it falls.
 */
function scrollToEnd(view) {
  var thread = view.querySelector(".thread");
  view.scrollTop = view.scrollHeight;
  if (!thread) return;
  var edge = view.getBoundingClientRect().top, cut = Array.prototype.filter.call(thread.children, function (node) { var box = node.getBoundingClientRect(); return box.top < edge && box.bottom > edge; })[0];
  var over = cut ? cut.getBoundingClientRect().bottom - edge : 0;
  if (over > 0 && over < view.clientHeight / 3) { thread.style.paddingBottom = Math.ceil(over) + "px"; view.scrollTop = view.scrollHeight; }
}

/** Who settled something, as a person reads it: the agent by name, the host as itself, a person by the door they spoke through. */
function receiptWho(receipt) {
  if (receipt.what === "closed" || receipt.what === "lapsed") return t("ui.next.receipt.host");
  if (next.agents[receipt.by]) return agentName(receipt.by);
  var door = String(receipt.by).split(":")[0].split("-")[0];
  return MSG["ui.next.receipt.door." + door] ? t("ui.next.receipt.door." + door) : t("ui.next.receipt.door.other");
}

/** A settled card: one line saying what was decided, by whom and when. Pressed, it opens the work with everything the card said. */
function receiptLine(row) {
  var receipt = row.receipt, line = el("button", "receipt");
  line.dataset.receipt = row.id;
  line.appendChild(el("span", "mark", receipt.what === "returned" || receipt.what === "dropped" ? "↩" : "✓"));
  line.appendChild(el("span", "what", t("ui.next.receipt." + receipt.what, { title: receipt.title }) + (receipt.text ? t("ui.next.receipt.said", { text: clip(receipt.text, 160) }) : "")));
  line.appendChild(el("span", "why", receiptWho(receipt) + " · " + agoText(receipt.at)));
  line.addEventListener("click", function () { openPanel(row.id); });
  return line;
}

/**
 * The lines of what was settled lately in this conversation, set among what was said by time: before(entry) gives the ones
 * older than an entry, rest() the ones newer than everything drawn.
 */
function receiptsAmong() {
  var left = next.rows.filter(function (row) {
    return row.receipt && row.assigneeId === chat.agentId && (row.conversation || "main") === chat.conversation && Date.now() - Date.parse(row.receipt.at) < RECEIPT_KEEP;
  }).sort(function (a, b) { return String(a.receipt.at).localeCompare(String(b.receipt.at)); });
  return {
    before: function (entry) { var out = []; while (left.length && entry.at && left[0].receipt.at <= entry.at) out.push(receiptLine(left.shift())); return out; },
    rest: function () { return left.splice(0).map(receiptLine); },
  };
}

/** The work a typed reply is about: the card on show, unless the person detached this reply from it. */
function replyTarget() {
  var agent = next.agents[chat.agentId];
  if (next.view !== "chat" || !agent || chat.find) return null;
  var row = dockShown(agent).entry && dockShown(agent).entry.row;
  return row && need.detached !== row.id ? row : null;
}

/** Above the box you type in: what the reply will be attached to, and the way to send an ordinary message instead. */
function renderReplyTo() {
  var line = $("reply-to"), row = replyTarget();
  line.replaceChildren();
  line.hidden = !row;
  if (!row) return;
  var off = el("button", "", "×");
  off.setAttribute("aria-label", t("ui.next.need.detach")); off.title = t("ui.next.need.detach");
  off.addEventListener("click", function () { need.detached = row.id; renderReplyTo(); $("composer-text").focus(); });
  line.appendChild(el("span", "", t("ui.next.need.replyTo", { title: row.ask ? row.ask.title : row.title })));
  line.appendChild(off);
}

/** Sends what was typed as the reply to the card on show, if there is one. */
function sendReply(text) {
  var row = replyTarget();
  return row && sayNeed(row, text);
}
`;
