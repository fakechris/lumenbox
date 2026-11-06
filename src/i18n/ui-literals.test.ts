/**
 * The web UI writes no words of its own (INV-1684): every word a person reads on the page is a key
 * in the bundle, and a new hard-coded one fails the build here rather than reaching a Chinese
 * reader as English.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { literalsIn, templatesIn, uiCssClasses, uiLiteralsOf, uiSources } from "./ui-literals.ts";

/**
 * What stays as written, each for a reason a translation would break: text that is sent to an
 * agent rather than shown to a person, a command or a header a person copies, a class name the
 * heuristic cannot tell from a word. A new entry here needs the same kind of reason.
 */
const KEPT_AS_WRITTEN: Record<string, string[]> = {
  // A card press reaches the agent as a line of its conversation, in the words its prompt expects;
  // a note goes into the task's record, which agents read; a command and a header are copied as typed.
  "src/web/app-html.ts": ['[Action "', '" on card', "kept open from the board", "dismissed: not worth doing now", "Authorization: Bearer", "curl -X POST", "agentbox box up", "agentbox agent new"],
  // Class names in a class list built by concatenation.
  "src/web/tool-permissions-ui.ts": ["ask", "floor", "denied"],
};

test("no word in the web UI is written outside the bundle", () => {
  const css = uiCssClasses();
  const sources = uiSources();
  assert.ok(sources.length > 20, "the page, the dialog and the sections are all read");
  const found = sources.flatMap(source =>
    uiLiteralsOf(source.path, source.text, css)
      .filter(literal => !(KEPT_AS_WRITTEN[source.path] ?? []).includes(literal.text))
      .map(literal => `${literal.path}:${literal.line} ${JSON.stringify(literal.text)}`)
  );
  assert.deepEqual(found, [], 'put each in src/i18n/ui-*.ts as ["中文", "English"] and write {{ui.key}} where it was');
});

/** The literals one planted template yields, as text. */
function planted(source: string, name = "X_JS"): string[] {
  const templates = templatesIn(`export const ${name} = \`${source}\`;`);
  return templates.flatMap(template => literalsIn(template, new Set(["btn", "sm", "ghost", "dim"]))).map(literal => literal.text);
}

test("a word written into markup, an attribute or the script is found", () => {
  assert.deepEqual(planted('<div><button title="Delete it">Delete</button> {{ui.ok}}</div>', "X_HTML"), ["Delete it", "Delete"]);
  assert.deepEqual(planted('el.textContent = "Saved."; toast("could not save"); confirm("Remove " + name + "?");'), ["Saved.", "could not save", "Remove"]);
  assert.deepEqual(planted("box.innerHTML = '<span class=\"dim\">' + n + ' items waiting</span>';"), ["items waiting"]);
  assert.deepEqual(planted('label = n === 1 ? " call" : " calls";'), ["call", "calls"], "a ternary's branches are what is shown, not what is compared");
  assert.deepEqual(planted('row.appendChild(el("span", { class: "dim" }, "paused"));'), ["paused"], "the text of an element built by el()");
  assert.deepEqual(planted('var s = "已保存";'), ["已保存"], "Chinese written by hand is a hard-coded word too");
});

test("code is not taken for words: classes, ids, routes, events, comparisons, keys", () => {
  assert.deepEqual(
    planted(
      [
        'el.className = "btn sm ghost";',
        'if (kind === "Pending review") go();',
        'fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" } });',
        '$("setstatus").addEventListener("click", f);',
        'cards["consent:" + id] = true; showCard("consent:" + id, {});',
        'var cls = "toolchip" + (on ? " on" : "");',
        'html += "<option" + (picked ? " selected" : "") + ">{{ui.x}}</option>";',
        'document.querySelector(\'[data-runs-for="\' + slug + \'"]\');',
      ].join("\n")
    ),
    []
  );
});
