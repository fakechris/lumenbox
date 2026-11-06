/**
 * Settings → Boxes → the box's image and Apply update (INV-1538). Its own script, like the
 * Supervision tab: the page is at its size ceiling, and this section only talks to /api/box/image
 * and /api/box/reset. It says which image the box runs and which this app expects, updates the box
 * (waiting for work in progress unless told not to), shows the progress, and keeps Reset apart:
 * reset removes what agents made and every browser login, and asks for the box's name in a field
 * on the page — the desktop app has no prompt().
 */

export const BOX_UPDATE_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var ui = {}, timer = null;
  function short(ref) { return ref ? String(ref).replace(/^sha256:/, "").slice(0, 40) : "{{ui.box-update.no-box}}"; }
  function render(d) {
    var s = d.state;
    if (!s) { ui.line.textContent = "{{ui.box-update.the-boxs-image-could-not}}"; return; }
    ui.line.textContent = "{{ui.box-update.runs}} " + short(s.runningRef) + "{{ui.box-update.this-app-expects}} " + short(s.expectedRef) + (s.available ? " {{ui.box-update.an-update-is-available}}" + (s.needsPull ? " {{ui.box-update.it-will-be-downloaded-first}}" : "") + "." : " {{ui.box-update.up-to-date}}");
    ui.apply.disabled = d.running || !s.available;
    ui.now.style.display = d.running || !s.available ? "none" : "";
    ui.apply.textContent = d.running ? "{{ui.box-update.updating}}" : "{{ui.box-update.apply-update}}";
    var lines = d.progress.slice();
    if (d.last && !d.running) lines.push(d.last.outcome + ": " + d.last.detail);
    ui.progress.textContent = lines.join("\\n");
    ui.progress.style.display = lines.length ? "block" : "none";
    if (d.running && !timer) timer = setInterval(load, 3000);
    if (!d.running && timer) { clearInterval(timer); timer = null; }
  }
  function showLimits(d, said) {
    // Not while somebody is typing: the image poll calls this every few seconds.
    if (!said && (ui.cpusDirty || document.activeElement === ui.cpus)) return;
    ui.cpusDirty = false;
    ui.cpus.value = d.chosen || (d.limit !== null ? String(d.limit) : "");
    ui.cpusOf.textContent = d.engine ? "{{ui.box-update.of}} " + d.engine + " {{ui.box-update.cores}}" : "{{ui.box-update.cores}}";
    ui.cpus.disabled = d.fromEnvironment; ui.cpus.parentNode.querySelector("button").disabled = d.fromEnvironment;
    ui.cpusNote.textContent = d.notApplied || (d.fromEnvironment ? "{{ui.box-update.set-by-agentbox-cpus-in}}" :
      (said ? said + " " : "") + "{{ui.box-update.agents-work-in-the-box}}" + (d["default"] ? " (" + d["default"] + ")" : "") + "{{ui.box-update.empty-means-the-default-a}}");
  }
  function load() {
    call("GET", "/api/box/limits").then(function (d) { showLimits(d); }).catch(function () {}); call("GET", "/api/box/image").then(render).catch(function (e) { ui.line.textContent = e.message; }); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    var tabs = document.getElementById("settabs");
    if (!modal || !tabs || document.getElementById("boxupdate")) return false;
    var fields = modal.querySelectorAll('.field[data-settab="boxes"]');
    var anchor = fields.length ? fields[fields.length - 1] : null;
    var wrap = el("div", { class: "field settab-off", "data-settab": "boxes", id: "boxupdate" });
    wrap.appendChild(el("label", {}, "{{ui.box-update.box-image}}"));
    ui.line = el("div", { class: "fieldnote", id: "boxupdateline" }, "…");
    var row = el("div", { class: "ui-row ui-gap" });
    ui.apply = el("button", { class: "btn", id: "boxupdateapply" }, "{{ui.box-update.apply-update}}");
    var check = el("a", { href: "#", class: "ui-link" }, "{{ui.box-update.check-again}}");
    // Apply update waits for work in progress; Update now interrupts it, after saying so (INV-1551).
    ui.now = el("a", { href: "#", id: "boxupdatenow", class: "ui-link" }, "{{ui.box-update.update-now-2}}");
    ui.backup = el("input", { type: "checkbox", id: "boxupdatebackup" });
    row.appendChild(ui.apply); row.appendChild(ui.now); row.appendChild(check);
    row.appendChild(ui.backup); row.appendChild(el("span", { class: "dim" }, "{{ui.box-update.back-up-the-boxs-files}}"));
    var nowAsk = el("div", { id: "boxupdatenowask", class: "ui-gap", style: "display:none" });
    nowAsk.appendChild(el("div", { class: "fieldnote" }, "{{ui.box-update.updating-now-does-not-wait}}"));
    var nowGo = el("button", { class: "btn", id: "boxupdatenowgo" }, "{{ui.box-update.update-now}}");
    nowAsk.appendChild(nowGo);
    var note = el("div", { class: "fieldnote" }, "{{ui.box-update.apply-update-waits-until-work}}");
    ui.progress = el("pre", { id: "boxupdateprogress", class: "ui-log", style: "display:none" });
    var reset = el("a", { href: "#", class: "ui-link danger", id: "boxreset" }, "{{ui.box-update.reset-the-box}}");
    var ask = el("div", { id: "boxresetask", class: "ui-gap", style: "display:none" });
    ask.appendChild(el("div", { class: "fieldnote" }, "{{ui.box-update.reset-makes-a-new-empty}}"));
    var askName = el("input", { type: "text", id: "boxresetname", placeholder: "agentbox-box", class: "ui-w-md" });
    var askGo = el("button", { class: "btn", id: "boxresetgo" }, "{{ui.box-update.reset}}");
    ask.appendChild(askName); ask.appendChild(askGo);
    // How much of this machine the box may use (INV-1552): changed in place, no restart.
    var cpuRow = el("div", { class: "ui-row ui-gap", id: "boxcpus" });
    cpuRow.appendChild(el("span", { class: "dim" }, "{{ui.box-update.the-box-may-use-up}}"));
    ui.cpus = el("input", { type: "number", min: "0.5", step: "0.5", id: "boxcpusinput", class: "ui-w-sm" });
    ui.cpusOf = el("span", { class: "dim", id: "boxcpusof" }, "");
    var cpuSave = el("button", { class: "btn", id: "boxcpussave" }, "{{ui.box-update.save}}");
    ui.cpus.oninput = function () { ui.cpusDirty = true; };
    cpuRow.appendChild(ui.cpus); cpuRow.appendChild(ui.cpusOf); cpuRow.appendChild(cpuSave);
    ui.cpusNote = el("div", { class: "fieldnote", id: "boxcpusnote" }, "");
    wrap.appendChild(ui.line); wrap.appendChild(row); wrap.appendChild(nowAsk); wrap.appendChild(note); wrap.appendChild(ui.progress); wrap.appendChild(cpuRow); wrap.appendChild(ui.cpusNote); wrap.appendChild(reset); wrap.appendChild(ask);
    cpuSave.onclick = function () {
      var v = ui.cpus.value.trim();
      call("POST", "/api/box/limits", { cpus: v === "" ? null : v }).then(function (d) { showLimits(d, "{{ui.box-update.saved}}"); }).catch(function (e) { ui.cpusNote.textContent = e.message; });
    };
    modal.insertBefore(wrap, anchor ? anchor.nextSibling : null);
    ui.apply.onclick = function () {
      ui.apply.disabled = true;
      call("POST", "/api/box/image/update", { whenIdle: true, backup: ui.backup.checked }).then(load).catch(function (e) { ui.line.textContent = e.message; ui.apply.disabled = false; });
    };
    ui.now.onclick = function (e) { e.preventDefault(); nowAsk.style.display = nowAsk.style.display === "none" ? "block" : "none"; };
    nowGo.onclick = function () {
      nowAsk.style.display = "none";
      call("POST", "/api/box/image/update", { interrupt: true, backup: ui.backup.checked }).then(load).catch(function (e) { ui.line.textContent = e.message; });
    };
    check.onclick = function (e) { e.preventDefault(); call("POST", "/api/box/image/check").then(render).catch(function (x) { ui.line.textContent = x.message; }); };
    reset.onclick = function (e) { e.preventDefault(); ask.style.display = ask.style.display === "none" ? "block" : "none"; };
    askGo.onclick = function () {
      var name = askName.value.trim();
      if (!name) return;
      call("POST", "/api/box/reset", { confirm: name }).then(function () { ask.style.display = "none"; askName.value = ""; load(); }).catch(function (x) { ui.line.textContent = x.message; });
    };
    tabs.addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "boxes") load(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
})();
`;
