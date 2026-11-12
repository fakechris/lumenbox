/**
 * The computers agents live on (INV-1825).
 *
 * A person organises agents by the computer they are on, so the computers are named at the top of the
 * agent list — and when the one being looked at is not running, that is said right there, with the
 * button that starts it. This view is the rest: every computer this person may see, whether it is
 * reachable, how many agents it holds, and removing one that was attached.
 */
export const NEXT_BOXES_JS = `
var boxes = { list: [], own: "", starting: false, state: null, log: [], failed: "" };

function boxById(id) { return boxes.list.filter(function (box) { return box.id === id; })[0]; }

/**
 * Starting this installation's own computer. The first time it downloads an image, which takes
 * minutes: what Docker says is shown as it comes (the "box_setup" events), and the end of it — up,
 * or the line it failed on — is what replaces "starting".
 */
function startBox() {
  boxes.starting = true; boxes.log = []; boxes.failed = ""; render();
  postJson("/api/box/up", {}).then(function (got) {
    // Already up: there will be no events to wait for.
    if (got && got.ok) { boxes.starting = false; refresh(); }
  }, function (error) {
    // Somebody already started it: the same events are on their way.
    if (error.data && error.data.code === "box-starting") return;
    boxes.starting = false; boxes.failed = error.message; render();
  });
}
function boxSetupEvent(event) {
  if (!event || event.type !== "box_setup") return;
  boxes.starting = !event.done;
  if (event.line) boxes.log = boxes.log.concat([String(event.line)]).slice(-200);
  if (event.done) { boxes.failed = event.ok ? "" : String(event.line || ""); refresh(); }
  var log = document.querySelector("#box-notice pre"); // drawn only while starting, so not looked up by id
  if (log) { log.textContent = boxes.log.slice(-8).join(String.fromCharCode(10)); log.scrollTop = log.scrollHeight; } else renderSide();
}

/** Why this installation's own computer is not there, in words a person can act on. */
function boxWhy(box) {
  var docker = boxes.state && boxes.state.docker;
  if (box.id === boxes.own && docker && docker.state === "no-binary") return "missing";
  if (box.id === boxes.own && docker && docker.state === "no-engine") return "stopped";
  return "offline";
}

/** Said beside the agents when the computer they are on is not reachable: it explains every silence below it. */
function boxNotice() {
  var box = boxById(chat.box), strip = $("box-notice");
  strip.hidden = !box || box.connected !== false;
  if (strip.hidden) return;
  var why = boxWhy(box);
  strip.replaceChildren(el("span", "", why === "missing" ? t("ui.box.dockerMissing") : why === "stopped" ? t("ui.box.dockerStopped") : t("ui.next.box.offline", { name: box.name })));
  if (why === "missing") {
    [["Docker Desktop", "https://www.docker.com/products/docker-desktop/"], ["OrbStack", "https://orbstack.dev/"]].forEach(function (pair) {
      var link = el("a", "", pair[0]); link.href = pair[1]; link.target = "_blank"; link.rel = "noopener noreferrer"; strip.appendChild(link);
    });
  }
  if (box.id !== boxes.own) return;
  var start = el("button", "act", t(boxes.starting ? "ui.next.box.starting" : "ui.next.box.start"));
  start.id = "box-start"; start.disabled = boxes.starting;
  start.addEventListener("click", startBox);
  strip.appendChild(start);
  if (boxes.failed) strip.appendChild(el("div", "", t("ui.next.box.failed", { why: boxes.failed })));
  if (boxes.starting || boxes.log.length) {
    var log = el("pre", "raw"); log.id = "box-log"; log.textContent = boxes.log.slice(-8).join(String.fromCharCode(10));
    strip.appendChild(log);
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
