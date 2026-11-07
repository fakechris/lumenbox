/**
 * Settings → Team → Team memory (INV-1581): the review switch, and what waits for a person, each
 * saying who reads it once approved. Settings → Memory: what is already live on every box (INV-1722).
 */

export const TEAM_MEMORY_REVIEW_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw Object.assign(new Error(d.error || ("HTTP " + r.status)), { data: d }); return d; }); });
  }
  var toggle, list, note, everyone;
  function renderEveryone(d) {
    if (!everyone) return;
    everyone.textContent = "";
    var lines = d.everyone || [];
    if (lines.length === 0) { everyone.appendChild(el("div", { class: "fieldnote" }, "{{ui.team-memory-review.nothing-is-shared-with-every-box}}")); return; }
    lines.forEach(function (line) {
      var row = el("div", { class: "ui-list-row", "data-everyone-memory": "1" });
      row.appendChild(el("span", { class: "ui-grow", title: line.text }, line.writerName + " (" + line.boxName + "): " + line.text));
      row.appendChild(el("span", { class: "dim" }, (line.at || "").slice(0, 10)));
      everyone.appendChild(row);
    });
  }
  function render(d) {
    renderEveryone(d);
    toggle.checked = !!d.on;
    list.textContent = "";
    var pending = d.pending || [];
    if (pending.length === 0) { list.appendChild(el("div", { class: "fieldnote" }, d.on ? "{{ui.team-memory-review.nothing-is-waiting}}" : "")); return; }
    pending.forEach(function (item) {
      var row = el("div", { class: "ui-list-row", "data-team-review": item.writer + ":" + item.version });
      row.appendChild(el("span", { class: "ui-grow", title: item.text }, item.writerName + ": " + item.text));
      row.appendChild(el("span", { class: "dim", "data-audience": item.audience }, item.audience === "everyone" ? "{{ui.team-memory-review.every-box}}" : item.boxName));
      row.appendChild(el("span", { class: "dim" }, (item.at || "").slice(0, 10)));
      [["approved", "{{ui.team-memory-review.approve}}"], ["rejected", "{{ui.team-memory-review.reject}}"]].forEach(function (pair) {
        var b = el("button", { class: "btn", "data-decision": pair[0] }, pair[1]);
        b.onclick = function () {
          b.disabled = true;
          call("POST", "/api/memory/team-review/decide", { writer: item.writer, version: item.version, decision: pair[0] })
            .then(function (d) { note.textContent = pair[0] === "approved" ? "{{ui.team-memory-review.approved-every-agent-has-it}}" : "{{ui.team-memory-review.rejected-no-agent-will-see}}"; render(d); })
            .catch(function (e) { note.textContent = e.message; if (e.data) render(e.data); });
        };
        row.appendChild(b);
      });
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/memory/team-review").then(render).catch(function () {}); }
  function mountEveryone(modal, actions) {
    var field = el("div", { class: "field settab-off", "data-settab": "memory", id: "everyonememory" });
    field.appendChild(el("label", {}, "{{ui.team-memory-review.memory-for-every-box}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.team-memory-review.agents-promoted-these-to-every-box}}"));
    everyone = el("div", { id: "everyonememorylist", class: "ui-gap" });
    field.appendChild(everyone);
    modal.insertBefore(field, actions);
  }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("teammemoryreview")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "teammemoryreview" });
    field.appendChild(el("label", {}, "{{ui.team-memory-review.team-memory}}"));
    var line = el("div", { class: "ui-row", style: "flex-wrap:nowrap;align-items:flex-start" });
    toggle = el("input", { type: "checkbox", id: "teammemoryreviewon", style: "height:auto;margin-top:3px;flex:none" });
    line.appendChild(toggle);
    line.appendChild(el("span", { style: "flex:1;min-width:0" }, "{{ui.team-memory-review.review-first-an-agents-write}}"));
    field.appendChild(line);
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.team-memory-review.every-agent-reads-the-teams}}"));
    list = el("div", { id: "teammemoryreviewlist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "teammemoryreviewnote" }, "");
    field.appendChild(list); field.appendChild(note);
    toggle.onchange = function () {
      call("POST", "/api/memory/team-review/setting", { on: toggle.checked }).then(function (d) { note.textContent = d.on ? "{{ui.team-memory-review.on-new-team-writes-wait}}" : "{{ui.team-memory-review.off-team-writes-are-shared}}"; render(d); }).catch(function (e) { note.textContent = e.message; refresh(); });
    };
    modal.insertBefore(field, actions);
    mountEveryone(modal, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); var tab = a && a.getAttribute("data-settab"); if (tab === "team" || tab === "memory") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
