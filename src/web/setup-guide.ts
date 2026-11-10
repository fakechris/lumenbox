/** First-use guide. Used installations do not become new when a box disconnects. */
export const SETUP_GUIDE_STYLE = String.raw`
.setup-guide { margin:12px 16px 0; padding:12px; border:1px solid var(--border-strong); border-radius:var(--radius-card); background:var(--surface); }
.setup-guide-head { margin-bottom:8px; display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; }
.setup-guide-head a { text-transform:none; letter-spacing:0; }
.setup-guide-step { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:4px 0; font-size:12px; }
.setup-guide-mark { width:16px; flex:none; }
.setup-guide-copy { flex:1 1 12rem; min-width:0; overflow-wrap:anywhere; }
.setup-guide-step .btn { margin-left:auto; max-width:100%; white-space:normal; }
`;

export const SETUP_GUIDE_JS = String.raw`
/** First-use guidance is separate from current connectivity (INV-1795). */
var guideForced = false, setupDismissed = {};
function refreshSetup() {
  return fetch("/api/setup").then(function (r) { return r.json(); }).then(function (s) {
    var card = $("setupcard");
    if (!card) return;
    // Each step also names the command that does the same thing (INV-542): an
    // installation run on a server has no window to click in, and the person setting it
    // up over ssh was reading a page that assumed a mouse.
    // The key goes first (INV-857), because the welcome note promises it as one of two
    // things and every later step is dead without it: an agent with no key cannot say
    // its first word, and the failure surfaced pages away from the cause.
    // The optional steps carry a skip: a card that cannot be dismissed without
    // configuring something its own label calls optional is a nag, not a guide.
    var searchSkipped = false;
    var doorSkipped = false;
    try {
      searchSkipped = localStorage.getItem("lumen-skip-search") === "1";
      doorSkipped = localStorage.getItem("lumen-skip-door") === "1";
    } catch (error) {}
    var storageKey = "lumen-setup-closed:" + s.installationId;
    var established = !!s.established;
    var dismissed = setupDismissed[storageKey];
    try { dismissed = dismissed || localStorage.getItem(storageKey) === "1"; } catch (error) {}
    var steps = [
      { done: s.key, head: t("ui.setup.key"), sub: t("ui.setup.keyWhy"), act: t("ui.setup.keyAct"), cli: "{{ui.app.settings-model}}", go: function () { openSettings("model"); } },
      { done: s.box || established, head: t("ui.setup.box"), sub: t(established && !s.box ? "ui.setup.boxOffline" : "ui.setup.boxWhy"), act: t(established ? "ui.setup.boxManage" : "ui.setup.boxAct"), cli: established ? "" : "agentbox box up", go: function () { openSettings("boxes"); } },
      { done: s.agentTurn, head: t("ui.setup.agent"), sub: t("ui.setup.agentWhy"), act: t("ui.setup.agentAct"), cli: "agentbox agent new <name>", go: openShelf },
      { done: s.search || searchSkipped, skip: "search", head: t("ui.setup.search"), sub: t("ui.setup.searchWhy"), act: t("ui.setup.searchAct"), cli: "{{ui.app.settings-model}}", go: function () { openSettings("model"); } },
      { done: s.door || doorSkipped, skip: "door", head: t("ui.setup.door"), sub: t("ui.setup.doorWhy"), act: t("ui.setup.doorAct"), cli: "{{ui.app.settings-channels-no-cli-yet}}", go: function () { openSettings("doors"); } },
      { done: s.review, head: t("ui.setup.work"), sub: t("ui.setup.workWhy"), act: t("ui.setup.workAct"), cli: "{{ui.app.agentbox-chat}} <name> \"…\"", go: function () { var tab = $("tabtasks"); if (tab) tab.click(); } }
    ];
    if ((established || dismissed || steps.every(function (x) { return x.done; })) && !guideForced) { card.style.display = "none"; return; }
    card.style.display = "";
    card.innerHTML = '<div class="setup-guide">' +
      '<div class="eyebrow setup-guide-head"><span>' + esc(t("ui.setup.title")) + '</span><a href="#" data-setup-close="1">' + esc(t("ui.setup.close")) + "</a></div>" +
      steps.map(function (x, i) {
        return '<div class="setup-guide-step">' +
          '<span class="setup-guide-mark" style="color:' + (x.done ? "var(--success)" : "var(--muted)") + '">' + (x.done ? "✓" : String(i + 1)) + "</span>" +
          '<div class="setup-guide-copy"><b>' + esc(x.head) + "</b> <span class=\"dim\">" + esc(x.sub) + "</span>" +
            (x.cli ? ' <code class="mono dim ui-tiny">' + esc(x.cli) + "</code>" : "") + "</div>" +
          (x.skip && !x.done ? '<a href="#" data-setup-skip="' + esc(x.skip) + '" class="dim ui-tiny">' + esc(t("ui.setup.skip")) + "</a>" : "") +
          '<button class="btn sm' + (x.done ? " ghost" : "") + '" data-setup="' + i + '">' + esc(x.act) + "</button>" +
        "</div>";
      }).join("") + "</div>";
    card.onclick = function (event) {
      var sk = event.target.closest("a[data-setup-skip]");
      if (sk) {
        event.preventDefault();
        try { localStorage.setItem("lumen-skip-" + sk.getAttribute("data-setup-skip"), "1"); } catch (error) {}
        refreshSetup();
        return;
      }
      var b = event.target.closest("button[data-setup]");
      if (b) { event.preventDefault(); steps[Number(b.getAttribute("data-setup"))].go(); return; }
      if (event.target.closest("a[data-setup-close]")) { event.preventDefault(); guideForced = false; setupDismissed[storageKey] = true; try { localStorage.setItem(storageKey, "1"); } catch (error) {} card.style.display = "none"; }
    };
  }).catch(function () {});
}
refreshSetup();
setInterval(refreshSetup, 30000);
$("guidebtn").onclick = function () { guideForced = true; refreshSetup(); };

`;
