export const NEXT_FILES_JS = `
var workFiles = { box: "", dir: "", root: "", entries: [], loading: false, error: "", request: 0 };

function readWorkFiles(box, dir) {
  var request = ++workFiles.request;
  if (workFiles.box !== box) workFiles.root = "";
  workFiles.box = box; workFiles.dir = dir; workFiles.loading = true; workFiles.error = ""; workFiles.entries = [];
  getJson("/api/files?boxId=" + encodeURIComponent(box) + (dir ? "&dir=" + encodeURIComponent(dir) : "")).then(function (result) {
    if (request !== workFiles.request) return;
    workFiles.root = result.root; workFiles.dir = result.path; workFiles.entries = result.entries;
    workFiles.loading = false; if (next.view === "files") render();
  }, function (error) {
    if (request !== workFiles.request) return;
    workFiles.error = error.message; workFiles.loading = false; if (next.view === "files") render();
  });
}

function workFileType(entry) {
  if (entry.type === "symlink" && entry.target_in_work === true) return entry.target_type;
  return entry.type;
}

function renderFiles(view) {
  var available = boxes.list, active = boxById(workFiles.box);
  if (!active) {
    active = boxById(chat.box) || available[0];
    if (!active) {
      if (workFiles.box) { workFiles.request++; workFiles.box = ""; workFiles.entries = []; }
      view.appendChild(el("p", "empty", t("ui.next.files.noBoxes"))); return;
    }
    readWorkFiles(active.id, "");
  }
  var list = el("div", "list"), controls = el("div", "acts"), label = el("label", "", t("ui.next.files.box") + " ");
  list.classList.add("setting");
  var select = el("select"), refresh = el("button", "act", t("ui.next.files.refresh"));
  available.forEach(function (box) {
    var pick = el("option", "", box.name); pick.value = box.id; pick.selected = box.id === active.id;
    select.appendChild(pick);
  });
  select.addEventListener("change", function () { readWorkFiles(select.value, ""); render(); });
  refresh.addEventListener("click", function () { readWorkFiles(active.id, workFiles.dir); render(); });
  refresh.disabled = workFiles.loading;
  label.appendChild(select); controls.appendChild(label); controls.appendChild(refresh); list.appendChild(controls);
  var folder = workFiles.dir;
  if (folder && workFiles.root && folder !== workFiles.root) {
    var parent = el("button", "act", t("ui.next.files.parent"));
    parent.addEventListener("click", function () {
      readWorkFiles(active.id, folder.slice(0, folder.lastIndexOf("/")) || workFiles.root); render();
    });
    controls.appendChild(parent);
    list.appendChild(el("p", "why", folder.slice(workFiles.root.length)));
  }
  if (workFiles.loading || workFiles.error) {
    list.appendChild(el("p", "why", workFiles.loading ? t("ui.next.auto.reading") : workFiles.error));
  } else {
    var entries = workFiles.entries.filter(function (entry) {
      var type = workFileType(entry);
      return type === "directory" || type === "file";
    });
    if (!entries.length) list.appendChild(el("p", "why", t("ui.next.screen.empty")));
    entries.forEach(function (entry) {
      var path = folder.replace(/\\/$/, "") + "/" + entry.name;
      if (workFileType(entry) === "directory") {
        var open = el("button", "file", entry.name + "/");
        open.addEventListener("click", function () { readWorkFiles(active.id, path); render(); });
        list.appendChild(open);
      } else {
        var row = el("div", "file"), name = el("span", "", entry.name + (entry.type === "file" ? " · " + bytes(entry.size) : ""));
        var keep = el("a", "act", t("ui.next.template.download"));
        keep.href = "/api/file?boxId=" + encodeURIComponent(active.id) + "&path=" + encodeURIComponent(path);
        keep.setAttribute("aria-label", t("ui.next.files.download", { name: entry.name }));
        row.appendChild(name); row.appendChild(keep); list.appendChild(row);
      }
    });
  }
  view.appendChild(list);
}
`;
