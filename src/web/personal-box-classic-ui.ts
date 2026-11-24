export const PERSONAL_BOX_CLASSIC_JS = `
var personalRequestId = null, personalListed = [], personalOwner = "";
var personalPoll = null;
function personalBoxError(b) {
  return b.error || (b.status === "unreachable" ? t("ui.next.box.podUnreachable", { why: b.connectionError || t("ui.next.box.healthPending") }) : "");
}
function renderPersonalBoxes(d) {
  $("personalstatus").textContent = d.held + " {{ui.app.allocated}} " + (d.quota === null ? "{{ui.app.unlimited}}" : d.quota) + " {{ui.app.quota}}";
  var full = d.quota !== null && d.held >= d.quota;
  if (full) $("personalstatus").textContent += " · " + t("ui.personal.full");
  $("personalcreate").disabled = !d.canCreate || full;
  personalListed = d.boxes || [];
  personalOwner = d.name;
  $("personalboxes").innerHTML = (d.boxes || []).map(function (b) {
    return '<div style="padding:6px 0"><span>' + esc(b.name) + ' — ' + esc([b.podStatus, b.status].filter(Boolean).join(" · ")) + '</span>' +
      (personalBoxError(b) ? '<div class="fieldnote">' + esc(personalBoxError(b)) + '</div>' : '') +
      (['failed', 'interrupted', 'detached', 'deleting', 'unreachable'].indexOf(b.status) >= 0 ? ' <button class="btn sm" data-personal-retry="' + esc(b.id) + '">{{ui.app.retry-recover}}</button>' : '') +
      (['ready', 'failed', 'detached', 'unreachable'].indexOf(b.status) >= 0 ?
        ' <button class="btn sm ghost" data-personal-keep="' + esc(b.id) + '">{{ui.app.remove-keep-data}}</button>' +
        ' <button class="btn sm" style="color:var(--danger)" data-personal-delete="' + esc(b.id) + '">{{ui.app.delete-box-and-data}}</button>' : '') + '</div>';
  }).join('');
  clearTimeout(personalPoll);
  if ((d.boxes || []).some(function (b) { return b.status === 'provisioning' || b.status === 'deleting'; })) personalPoll = setTimeout(loadPersonalBoxes, 2000);
}
function loadPersonalBoxes() {
  if ($("shelfwrap").style.display === "none") return;
  fetch('/api/personal-boxes').then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) { $("personalstatus").textContent = d.error; $("personalcreate").disabled = true; $("personalboxes").innerHTML = ''; return; }
    renderPersonalBoxes(d);
  }).catch(function () { $("personalstatus").textContent = '{{ui.app.could-not-load-personal-boxes}}'; });
}
function personalAction(action, body) {
  var destination = $("shelfbox").value;
  $("personalstatus").textContent = '{{ui.app.working}}';
  $("personalcreate").disabled = true;
  fetch('/api/personal-boxes/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { $("personalstatus").textContent = d.error; $("personalcreate").disabled = false; return; }
      if (action === 'create') personalRequestId = null;
      renderPersonalBoxes(d);
      openShelf(destination);
    }).catch(function () { $("personalstatus").textContent = '{{ui.app.connection-interrupted-retry-uses-the}}'; $("personalcreate").disabled = false; });
}
$("personalcreate").onclick = function () {
  if (!personalRequestId) personalRequestId = personalComputerRequestId();
  personalAction('create', { requestId: personalRequestId, name: t("ui.personal.defaultName", { name: personalOwner }) });
};
$("personalboxes").onclick = function (event) {
  var button = event.target.closest('button');
  if (!button) return;
  var retry = button.getAttribute('data-personal-retry');
  var keep = button.getAttribute('data-personal-keep');
  var erase = button.getAttribute('data-personal-delete');
  if (retry) personalAction('retry', { id: retry });
  if (keep) personalAction('remove', { id: keep, deleteData: false, deleteAgents: false });
  var box = personalListed.find(function (item) { return item.id === erase; });
  if (box) deleteComputerDialog(box, function (agentIds) { personalAction('remove', { id: erase, deleteData: true, deleteAgents: agentIds.length > 0, agentIds: agentIds }); });
};
`;
