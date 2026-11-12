/**
 * What the composer offers while typing on the rebuilt page (INV-1825): a skill when the message
 * opens with "/", a colleague when a word starts with "@". Nothing shows until one of the two is
 * typed. Only at the start for "/": mid-sentence a slash is a path or a date.
 */
export const NEXT_COMPOSER_JS = `
var composer = { skills: null, rows: [], at: 0, kind: "" };

/** What is being asked for at the caret: a skill, a colleague, or nothing. */
function composerQuery(value, caret) {
  var slash = /^\\/(\\S*)$/.exec(value);
  if (slash) return { kind: "skill", query: slash[1].toLowerCase() };
  var mention = /(^|\\s)@([^\\s@]*)$/.exec(value.slice(0, caret));
  return mention ? { kind: "mention", query: mention[2].toLowerCase() } : null;
}

/** The text after a choice, and where the caret goes. A skill becomes the instruction it is. */
function composerPick(value, caret, kind, name, skillLine) {
  if (kind === "skill") return { value: skillLine, caret: skillLine.length };
  var before = value.slice(0, caret).replace(/(^|\\s)@[^\\s@]*$/, "$1@" + name + " ");
  return { value: before + value.slice(caret), caret: before.length };
}

function composerRows(asked) {
  if (asked.kind === "mention") {
    return agentsHere().filter(function (agent) { return agent.id !== chat.agentId && agent.name.toLowerCase().indexOf(asked.query) >= 0; }).slice(0, 8)
      .map(function (agent) { return { name: agent.name, note: agent.title || agent.description || "" }; });
  }
  return (composer.skills || []).filter(function (skill) { return skill.name.toLowerCase().indexOf(asked.query) >= 0 || String(skill.slug || "").indexOf(asked.query) >= 0; }).slice(0, 8)
    .map(function (skill) { return { name: skill.name, note: skill.description || "" }; });
}

function composerChoose(row) {
  var input = $("composer-text"), next2 = composerPick(input.value, input.selectionStart, composer.kind, row.name, t("ui.next.composer.useSkill", { name: row.name }));
  input.value = next2.value; input.selectionStart = input.selectionEnd = next2.caret;
  $("composer-menu").hidden = true; composer.rows = [];
  input.focus();
}

function renderComposerMenu() {
  var input = $("composer-text"), menu = $("composer-menu"), asked = composerQuery(input.value, input.selectionStart);
  if (!asked) { menu.hidden = true; composer.rows = []; return; }
  // Skills are read the first time one is asked for, and the menu is drawn again when they arrive.
  if (asked.kind === "skill" && composer.skills === null) {
    composer.skills = [];
    getJson("/api/skills").then(function (got) { composer.skills = got.skills || []; renderComposerMenu(); }, function () {});
  }
  composer.kind = asked.kind; composer.rows = composerRows(asked);
  if (composer.at >= composer.rows.length) composer.at = 0;
  menu.replaceChildren();
  if (composer.rows.length === 0) menu.appendChild(el("div", "why", t(asked.kind === "skill" ? "ui.next.composer.noSkill" : "ui.next.composer.noAgent")));
  composer.rows.forEach(function (row, index) {
    var item = el("button", index === composer.at ? "on" : "");
    item.type = "button";
    item.appendChild(el("b", "", row.name)); item.appendChild(el("span", "why", clip(row.note, 80)));
    // mousedown, so the choice is made before the textarea loses the caret it is made at
    item.addEventListener("mousedown", function (event) { event.preventDefault(); composerChoose(row); });
    menu.appendChild(item);
  });
  menu.hidden = false;
}

function composerStart() {
  var input = $("composer-text");
  input.addEventListener("input", renderComposerMenu);
  input.addEventListener("blur", function () { $("composer-menu").hidden = true; });
  // Before the composer's own Enter: with the menu open, Enter chooses instead of sending.
  input.addEventListener("keydown", function (event) {
    if ($("composer-menu").hidden) return;
    if (event.key === "Escape") { $("composer-menu").hidden = true; composer.rows = []; return; }
    if (composer.rows.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      composer.at = (composer.at + (event.key === "ArrowDown" ? 1 : composer.rows.length - 1)) % composer.rows.length;
      event.preventDefault(); renderComposerMenu();
    } else if ((event.key === "Enter" && !event.isComposing) || event.key === "Tab") {
      event.preventDefault(); event.stopImmediatePropagation(); composerChoose(composer.rows[composer.at]);
    }
  }, true);
}
`;
