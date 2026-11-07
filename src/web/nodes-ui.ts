/**
 * Settings → Boxes → Nodes (INV-1697, docs/96 §4): the organisation's nodes, each with its boxes,
 * whether each is connected, when the node was last heard, and Revoke. A node's native environment
 * joins with nobody in it; "Open to members" asks the server, which refuses while the box's commands
 * are not running inside the OS sandbox (INV-1700). Drawn only for an Admin of an organisation: a
 * personal installation has no nodes, and `GET /api/nodes` says so.
 *
 * Nothing here enrols a node. A node is enrolled on its own machine, by an Admin signing in to the
 * organisation there; this list shows the result and is where it is undone.
 */

export const NODES_JS = `(function () {
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var field, list, note;
  var STATE = { connected: "{{ui.nodes.connected}}", offline: "{{ui.nodes.offline}}", revoked: "{{ui.nodes.revoked}}" };
  var KIND = { native: "{{ui.nodes.native}}", docker: "{{ui.nodes.docker}}" };
  function when(at) { return at ? new Date(at).toLocaleString() : "{{ui.nodes.never}}"; }
  function render(nodes) {
    list.textContent = "";
    if (nodes.length === 0) { list.appendChild(el("div", { class: "dim" }, "{{ui.nodes.none}}")); return; }
    nodes.forEach(function (n) {
      var head = el("div", { class: "ui-list-row", "data-node": n.name });
      head.appendChild(el("b", { class: "ui-grow" }, n.name));
      head.appendChild(el("span", { class: "dim" }, (n.revoked ? "{{ui.nodes.revoked}}" : "{{ui.nodes.last-heard}} " + when(n.lastSeenAt))));
      if (!n.revoked) {
        var revoke = el("button", { class: "btn sm ghost", type: "button", "data-node-revoke": n.id }, "{{ui.nodes.revoke}}");
        revoke.onclick = function () {
          if (revoke.getAttribute("data-sure") !== "1") { revoke.setAttribute("data-sure", "1"); revoke.textContent = "{{ui.nodes.revoke-sure}}"; return; }
          call("POST", "/api/nodes/revoke", { node: n.id }).then(function () { note.textContent = "{{ui.nodes.revoked-note}}"; refresh(); }).catch(function (e) { note.textContent = e.message; });
        };
        head.appendChild(revoke);
      }
      list.appendChild(head);
      n.boxes.forEach(function (b) {
        var row = el("div", { class: "ui-list-row", style: "margin-left:16px", "data-node-box": b.name, "data-state": b.state });
        row.appendChild(el("span", { class: "dot", style: "width:8px;height:8px;background:" + (b.state === "connected" ? "var(--ok, #3fb950)" : "var(--warn)") }));
        row.appendChild(el("span", { class: "ui-grow" }, b.name + " · " + (KIND[b.kind] || b.kind) + (b.screen ? " · {{ui.nodes.screen}}" : "") + " · " + (STATE[b.state] || b.state)));
        if (b.kind === "native" && b.state !== "revoked") {
          var closed = Array.isArray(b.members) && b.members.length === 0;
          row.appendChild(el("span", { class: "dim" }, closed ? "{{ui.nodes.native-closed}}" : "{{ui.nodes.native-open}}"));
          if (closed) {
            var open = el("button", { class: "btn sm ghost", type: "button", "data-node-open": b.name }, "{{ui.nodes.open-to-members}}");
            open.onclick = function () { call("POST", "/api/boxes/update", { name: b.name, members: "everyone" }).then(function () { note.textContent = "{{ui.nodes.opened}}"; refresh(); }).catch(function (e) { note.textContent = e.message; }); };
            row.appendChild(open);
          }
        }
        list.appendChild(row);
      });
    });
  }
  function refresh() {
    return call("GET", "/api/nodes").then(function (d) { field.style.display = ""; render(d.nodes || []); }).catch(function () { field.style.display = "none"; });
  }
  function mount() {
    var boxes = document.getElementById("setboxeswrap");
    if (!boxes || document.getElementById("setnodes")) return false;
    field = el("div", { class: "field settab-off", "data-tier": "installation", "data-settab": "boxes", id: "setnodes" });
    field.style.display = "none";
    field.appendChild(el("label", {}, "{{ui.nodes.title}}"));
    field.appendChild(el("div", { class: "fieldnote" }, "{{ui.nodes.lead}}"));
    list = el("div", { id: "setnodelist", class: "ui-gap" });
    field.appendChild(list);
    note = el("div", { class: "fieldnote", id: "setnodesnote", role: "status" }, "");
    field.appendChild(note);
    boxes.parentNode.insertBefore(field, boxes.nextSibling);
    var tabs = document.getElementById("settabs");
    if (tabs) tabs.addEventListener("click", function (event) { var a = event.target.closest("a[data-settab]"); if (a && a.getAttribute("data-settab") === "boxes") refresh(); });
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
  setTimeout(function () { if (field) refresh(); }, 2000);
})();
`;
