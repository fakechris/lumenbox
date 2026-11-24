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
`;
