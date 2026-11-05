/** Settings → Team → Team memory (INV-1581): the review switch, and what waits for a person. */

export const TEAM_MEMORY_REVIEW_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw Object.assign(new Error(d.error || ("HTTP " + r.status)), { data: d }); return d; }); });
  }
  var toggle, list, note;
  function render(d) {
    toggle.checked = !!d.on;
    list.textContent = "";
    var pending = d.pending || [];
    if (pending.length === 0) { list.appendChild(el("div", { class: "fieldnote" }, d.on ? "Nothing is waiting." : "")); return; }
    pending.forEach(function (item) {
      var row = el("div", { class: "ui-list-row", "data-team-review": item.writer + ":" + item.version });
      row.appendChild(el("span", { class: "ui-grow", title: item.text }, item.writerName + ": " + item.text));
      row.appendChild(el("span", { class: "dim" }, (item.at || "").slice(0, 10)));
      [["approved", "Approve"], ["rejected", "Reject"]].forEach(function (pair) {
        var b = el("button", { class: "btn", "data-decision": pair[0] }, pair[1]);
        b.onclick = function () {
          b.disabled = true;
          call("POST", "/api/memory/team-review/decide", { writer: item.writer, version: item.version, decision: pair[0] })
            .then(function (d) { note.textContent = pair[1] === "Approve" ? "Approved: every agent has it on its next turn." : "Rejected: no agent will see it."; render(d); })
            .catch(function (e) { note.textContent = e.message; if (e.data) render(e.data); });
        };
        row.appendChild(b);
      });
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/memory/team-review").then(render).catch(function () {}); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("teammemoryreview")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "teammemoryreview" });
    field.appendChild(el("label", {}, "Team memory"));
    var line = el("div", { class: "ui-row", style: "flex-wrap:nowrap;align-items:flex-start" });
    toggle = el("input", { type: "checkbox", id: "teammemoryreviewon", style: "height:auto;margin-top:3px;flex:none" });
    line.appendChild(toggle);
    line.appendChild(el("span", { style: "flex:1;min-width:0" }, "Review first: an agent's write to the team's shared memory waits for an admin's approval"));
    field.appendChild(line);
    field.appendChild(el("div", { class: "fieldnote" }, "Every agent reads the team's memory, including agents working on a schedule while nobody watches. With this on, what an agent shares reaches the others only after an admin approves it here; an agent's own memory is not affected."));
    list = el("div", { id: "teammemoryreviewlist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "teammemoryreviewnote" }, "");
    field.appendChild(list); field.appendChild(note);
    toggle.onchange = function () {
      call("POST", "/api/memory/team-review/setting", { on: toggle.checked }).then(function (d) { note.textContent = d.on ? "On: new team writes wait for approval." : "Off: team writes are shared at once, as before."; render(d); }).catch(function (e) { note.textContent = e.message; refresh(); });
    };
    modal.insertBefore(field, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "team") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(refresh, 2000);
})();
`;
