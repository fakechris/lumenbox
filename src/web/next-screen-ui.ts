/**
 * The agent's computer, beside its conversation (INV-1825).
 *
 * Closed by default: a person talks to an agent and looks at its screen when they want to see what
 * it is doing, or at its files when they want what it made. Detail level of docs/99 §6 — one
 * button in the conversation's header, and the same desktop and file endpoints the classic page uses.
 */
export const NEXT_SCREEN_JS = `
var screen2 = { open: false, tab: "desktop", dir: "", root: "", entries: [], error: "" };

function loadFiles(dir) {
  getJson("/api/files" + (dir ? "?dir=" + encodeURIComponent(dir) : "")).then(function (got) {
    screen2.dir = got.path || dir || got.root; screen2.root = got.root; screen2.entries = got.entries || []; screen2.error = "";
    renderScreen();
  }, function (error) { screen2.entries = []; screen2.error = error.message; renderScreen(); });
}

/** A file from the person's machine into the folder being looked at; the agent finds it there. */
function uploadFile(file) {
  var reader = new FileReader();
  reader.onload = function () {
    var base64 = String(reader.result).split(",")[1] || "", path = screen2.dir.replace(/\\/$/, "") + "/" + file.name;
    postJson("/api/file", { path: path, base64: base64 }).then(function () { toast(t("ui.next.screen.uploaded", { name: file.name })); loadFiles(screen2.dir); }, failed);
  };
  reader.readAsDataURL(file);
}

function filesBlock() {
  var box = el("div", "files");
  if (screen2.error) { box.appendChild(el("p", "why", screen2.error)); return box; }
  var pick = el("label", "act", t("ui.next.screen.upload")), input = el("input");
  input.type = "file"; input.multiple = true; input.hidden = true;
  input.addEventListener("change", function () { Array.prototype.forEach.call(input.files, uploadFile); });
  pick.appendChild(input); box.appendChild(pick);
  if (screen2.dir && screen2.root && screen2.dir !== screen2.root) {
    var up = el("button", "file", "‹ " + screen2.dir.slice(screen2.root.length) );
    up.addEventListener("click", function () { loadFiles(screen2.dir.replace(/\\/[^\\/]+\\/?$/, "") || screen2.root); });
    box.appendChild(up);
  }
  screen2.entries.slice().sort(function (a, b) { return String(b.modified || "").localeCompare(String(a.modified || "")); }).forEach(function (entry) {
    var path = screen2.dir.replace(/\\/$/, "") + "/" + entry.name, row;
    if (entry.type === "directory") {
      row = el("button", "file");
      row.addEventListener("click", function () { loadFiles(path); });
      row.appendChild(el("span", "", entry.name + "/")); row.appendChild(el("span", "", ""));
    } else {
      row = el("a", "file");
      row.href = "/api/file?path=" + encodeURIComponent(path); row.target = "_blank"; row.rel = "noopener";
      row.appendChild(el("span", "", entry.name)); row.appendChild(el("span", "", bytes(entry.size || 0)));
    }
    box.appendChild(row);
  });
  if (screen2.entries.length === 0) box.appendChild(el("p", "why", t("ui.next.screen.empty")));
  return box;
}

function renderScreen() {
  var pane = $("screen"), agent = next.agents[chat.agentId], body = $("screen-body");
  var shown = screen2.open && next.view === "chat" && !!agent;
  pane.hidden = !shown;
  $("screen-toggle").hidden = next.view !== "chat" || !agent;
  $("screen-toggle").setAttribute("aria-pressed", String(shown));
  if (!shown) { body.replaceChildren(); return; }
  document.querySelectorAll("[data-screen]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.screen === screen2.tab)); });
  if (screen2.tab === "files") { body.replaceChildren(filesBlock()); return; }
  // The frame is kept while it shows the same desktop: setting it again restarts the connection.
  var frame = body.querySelector("iframe"), wanted = agent.desktopUrl ? agent.desktopUrl + "&embedded=1" : "";
  if (!wanted) { body.replaceChildren(el("p", "empty", t("ui.next.screen.none"))); return; }
  if (!frame || frame.getAttribute("src") !== wanted) {
    frame = el("iframe"); frame.setAttribute("src", wanted); frame.title = t("ui.next.screen.desktop");
    var full = el("a", "why", t("ui.next.screen.full")); full.href = agent.desktopUrl; full.target = "_blank"; full.rel = "noopener";
    body.replaceChildren(frame, full);
  }
}

function screenStart() {
  $("screen-toggle").addEventListener("click", function () { screen2.open = !screen2.open; renderScreen(); });
  $("screen-close").addEventListener("click", function () { screen2.open = false; renderScreen(); });
  document.querySelectorAll("[data-screen]").forEach(function (button) {
    button.addEventListener("click", function () { screen2.tab = button.dataset.screen; if (screen2.tab === "files") loadFiles(screen2.dir); else renderScreen(); });
  });
}
`;
