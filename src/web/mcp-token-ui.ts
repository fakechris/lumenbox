export const MCP_TOKEN_JS = `
var mcpSetup, myIdentity;
function renderMcpSetup(needsPerson) {
  var notice = $("setmcpsetup");
  notice.textContent = "";
  var uninitialized = myIdentity === null && mcpSetup && mcpSetup.admins === 0;
  if (!uninitialized && !needsPerson) return;
  if (uninitialized && mcpSetup.bootstrap) {
    notice.appendChild(document.createTextNode("{{ui.mcp.owner-needed}} "));
    var link = document.createElement("a");
    link.href = "/bootstrap"; link.textContent = "{{ui.mcp.first-admin}}";
    notice.appendChild(link);
    notice.appendChild(document.createTextNode(" {{ui.mcp.bootstrap-code}}"));
  } else notice.textContent = "{{ui.mcp.sign-in}}";
}

function renderMcpTokens(tokens) {
  var mine = (tokens || []).filter(function (t) { return t.mine; });
  $("setmcptokens").innerHTML = mine.length
    ? mine.map(function (t) {
        return '<div style="display:flex;gap:8px;align-items:center;font-size:13px">' +
          '<span style="flex:1">' + esc(t.label) + "</span>" +
          '<span class="dim" style="font-size:11px">' + esc(new Date(t.createdAt).toLocaleDateString()) + "</span>" +
          '<a href="#" data-revoke="' + esc(t.createdAt) + '" style="color:var(--danger);font-size:12px">{{ui.app.revoke}}</a></div>';
      }).join("")
    : '<div class="fieldnote" style="margin:0">{{ui.app.none-yet}}</div>';
}

$("setmcpadd").onclick = function () {
  fetch("/api/mcp/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: $("setmcplabel").value })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.code === "token-needs-person") { $("setmcpnew").textContent = ""; renderMcpSetup(true); return; }
      $("setmcpnew").textContent = d.token
        ? "{{ui.app.copy-it-now-it-is}} " + d.token
        : (d.error || "{{ui.app.failed}}");
      $("setmcplabel").value = "";
      renderMcp();
    })
    .catch(function () { $("setmcpnew").textContent = "{{ui.app.failed}}"; });
};

document.getElementById("setmcptokens").addEventListener("click", function (event) {
  var at = event.target.getAttribute && event.target.getAttribute("data-revoke");
  if (!at) return;
  event.preventDefault();
  fetch("/api/mcp/tokens/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ createdAt: at })
  }).then(renderMcp);
});
`;
