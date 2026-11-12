/**
 * The agent's computer, beside its conversation (INV-1825).
 *
 * Closed by default: a person talks to an agent and looks at its screen when they want to see what
 * it is doing, or at its files when they want what it made. Detail level of docs/99 §6 — one
 * button in the conversation's header, and the same desktop and file endpoints the classic page uses.
 */
export const NEXT_SCREEN_JS = `
var screen2 = { open: false, tab: "desktop", dir: "", root: "", entries: [], error: "", mine: {}, recording: {}, pinned: {}, preview: "", text: null };

function loadFiles(dir) {
  getJson("/api/files" + (dir ? "?dir=" + encodeURIComponent(dir) : "")).then(function (got) {
    screen2.dir = got.path || dir || got.root; screen2.root = got.root; screen2.entries = got.entries || []; screen2.error = "";
    renderScreen();
  }, function (error) { screen2.entries = []; screen2.error = error.message; renderScreen(); });
}

/** A file from the person's machine into the folder being looked at; the agent finds it there. */
function uploadFile(file) {
  // Where it goes is decided now: the folder shown may change before the file has been read.
  var reader = new FileReader(), folder = screen2.dir, path = folder.replace(/\\/$/, "") + "/" + file.name;
  reader.onload = function () {
    var base64 = String(reader.result).split(",")[1] || "";
    postJson("/api/file", { path: path, base64: base64 }).then(function () { toast(t("ui.next.screen.uploaded", { name: file.name })); loadFiles(folder); }, failed);
  };
  reader.readAsDataURL(file);
}

/** How a file can be shown without leaving the page: as a picture, as text, or not at all. */
function previewKind(name) {
  var ext = (/\\.([A-Za-z0-9]+)$/.exec(name) || ["", ""])[1].toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].indexOf(ext) >= 0) return "image";
  if (["md", "txt", "log", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "sh", "sql", "toml", "ini", "env"].indexOf(ext) >= 0) return "text";
  return ext ? "other" : "text";
}

/** One file, looked at in place: what it holds when that can be shown, and always the way to open or keep it. */
function previewBlock() {
  var box = el("div", "files"), path = screen2.preview, name = path.split("/").pop(), href = "/api/file?path=" + encodeURIComponent(path), kind = previewKind(name);
  var back = el("button", "file", "‹ " + name), open = el("a", "act", t("ui.next.screen.openFile")), keep = el("a", "act", t("ui.next.template.download")), acts = el("div", "acts");
  back.addEventListener("click", function () { screen2.preview = ""; screen2.text = null; renderScreen(); });
  open.href = href; open.target = "_blank"; open.rel = "noopener"; keep.href = href + "&download=1";
  acts.appendChild(open); acts.appendChild(keep); box.appendChild(back); box.appendChild(acts);
  if (kind === "image") { var picture = el("img"); picture.src = href; picture.alt = name; box.appendChild(picture); }
  else if (kind === "text") {
    if (screen2.text === null) {
      box.appendChild(el("p", "why", t("ui.next.auto.reading")));
      fetch(href).then(function (response) { if (!response.ok) throw new Error(String(response.status)); return response.text(); }).then(function (text) {
        if (screen2.preview === path) { screen2.text = text.length > 200000 ? text.slice(0, 200000) + "\\n…" : text; renderScreen(); }
      }, function () { if (screen2.preview === path) { screen2.text = ""; renderScreen(); } });
    } else { var shown = el("pre", "raw"); shown.textContent = screen2.text; box.appendChild(shown); }
  } else box.appendChild(el("p", "why", t("ui.next.screen.noPreview")));
  return box;
}

function filesBlock() {
  var box = el("div", "files");
  if (screen2.preview) return previewBlock();
  if (screen2.error) { box.appendChild(el("p", "why", screen2.error)); return box; }
  var pick = el("button", "act", t("ui.next.screen.upload")), input = el("input");
  input.type = "file"; input.multiple = true; input.hidden = true;
  input.addEventListener("change", function () { Array.prototype.forEach.call(input.files, uploadFile); });
  pick.addEventListener("click", function () { input.click(); });
  box.appendChild(pick); box.appendChild(input);
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
      row = el("button", "file");
      row.addEventListener("click", function () { screen2.preview = path; screen2.text = null; renderScreen(); });
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
    body.replaceChildren(frame, full, el("div", "desk"));
  }
  body.querySelector(".desk").replaceWith(deskControls(agent));
}

/**
 * The person's hands on the agent's desktop. Taking over tells the box first, so the agent's next
 * write is refused rather than typed into the person's hands; handing back is when it learns from
 * what was shown (INV-404, INV-406).
 */
function deskControls(agent) {
  var box = el("div", "desk"), id = agent.id, mine = !!screen2.mine[id], recording = !!screen2.recording[id];
  var control = function (controller) { return postJson("/api/desktop/control", { agent: id, controller: controller }); };
  var hold = el("button", mine ? "act-primary" : "act", t(mine ? "ui.next.desk.handBack" : "ui.next.desk.take"));
  hold.addEventListener("click", function () {
    hold.disabled = true;
    control(mine ? "agent" : "user").then(function () {
      screen2.mine[id] = !mine;
      if (!mine) window.open(agent.desktopUrl, "_blank", "noopener");
      toast(t(mine ? "ui.next.desk.handedBack" : "ui.next.desk.taken", { name: agent.name })); renderScreen();
    }, function (error) { hold.disabled = false; failed(error); });
  });
  var record = el("button", "act", t(recording ? "ui.next.desk.stopRecording" : "ui.next.desk.record"));
  record.addEventListener("click", function () {
    record.disabled = true;
    postJson("/api/record", { agent: id, action: recording ? "stop" : "start" }).then(function (got) {
      screen2.recording[id] = !recording;
      toast(t(recording ? "ui.next.desk.recorded" : "ui.next.desk.recordingNow", { file: (got && got.file) || "" })); renderScreen();
    }, function (error) { record.disabled = false; failed(error); });
  });
  var text = el("input"), paste = el("button", "act", t("ui.next.desk.paste")), copy = el("button", "act", t("ui.next.desk.copy"));
  text.placeholder = t("ui.next.desk.pastePlaceholder");
  paste.addEventListener("click", function () {
    if (!text.value) return;
    postJson("/api/clipboard", { agent: id, text: text.value }).then(function () { text.value = ""; toast(t("ui.next.desk.pasted")); }, failed);
  });
  copy.addEventListener("click", function () {
    postJson("/api/clipboard", { agent: id }).then(function (got) {
      var held = String((got && got.text) || "");
      text.value = held;
      // The press is the gesture the browser wants before it lets a page write the clipboard.
      if (held && navigator.clipboard) navigator.clipboard.writeText(held).then(function () { toast(t("ui.next.msg.copied")); }, function () {});
    }, failed);
  });
  // Kept: the desktop is not reclaimed while idle, for something left open on it on purpose.
  var pinned = !!screen2.pinned[id], pin = el("button", "act", t(pinned ? "ui.next.desk.unpin" : "ui.next.desk.pin"));
  pin.addEventListener("click", function () {
    pin.disabled = true;
    postJson("/api/desktop/pin", { agent: id, pinned: !pinned }).then(function () { screen2.pinned[id] = !pinned; renderScreen(); }, function (error) { pin.disabled = false; failed(error); });
  });
  var hands = el("div", "acts"), clip2 = el("div", "acts");
  hands.appendChild(hold); hands.appendChild(record); hands.appendChild(pin);
  clip2.appendChild(text); clip2.appendChild(paste); clip2.appendChild(copy);
  box.appendChild(hands); if (mine) box.appendChild(el("p", "why", t("ui.next.desk.mineNote", { name: agent.name }))); box.appendChild(clip2);
  return box;
}

function screenStart() {
  $("screen-toggle").addEventListener("click", function () { screen2.open = !screen2.open; renderScreen(); });
  $("screen-close").addEventListener("click", function () { screen2.open = false; renderScreen(); });
  document.querySelectorAll("[data-screen]").forEach(function (button) {
    button.addEventListener("click", function () { screen2.tab = button.dataset.screen; if (screen2.tab === "files") loadFiles(screen2.dir); else renderScreen(); });
  });
}
`;
