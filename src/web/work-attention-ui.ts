/** Communications are evidence alongside a conversation, not interruptions inside its prose. */
export const WORK_ATTENTION_HTML = `<div id="currentwork" role="status" hidden></div>
<details id="communications" hidden><summary id="communications-summary"></summary><div id="communications-list"></div></details>`;
export const WORK_ATTENTION_STYLE = `
#currentwork, #communications { flex: 0 0 auto; min-width: 0; border-bottom: 1px solid var(--border); padding: 8px 18px; font-size: 12px; overflow-wrap: anywhere; }
#currentwork { color: var(--text-soft); }
#communications { color: var(--muted); }
#communications summary { cursor: pointer; }
#communications-list { max-height: min(240px, 28vh); overflow: auto; }
#communications-list article { padding: 8px 0; border-top: 1px solid var(--border); }
#communications-list p { white-space: pre-wrap; margin: 4px 0; color: var(--text-soft); }
#communications[hidden], #currentwork[hidden] { display: none; }
`;
export const WORK_ATTENTION_JS = `
var communicationRows = [], communicationTotal = 0, communicationPaint = false;
function renderCommunications() {
  var panel = $("communications");
  panel.hidden = !communicationTotal;
  $("communications-summary").textContent = "{{ui.work.communications}} · " + communicationTotal + " · {{ui.work.latest}} 50";
  if (!panel.open) return;
  var list = $("communications-list"); list.replaceChildren();
  communicationRows.forEach(function (row) {
    var item = document.createElement("article"), label = document.createElement("b"), text = document.createElement("p");
    label.textContent = row.label; text.textContent = row.text;
    item.appendChild(label); item.appendChild(text); list.appendChild(item);
  });
}
function recordCommunication(row) {
  communicationTotal++; communicationRows.push(row); communicationRows = communicationRows.slice(-50);
  if (!communicationPaint) { communicationPaint = true; queueMicrotask(function () { communicationPaint = false; renderCommunications(); }); }
}
function resetCommunications() {
  communicationRows = []; communicationTotal = 0;
  $("communications").open = false; $("communications").hidden = true; $("communications-list").replaceChildren();
  $("currentwork").hidden = true; $("currentwork").textContent = "";
}
$("communications").addEventListener("toggle", renderCommunications);
function showCurrentWork(attention) {
  var node = $("currentwork"); node.hidden = !attention || attention.status === "answered";
  if (node.hidden) { node.textContent = ""; return; }
  var label = attention.status === "waiting" ? "{{ui.work.waiting}}" : "{{ui.work.running}}";
  var reasons = {"waiting for confirmation":"{{ui.work.confirmationPending}}","unfinished plan":"{{ui.work.planPending}}", "waiting for related work":"{{ui.work.collaborationPending}}", "execution interrupted":"{{ui.work.interrupted}}", "failed":"{{ui.work.failed}}", "aborted":"{{ui.work.interrupted}}", "incomplete":"{{ui.work.incomplete}}"};
  var reason = attention.reason && attention.reason.indexOf("required tool unavailable:") === 0 ? "{{ui.work.toolMissing}}" : reasons[attention.reason] || attention.reason;
  node.textContent = label + (reason ? " · " + reason : "") + (attention.held ? " · {{ui.work.held}} " + attention.held : "");
}
`;
