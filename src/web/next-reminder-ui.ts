/**
 * Reminders on the automations page (INV-1878): what members have asked to be woken for.
 *
 * A reminder starts a turn by itself, so it belongs with what starts by itself. One row each — who
 * set it, the note, when it is due and where the result goes — and one thing a person can do, which
 * is drop it. Nothing is drawn while none waits. The list is `GET /api/reminders`.
 *
 * Drawn under the routines by wrapping `renderAuto` (next-auto-ui.ts), so that page's own script
 * stays about routines and is tested alone.
 */
export const NEXT_REMINDER_JS = `
var remind = { list: null, at: 0, reading: false };

function reloadReminders() { remind.list = null; render(); }

function renderReminders(view) {
  // Reminders are set and fire without anyone pressing anything here, so a list older than a few seconds is read again.
  if ((!remind.list || Date.now() - remind.at > 15000) && !remind.reading) {
    remind.reading = true;
    getJson("/api/reminders").then(function (got) {
      var was = JSON.stringify(remind.list || []);
      remind.list = got.reminders || []; remind.at = Date.now(); remind.reading = false;
      if (next.view === "auto" && JSON.stringify(remind.list) !== was) render();
    }, function (error) { remind.reading = false; remind.at = Date.now(); remind.list = remind.list || []; failed(error); });
  }
  if (!remind.list || remind.list.length === 0) return;
  var list = el("div", "list");
  view.appendChild(el("h3", "", t("ui.next.remind.title")));
  remind.list.forEach(function (reminder) {
    var row = el("div", "row"), open = el("span", "open"), body = el("span", "body"), acts = el("span", "acts"), drop = el("button", "act", t("ui.next.remind.dismiss"));
    var facts = [reminder.agentName, t("ui.next.remind.due", { when: new Date(reminder.due).toLocaleString() })];
    if (reminder.chat) facts.push(t("ui.next.remind.chat", { chat: reminder.chat }));
    body.appendChild(el("div", "title", reminder.text));
    body.appendChild(el("div", "why", facts.join(" · ")));
    open.appendChild(el("span", "who", initial(reminder.agentName)));
    open.appendChild(body);
    drop.addEventListener("click", function () {
      drop.disabled = true;
      postJson("/api/reminders/dismiss", { id: reminder.id }).then(function () { toast(t("ui.next.remind.dismissed")); reloadReminders(); }, function (error) { failed(error); reloadReminders(); });
    });
    acts.appendChild(drop);
    row.appendChild(open); row.appendChild(acts);
    list.appendChild(row);
  });
  view.appendChild(list);
}

var renderAutoRoutines = renderAuto;
renderAuto = function (view) { renderAutoRoutines(view); if (settings.routines) renderReminders(view); };
`;
