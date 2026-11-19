/**
 * Work that waits on the person, as the card they meet in the conversation (INV-1923).
 *
 * The card used to be assembled from a table: one sentence per category of reason and the same
 * buttons whatever was in the way. Now the agent that asks writes it (person-ask.ts): the title is
 * the action, the sentences say what happened, why it is the person's turn, exactly how, and what the
 * agent keeps doing meanwhile. Where the agent wrote nothing, the fixed sentences are what is shown,
 * as before.
 *
 * The buttons follow what is in the way (next-logic-ui.ts `nextNeedOf`), not the category: something
 * only the person can do elsewhere is "I've done it / skip for now"; a go-ahead is the two outcomes
 * the agent named, else approve and refuse; a result to look at keeps confirm and send back
 * (next-result-ui.ts). A press is the person's word to the agent, said in the conversation the work
 * belongs to; it changes no permission. Every family can be put off to one of a few ready times.
 *
 * What was handed over opens where the card stands: a picture, a recording or a text is shown under
 * its name, and anything else is downloaded.
 */
import { ASK_SENTENCES } from "../host/person-ask.ts";

export const NEXT_NEED_JS = `
var ASK_ORDER = ${JSON.stringify(ASK_SENTENCES)};
/** answered: what the person pressed on a card, by the change it answered, so the card is a line until the agent moves. */
var need = { answered: {}, refusing: "", previews: {} };

/** Whether the person put this work off: nothing asks about it again until then. */
function putOff(row) { return Date.parse(row.snoozeUntil || "") > Date.now(); }

/** The agent's own sentences under their names, in the fixed order; what stays the person's to check is marked. */
function askBlock(ask) {
  var box = el("div", "parts");
  ASK_ORDER.forEach(function (key) {
    var said = (ask.said || []).filter(function (row) { return row.key === key; })[0];
    if (!said) return;
    var row = el("div", "part");
    row.dataset.part = key;
    row.appendChild(el("b", "", t("ui.next.ask." + key)));
    row.appendChild(rich(said.text, "said"));
    box.appendChild(row);
  });
  return box;
}

var PREVIEW_KIND = { png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", mp4: "video", webm: "video", md: "text", txt: "text", csv: "text", json: "text", log: "text" };

/** A file that was handed over: a picture, a recording or a text opens under its name; anything else is a download. */
function fileRow(taskId, file) {
  var address = "/api/tasks/deliverable?task=" + encodeURIComponent(taskId) + "&id=" + encodeURIComponent(file.id);
  var kind = PREVIEW_KIND[String(file.name || "").split(".").pop().toLowerCase()], key = taskId + "/" + file.id;
  if (!kind) { var link = el("a", "file", file.name); link.href = address; return link; }
  var row = el("button", "file", file.name);
  row.setAttribute("aria-expanded", String(!!need.previews[key]));
  row.addEventListener("click", function () {
    var shown = need.previews[key];
    if (shown) { shown.remove(); delete need.previews[key]; row.setAttribute("aria-expanded", "false"); return; }
    var box = need.previews[key] = el("div", "preview"), save = el("a", "", t("ui.next.need.download"));
    save.href = address;
    if (kind === "text") {
      fetch(address + "&inline=1").then(function (got) { return got.text(); }).then(function (text) {
        box.insertBefore(/\\.md$/i.test(file.name) ? rich(text.slice(0, 20000), "report") : el("pre", "", text.slice(0, 20000)), save);
      }, failed);
    } else {
      var media = document.createElement(kind === "image" ? "img" : "video");
      media.src = address + "&inline=1"; media.alt = file.name; if (kind === "video") media.controls = true;
      box.appendChild(media);
    }
    box.appendChild(save); row.after(box); row.setAttribute("aria-expanded", "true");
  });
  return row;
}

/** What the card carries beside the words: the files handed over, the conclusion of a check of the result, and the evidence named. */
function embedInto(card, row) {
  var files = row.deliverables || [], checked = row.reading && row.reading.checks && row.reading.checks.result;
  files.slice(0, 4).forEach(function (file) {
    card.appendChild(fileRow(row.id, file));
    // Opened before this redraw: it stays open, the same node, so a recording keeps its place.
    if (need.previews[row.id + "/" + file.id]) card.appendChild(need.previews[row.id + "/" + file.id]);
  });
  if (files.length > 4) card.appendChild(el("div", "why", t("ui.next.chat.moreFiles", { n: files.length - 4 })));
  if (checked && checked !== "notChecked") card.appendChild(el("div", "why", t("ui.next.need.check." + checked)));
  ((row.reading && row.reading.evidence) || []).slice(0, 2).forEach(function (line) { card.appendChild(el("div", "why", line)); });
}

/** "Later", as a few ready times: pressed, it becomes the choice, and the work is not asked about again until then. */
function laterButton(taskId, done) {
  var later = el("button", "act", t("ui.next.act.snooze"));
  later.addEventListener("click", function () {
    var pick = el("span", "acts");
    nextLaterTimes(new Date()).forEach(function (time) {
      var when = el("button", "act", t("ui.next.later." + time.key));
      when.addEventListener("click", function () {
        var until = new Date(time.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
        postJson("/api/tasks/update", { id: taskId, snoozeUntil: time.at }).then(function () { toast(t("ui.next.done.snoozed", { when: until })); done(); }, failed);
      });
      pick.appendChild(when);
    });
    later.replaceWith(pick);
  });
  return later;
}

/** The person's word on a request, said to the agent in the conversation the work belongs to; the card is a line until the agent moves. */
function sayNeed(row, text) {
  var name = agentName(row.assigneeId);
  postJson("/api/prompt", { agent: row.assigneeId, conversation: row.conversation || "main", text: text }).then(function () {
    need.answered[row.id] = { at: row.updatedAt, text: text }; need.refusing = "";
    toast(t("ui.next.done.sent", { name: name })); render(); if (panel.taskId === row.id) loadPanel(); refreshSoon();
  }, failed);
}

/**
 * Fills a box with what is asked on a piece of work and the buttons that answer it: the agent's own
 * title and sentences where it wrote them, else what it noted, or the fixed sentence where it noted nothing. Used by the card
 * in the conversation and by the work panel, so the two cannot say different things.
 */
function needInto(box, row, listed) {
  var family = nextNeedOf(row), ask = row.ask, last = (row.history || [])[(row.history || []).length - 1] || {}, name = agentName(row.assigneeId), acts = el("div", "acts");
  var about = ask ? ask.title : row.title, options = last.options || [], answered = need.answered[row.id];
  if (ask) box.appendChild(askBlock(ask));
  else box.appendChild(last.note ? rich(last.note, "report") : el("div", "why", t("ui.wr.reason.needs")));
  if (!listed) embedInto(box, row); // the panel lists what was handed over under its own heading
  // Answered here and the agent has not moved yet: what was said, in place of the buttons.
  if (answered && answered.at === row.updatedAt) { box.appendChild(el("div", "aside", t("ui.next.need.said", { text: answered.text }))); return; }
  if (need.refusing === row.id) {
    // Refusing may carry a sentence of why, which the agent reads with the refusal; it is not required.
    var why = el("input"), no = el("button", "act-danger", options[1] || t("ui.next.act.deny")), back = el("button", "act", t("ui.next.act.cancel"));
    why.placeholder = t("ui.next.need.whyNot");
    no.addEventListener("click", function () {
      var reason = why.value.trim();
      sayNeed(row, t("ui.next.need.say.choice", { choice: options[1] || t("ui.next.act.deny"), title: about }) + (reason ? " " + t("ui.next.need.say.reason", { reason: reason }) : ""));
    });
    back.addEventListener("click", function () { need.refusing = ""; render(); if (panel.taskId === row.id) renderPanel(); });
    box.appendChild(why); acts.appendChild(no); acts.appendChild(back); box.appendChild(acts);
    return;
  }
  if (family === "act") {
    var did = el("button", "act-primary", t("ui.next.need.done")), skip = el("button", "act", t("ui.next.need.skip"));
    did.addEventListener("click", function () { sayNeed(row, t("ui.next.need.say.done", { title: about })); });
    skip.addEventListener("click", function () { sayNeed(row, t("ui.next.need.say.skip", { title: about })); });
    acts.appendChild(did); acts.appendChild(skip);
  } else if (family === "release") {
    // The two outcomes in the agent's words where it named them ("Send it", "Don't send"); the plain pair where it did not.
    var yes = el("button", "act-primary", options[0] || t("ui.next.act.approve")), refuse = el("button", "act", options[1] || t("ui.next.act.deny"));
    yes.addEventListener("click", function () { sayNeed(row, t("ui.next.need.say.choice", { choice: options[0] || t("ui.next.act.approve"), title: about })); });
    refuse.addEventListener("click", function () { need.refusing = row.id; render(); if (panel.taskId === row.id) renderPanel(); });
    acts.appendChild(yes); acts.appendChild(refuse);
  } else {
    options.forEach(function (option) {
      var pick = el("button", "act", option);
      pick.addEventListener("click", function () { sayNeed(row, option); });
      acts.appendChild(pick);
    });
  }
  acts.appendChild(laterButton(row.id, function () { if (panel.taskId === row.id) loadPanel(); refreshSoon(); }));
  box.appendChild(acts);
  box.appendChild(el("div", "why", t("ui.next.need.hint." + (family || "answer"), { name: name })));
}

/** Work that waits on the person for something other than a look at its result: the request, as a card in the agent's conversation. */
function needCard(row) {
  var card = el("div", "card-need"), ask = row.ask, open = el("button", "elsewhere", row.title);
  card.dataset.need = row.id;
  card.appendChild(el("div", "card-head", ask ? ask.title : t("ui.next.need.head", { name: agentName(row.assigneeId) })));
  // Which work this is about, and the way into it: the title of the card is the action, not the work.
  open.addEventListener("click", function () { openPanel(row.id); });
  card.appendChild(open);
  needInto(card, row);
  return card;
}
`;
