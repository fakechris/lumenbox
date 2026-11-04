/**
 * Settings → Team → Agents: pause and resume (INV-1554), and a "paused" tag in the sidebar.
 * Its own script, like the other settings sections: the page is at its size ceiling.
 */

export const AGENT_PAUSE_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var list, note, paused = {};
  function tagSidebar() {
    var rows = document.querySelectorAll(".agent[data-id]");
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute("data-id"), tag = rows[i].querySelector(".pausetag");
      if (paused[id] && !tag) rows[i].appendChild(el("span", { class: "pausetag dim ui-badge", title: "Paused by " + paused[id].by + (paused[id].reason ? ": " + paused[id].reason : "") }, "paused"));
      if (!paused[id] && tag) tag.remove();
    }
  }
  function render() {
    if (!list) return;
    list.textContent = "";
    var all = (window.agents || []).slice().sort(function (a, b) { return (paused[b.id] ? 1 : 0) - (paused[a.id] ? 1 : 0); });
    all.forEach(function (a) {
      var p = paused[a.id];
      var row = el("div", { class: "ui-list-row" });
      row.appendChild(el("span", { class: "ui-w-md" }, a.name));
      row.appendChild(el("span", { class: "ui-grow dim" }, p ? "Paused by " + p.by + (p.reason ? ": " + p.reason : "") : "Running"));
      var b = el("button", { class: "btn", "data-pause": a.id }, p ? "Resume" : "Pause");
      b.onclick = function () {
        if (p) { call("POST", "/api/agents/resume", { id: a.id }).then(refresh).catch(function (e) { note.textContent = e.message; }); return; }
        window.askInline(b, "Pause " + a.name + "? Its turn stops, its background jobs stop, and nothing starts it until someone resumes it. Why (optional):", "").then(function (reason) {
          if (reason === null) return;
          call("POST", "/api/agents/pause", { id: a.id, reason: reason }).then(function (d) { note.textContent = a.name + " paused" + (d.jobsStopped && d.jobsStopped.length ? "; " + d.jobsStopped.length + " background job(s) stopped." : "."); refresh(); }).catch(function (e) { note.textContent = e.message; });
        });
      };
      row.appendChild(b);
      list.appendChild(row);
    });
  }
  function refresh() { return call("GET", "/api/agents/pauses").then(function (d) { paused = d.paused || {}; render(); tagSidebar(); }).catch(function () {}); }
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("agentpauses")) return false;
    var actions = modal.querySelector(".actions");
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "agentpauses" });
    field.appendChild(el("label", {}, "Agents"));
    field.appendChild(el("div", { class: "fieldnote" }, "Pause stops an agent and keeps it stopped: no turn starts for it, its background jobs stop, and messages to it wait until someone resumes it. Stop, in the chat, only ends the turn in flight."));
    list = el("div", { id: "agentpauselist", class: "ui-gap" });
    note = el("div", { class: "fieldnote", id: "agentpausenote" }, "");
    field.appendChild(list); field.appendChild(note);
    modal.insertBefore(field, actions);
    document.getElementById("settabs").addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "team") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setInterval(function () { refresh(); }, 30000);
  setTimeout(refresh, 2000);
})();
`;
