/**
 * Work that waits on the person, as the card they meet in the conversation (INV-1923).
 *
 * The card used to be assembled from a table: one sentence per category of reason and the same
 * buttons whatever was in the way. Now the agent that asks writes it (person-ask.ts). What the card
 * shows first is what there is to know or decide: the action as its title, the agent's sentences as
 * one running paragraph, what stays the person's to check set apart, and the buttons. The names the
 * agent wrote its sentences under are its writing format, not reading matter: the labelled breakdown
 * is one click away, in the work's panel. Where the agent wrote nothing, its note or the fixed
 * sentence is what is shown, as before.
 *
 * The buttons follow what is in the way (next-logic-ui.ts `nextNeedOf`), not the category: something
 * only the person can do elsewhere is "I've done it / skip for now"; a go-ahead is the two outcomes
 * the agent named, else approve and refuse; a result to look at keeps confirm and send back
 * (next-result-ui.ts). A press is the person's word written on the work it answers, so it need not
 * say again what it is about: the host tells
 * the agent and starts its turn (person-word.ts), and the card becomes one line (next-dock-ui.ts).
 * It changes no permission. Every family can be put off to one of a few ready times. One line under the buttons says
 * what each leads to.
 *
 * What was handed over is one row of names: a picture, a recording or a text opens where the card
 * stands, and anything else is downloaded.
 */
import { ASK_SENTENCES, askProse } from "../host/person-ask.ts";

export const NEXT_NEED_JS = `
var ASK_ORDER = ${JSON.stringify(ASK_SENTENCES)};
/** refusing: the request being refused, while a reason may be typed; previews: files opened on a card; page and detached: next-dock-ui.ts. */
var need = { refusing: "", previews: {}, page: {}, detached: "" };
${askProse.toString()}

/** Whether the person put this work off: nothing asks about it again until then. */
function putOff(row) { return Date.parse(row.snoozeUntil || "") > Date.now(); }

/** The agent's sentences under the names it wrote them with, in the fixed order: the breakdown the work's panel shows. */
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

/** The same sentences as a person reads them first: one running paragraph, and apart from it what stays theirs to check. */
function askBrief(box, ask) {
  var prose = askProse(ask);
  if (prose.text) box.appendChild(rich(prose.text, "said"));
  if (prose.yours) {
    var yours = el("div", "yours");
    yours.appendChild(el("b", "", t("ui.next.ask.unverified")));
    yours.appendChild(rich(prose.yours, "said"));
    box.appendChild(yours);
  }
}

var PREVIEW_KIND = { png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", mp4: "video", webm: "video", md: "text", txt: "text", csv: "text", json: "text", log: "text" };

/** A file that was handed over, as its name: a picture, a recording or a text opens under the row; anything else is a download. */
function fileRow(taskId, file, under) {
  var address = "/api/tasks/deliverable?task=" + encodeURIComponent(taskId) + "&id=" + encodeURIComponent(file.id);
  var kind = PREVIEW_KIND[String(file.name || "").split(".").pop().toLowerCase()], key = taskId + "/" + file.id;
  if (!kind) { var link = el("a", "chip-file", file.name); link.href = address; return link; }
  var row = el("button", "chip-file", file.name);
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
    box.appendChild(save); under.appendChild(box); row.setAttribute("aria-expanded", "true");
  });
  return row;
}

/**
 * What the card carries beside the words, in one row: the files handed over by name, and the conclusion of a check of
 * the result. The evidence named and the files past the first few are in the work's panel.
 */
function embedInto(card, row) {
  var files = row.deliverables || [], checked = row.reading && row.reading.checks && row.reading.checks.result;
  var told = checked && checked !== "notChecked";
  if (files.length === 0 && !told) return;
  var under = el("div", "embeds"), strip = el("div", "chips");
  under.appendChild(strip);
  files.slice(0, 4).forEach(function (file) { strip.appendChild(fileRow(row.id, file, under)); });
  if (files.length > 4) strip.appendChild(el("span", "why", t("ui.next.chat.moreFiles", { n: files.length - 4 })));
  if (told) strip.appendChild(el("span", "why", t("ui.next.need.check." + checked)));
  // Opened before this redraw: it stays open, the same node, so a recording keeps its place.
  files.slice(0, 4).forEach(function (file) { if (need.previews[row.id + "/" + file.id]) under.appendChild(need.previews[row.id + "/" + file.id]); });
  card.appendChild(under);
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

/**
 * The person's word on a piece of work, written on the work it answers: the host tells the agent in the conversation the
 * work belongs to and starts its turn, and the card is one line from then on (person-word.ts).
 */
function sayNeed(row, text) {
  var name = agentName(row.assigneeId);
  return postJson("/api/tasks/update", { id: row.id, note: text }).then(function () {
    need.refusing = "";
    toast(t("ui.next.done.sent", { name: name })); render(); if (panel.taskId === row.id) loadPanel(); refreshSoon();
  });
}

/**
 * Fills a box with what is asked on a piece of work and the buttons that answer it: the agent's own
 * sentences where it wrote them, else what it noted, or the fixed sentence where it noted nothing. Used by the card
 * in the conversation and by the work panel, so the two cannot say different things: the card (not listed) shows the
 * running paragraph, the panel the same sentences under their names.
 */
function needInto(box, row, listed) {
  var family = nextNeedOf(row), ask = row.ask, last = (row.history || [])[(row.history || []).length - 1] || {}, name = agentName(row.assigneeId), acts = el("div", "acts");
  var options = last.options || [];
  // Answered, and the agent has not moved yet: the one line it became, in place of the request and its buttons.
  if (row.receipt && row.status === "blocked") { box.appendChild(receiptLine(row)); return; }
  if (ask && listed) box.appendChild(askBlock(ask));
  else if (ask) askBrief(box, ask);
  else box.appendChild(last.note ? rich(last.note, "report") : el("div", "why", t("ui.wr.reason.needs")));
  if (!listed) embedInto(box, row); // the panel lists what was handed over under its own heading
  if (need.refusing === row.id) {
    // Refusing may carry a sentence of why, which the agent reads with the refusal; it is not required.
    var why = el("input"), no = el("button", "act-danger", options[1] || t("ui.next.act.deny")), back = el("button", "act", t("ui.next.act.cancel"));
    why.placeholder = t("ui.next.need.whyNot");
    no.addEventListener("click", function () {
      var reason = why.value.trim();
      sayNeed(row, (options[1] || t("ui.next.act.deny")) + (reason ? t("ui.next.need.say.reason", { reason: reason }) : "")).catch(failed);
    });
    back.addEventListener("click", function () { need.refusing = ""; render(); if (panel.taskId === row.id) renderPanel(); });
    box.appendChild(why); acts.appendChild(no); acts.appendChild(back); box.appendChild(acts);
    return;
  }
  if (family === "act") {
    var did = el("button", "act-primary", t("ui.next.need.done")), skip = el("button", "act", t("ui.next.need.skip"));
    did.addEventListener("click", function () { sayNeed(row, t("ui.next.need.say.done")).catch(failed); });
    skip.addEventListener("click", function () { sayNeed(row, t("ui.next.need.say.skip")).catch(failed); });
    acts.appendChild(did); acts.appendChild(skip);
  } else if (family === "release") {
    // The two outcomes in the agent's words where it named them ("Send it", "Don't send"); the plain pair where it did not.
    var yes = el("button", "act-primary", options[0] || t("ui.next.act.approve")), refuse = el("button", "act", options[1] || t("ui.next.act.deny"));
    yes.addEventListener("click", function () { sayNeed(row, options[0] || t("ui.next.act.approve")).catch(failed); });
    refuse.addEventListener("click", function () { need.refusing = row.id; render(); if (panel.taskId === row.id) renderPanel(); });
    acts.appendChild(yes); acts.appendChild(refuse);
  } else {
    options.forEach(function (option) {
      var pick = el("button", "act", option);
      pick.addEventListener("click", function () { sayNeed(row, option).catch(failed); });
      acts.appendChild(pick);
    });
  }
  acts.appendChild(laterButton(row.id, function () { if (panel.taskId === row.id) loadPanel(); refreshSoon(); }));
  box.appendChild(acts);
  // What each press leads to, in one line under the buttons. It was the buttons' tooltip, to save a line, and a person
  // facing three or four buttons could not tell why they would pick one or what would follow.
  box.appendChild(el("div", "why", t("ui.next.need.hint." + (family || "answer"), { name: name }) + " " + t("ui.next.need.hint.later")));
}

/** Work that waits on the person for something other than a look at its result: the request, as a card in the agent's conversation. */
function needCard(row) {
  var card = el("div", "card-need"), ask = row.ask, open = el("button", "elsewhere", row.title);
  card.dataset.need = row.id;
  card.appendChild(el("div", "card-head", ask ? ask.title : t("ui.next.need.head", { name: agentName(row.assigneeId) })));
  // Which work this is about, and the way into it and into everything the card leaves out: the title of the card is the action, not the work.
  open.addEventListener("click", function () { openPanel(row.id); });
  card.appendChild(open);
  needInto(card, row);
  return card;
}
`;
