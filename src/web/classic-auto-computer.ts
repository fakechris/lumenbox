export const CLASSIC_AUTO_COMPUTER_HTML = `
<div id="autocomputer" style="display:none;padding:12px 16px" role="status">
  <strong id="autocomputer-title"></strong><p class="dim" id="autocomputer-help"></p>
  <a class="btn sm ghost" id="autocomputers" href="/?ui=next&amp;once=1&amp;view=boxes" target="_blank" rel="noopener">{{ui.auto.openComputers}}</a>
</div>`;

export const CLASSIC_AUTO_COMPUTER_JS = `
function renderAutoComputer() {
  $("autonew").style.display = boxState.connected ? "" : "none";
  $("autocomputer").style.display = (autoCreateOpen ? autoComputerLost : !boxState.connected) ? "" : "none";
  $("autocomputer-title").textContent = autoComputerLost ? "{{ui.auto.computerLost}}" : "{{ui.auto.needsComputer}}";
  $("autocomputer-help").textContent = autoComputerLost ? "{{ui.auto.computerRetry}}" : "{{ui.auto.computerHelp}}";
}
$("autocomputers").addEventListener("click", function (event) {
  if (myRole === "admin") { event.preventDefault(); openSettings("boxes"); }
});
document.getElementById("autonew").addEventListener("click", function (e) {
  e.preventDefault();
  if (!boxState.connected && !autoCreateOpen) return;
  autoCreateOpen = !autoCreateOpen;
  $("autocreate").style.display = autoCreateOpen ? "" : "none";
  if (autoCreateOpen) {
    $("autoagent").innerHTML = '<option value="">{{ui.app.first-agent}}</option>';
  }
  renderAutoComputer();
});
`;
