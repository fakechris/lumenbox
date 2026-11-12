/**
 * The computers agents live on (INV-1825).
 *
 * A person organises agents by the computer they are on, so the computers are named at the top of the
 * agent list — and when the one being looked at is not running, that is said right there, with the
 * button that starts it. This view is the rest: every computer this person may see, whether it is
 * reachable, how many agents it holds, and removing one that was attached.
 */
export const NEXT_BOXES_JS = `
var boxes = { list: [], own: "", starting: false };

function boxById(id) { return boxes.list.filter(function (box) { return box.id === id; })[0]; }

function startBox() {
  boxes.starting = true; render();
  postJson("/api/box/up", {}).then(function () { setTimeout(function () { boxes.starting = false; refresh(); }, 4000); }, function (error) { boxes.starting = false; failed(error); render(); });
}

/** Said beside the agents when the computer they are on is not reachable: it explains every silence below it. */
function boxNotice() {
  var box = boxById(chat.box), strip = $("box-notice");
  strip.hidden = !box || box.connected !== false;
  if (strip.hidden) return;
  strip.replaceChildren(el("span", "", t("ui.next.box.offline", { name: box.name })));
  if (box.id === boxes.own) {
    var start = el("button", "act", t(boxes.starting ? "ui.next.box.starting" : "ui.next.box.start"));
    start.disabled = boxes.starting;
    start.addEventListener("click", startBox);
    strip.appendChild(start);
  }
}

function renderBoxes(view) {
  var list = el("div", "list");
  boxes.list.forEach(function (box) {
    var row = el("div", "row"), body = el("span", "body");
    body.appendChild(el("div", "title", box.name));
    body.appendChild(el("div", "why", [box.kind, t("ui.next.box.agents", { n: box.agents || 0 }), box.version || "", box.membersLabel || ""].filter(Boolean).join(" · ")));
    row.appendChild(el("span", "who", initial(box.name)));
    row.appendChild(body);
    row.appendChild(el("span", box.connected ? "chip-run" : "chip", t(box.connected ? "ui.next.box.on" : "ui.next.box.off")));
    if (!box.connected && box.id === boxes.own) {
      var start = el("button", "act", t(boxes.starting ? "ui.next.box.starting" : "ui.next.box.start"));
      start.disabled = boxes.starting; start.addEventListener("click", startBox);
      row.appendChild(start);
    }
    if (box.id !== boxes.own && !(box.agents > 0)) {
      var remove = el("button", "act", t("ui.next.box.remove"));
      remove.addEventListener("click", function () {
        var confirm = el("button", "act-danger", t("ui.next.box.removeConfirm"));
        confirm.addEventListener("click", function () { postJson("/api/boxes/detach", { name: box.id }).then(function () { refresh(); }, failed); });
        remove.replaceWith(confirm);
      });
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
  view.appendChild(list);
  var more = el("section", "setting"), link = el("button", "act", t("ui.next.box.addOpen"));
  link.addEventListener("click", function () { openSettingsPane("boxes"); });
  more.appendChild(el("h2", "group", t("ui.next.box.add")));
  more.appendChild(el("p", "", t("ui.next.box.addNote")));
  more.appendChild(link);
  view.appendChild(more);
}
`;
