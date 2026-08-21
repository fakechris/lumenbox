/**
 * Tests that the UI token does not stay in the address bar.
 *
 * It is accepted once as a query parameter to bootstrap the cookie, and the cookie is what every
 * later request uses — so by the time the page runs, the token has done its job. Leaving it there
 * put a working credential in browser history, in autocomplete, in the title bar of any screenshot
 * and in the referrer of any outbound link. The one that actually happens: you copy the address bar
 * to show a colleague an agent's desktop, and hand over control of the box with it.
 *
 * The script is extracted from the page rather than duplicated here, so this cannot pass against a
 * copy while the real page does something else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_HTML } from "./app-html.ts";

function stripFrom(href: string): string | undefined {
  const start = APP_HTML.indexOf("(function stripToken()");
  assert.ok(start > 0, "the page must still strip the token");
  const end = APP_HTML.indexOf("})();", start) + 5;

  let replaced: string | undefined;
  const window = {
    location: { href },
    history: {
      replaceState: (_state: unknown, _title: unknown, url: string) => {
        replaced = url;
      },
    },
  };
  // eslint-disable-next-line no-new-func -- running the page's own code is the point
  new Function("window", "URL", APP_HTML.slice(start, end))(window, URL);
  return replaced;
}

test("a token in the URL is replaced away once the page has loaded", () => {
  assert.equal(stripFrom("http://127.0.0.1:7777/?token=secret123"), "/");
  // Nothing else is lost: which agent you were looking at is part of where you are.
  assert.equal(
    stripFrom("http://127.0.0.1:7777/?token=secret123&agent=ada#desktop"),
    "/?agent=ada#desktop"
  );
});

test("a URL with no token is left alone", () => {
  // Rewriting unconditionally would add a history entry for every load, and there is nothing to fix.
  assert.equal(stripFrom("http://127.0.0.1:7777/?agent=ada"), undefined);
  assert.equal(stripFrom("http://127.0.0.1:7777/"), undefined);
});

test("the token is still accepted on the way in", () => {
  // The stripping must happen after the cookie is set, never instead of accepting the token —
  // otherwise the first load works and the next refresh locks the person out.
  assert.match(APP_HTML, /stripToken/);
  assert.match(
    APP_HTML,
    /Only if the page loaded, which means the cookie was set/,
    "the ordering is the load-bearing part and is written down next to the code"
  );
});
