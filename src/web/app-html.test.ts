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
