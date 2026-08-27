/**
 * The page's script must not reference an element that is not on the page.
 *
 * Every handler is bound at the top level — `$("setmcpadd").onclick = …` — so one id that
 * does not exist throws a TypeError before the rest of the script runs, and the whole
 * application is a blank shell with a working layout. No agents, no activity, no
 * reconnect: the page looks like the backend died.
 *
 * That is exactly what happened. A change that gated the settings dialog by role removed
 * the MCP-token markup and left its three handlers behind, and the app was dead on every
 * fresh load from then on — invisible to whoever still had the old page cached, and
 * indistinguishable from a server outage to whoever did not.
 *
 * A browser cannot be part of the test suite here, but this can: the ids are in the same
 * file as the code that reaches for them, so the mismatch is a string comparison.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_HTML } from "./app-html.ts";

/** Every `id="…"` the document defines. */
const definedIds = new Set([...APP_HTML.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(match => match[1]!));

/** Ids the script reaches for in a way that throws when the element is absent. */
function referencedIds(): { id: string; how: string }[] {
  const found: { id: string; how: string }[] = [];
  // `$("x").anything` — a property access on the result, which is null when it is missing.
  for (const match of APP_HTML.matchAll(/\$\("([A-Za-z0-9_-]+)"\)\s*\./g)) {
    found.push({ id: match[1]!, how: `$("${match[1]}").…` });
  }
  for (const match of APP_HTML.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)\s*\./g)) {
    found.push({ id: match[1]!, how: `getElementById("${match[1]}").…` });
  }
  return found;
}

test("every element the script dereferences exists in the document", () => {
  const missing = referencedIds().filter(reference => !definedIds.has(reference.id));
  // Deduplicated so one absent element reports once rather than once per use.
  const names = [...new Set(missing.map(reference => `${reference.how}`))];
  assert.deepEqual(
    names,
    [],
    `the script dereferences elements the page does not contain, which throws at the top ` +
      `level and leaves a blank application:\n  ${names.join("\n  ")}`
  );
});

test("the ids this has already caught are present", () => {
  // Named individually, because the general check above passes vacuously if the parsing
  // ever stops finding references, and this is the feature that was silently lost.
  for (const id of ["setmcpadd", "setmcplabel", "setmcpnew", "setmcptokens"]) {
    assert.ok(definedIds.has(id), `${id} is missing from the settings dialog`);
  }
});

test("a round's calls are nested inside it, not laid beside it", () => {
  // The trace is rounds: the agent says what it is about to do, then does it. Rendering
  // those as siblings threw the structure away — six fetches with nothing to say they
  // belonged to the sentence above them — and folding one row did not fold its calls,
  // which is not what folding a node in a tree means.
  //
  // A browser cannot run here, so what this pins is the contract the two paths share:
  // rows are appended to the open round rather than to the chat, and a round has a place
  // to put them.
  assert.match(
    APP_HTML,
    /function stepHost\(\)\s*\{\s*return openStep && openStep\.isConnected \? openStep\.querySelector\("\.kids"\)/,
    "rows must target the open round, falling back to the chat only when none is open"
  );
  assert.match(APP_HTML, /var el = stepHost\(\);/, "collapsedRow must append into the round");
  assert.match(APP_HTML, /class="kids"/, "a round needs a container for its children");
  // The indent and the guide are what make the nesting visible rather than implied.
  assert.match(APP_HTML, /details\.step > \.kids \{ padding: [^}]*18px/, "children are indented");
  assert.match(APP_HTML, /details\.step \{[^}]*border-left/, "the guide line hangs off the parent");
});

test("the answer is not a node in the tree", () => {
  // Nesting the answer would bury the thing the rounds were for. Both paths close the
  // round before rendering prose that no call follows.
  assert.match(APP_HTML, /endStep\(\);\s*\n\s*bubble\(entry\.role/, "replay closes before the answer");
  assert.match(APP_HTML, /function endStep\(\) \{\s*openStep = null;/, "closing is explicit");
});

test("no backtick reaches the page script", () => {
  // Three separate edits have terminated this template literal by writing a backtick in
  // a comment, twice in CSS and once in prose. It compiles into gibberish or fails to
  // compile, and neither failure names the cause.
  const script = APP_HTML.slice(APP_HTML.indexOf("<script"));
  assert.ok(!script.includes("`"), "a backtick in the page script ends the template early");
});

test("a structured tool argument is summarised, not stringified", () => {
  // SetTodos takes a list of objects, and String() on it rendered
  // "[object Object],[object Object]" in the row — which is what shipped and what a
  // screenshot caught. The row has to be identifiable without being expanded.
  assert.match(APP_HTML, /function describeArg\(value\)/, "structured args need their own reader");
  assert.match(
    APP_HTML,
    /item\.text \|\| item\.title \|\| item\.name/,
    "a list of objects is labelled by what the objects call themselves"
  );
  assert.ok(
    !/return values\.length \? values\[0\] : ""/.test(APP_HTML),
    "the String()-the-first-value fallback is what produced [object Object]"
  );
});

test("a step's heading is not repeated inside its own body", () => {
  // The summary carried the first sentence and the body carried the whole text, so the
  // first sentence appeared twice, directly under itself — which reads as a rendering
  // fault rather than as a heading and its detail.
  assert.match(APP_HTML, /function restAfter\(text, head\)/);
  assert.match(APP_HTML, /var rest = restAfter\(text, head\);/, "the body gets the rest only");
});

test("folding is offered per turn as well as per step", () => {
  // Two different wishes: put this piece of work away, and fold everything on the page.
  // The page-level link existed in the pane header and nobody found it, so the per-turn
  // control lives where the steps are.
  assert.match(APP_HTML, /function stepGroupBar\(\)/);
  assert.match(APP_HTML, /class="foldgroup"/);
  assert.match(APP_HTML, /group\.appendChild\(step\)/, "steps belong to their turn's group");
});

test("every CSS content escape is what a browser will accept", () => {
  // Shipped twice broken. The template literal halves backslashes, so a rule written with
  // one too many reaches the browser as an escaped backslash and the chevron is drawn as
  // the literal text \25b8 in front of every heading. Reasoning about the layers got it
  // wrong in both directions; this asserts the bytes that actually ship.
  const values = [...APP_HTML.matchAll(/content: "([^"]*)"/g)].map(match => match[1]!);
  assert.ok(values.length > 0, "the check must be looking at something");
  const wrong = values.filter(value => !/^\\[0-9a-f]{4}$/.test(value));
  assert.deepEqual(wrong, [], "a CSS unicode escape is one backslash and four hex digits");
});
