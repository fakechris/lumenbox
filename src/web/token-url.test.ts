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
import vm from "node:vm";
import { APP_PAGE, NEXT_PAGE } from "./page-locale.ts";
import { SIGN_IN_AGAIN_JS } from "./token-url-ui.ts";
/** The page as an English reader receives it: its words filled from the bundle (INV-1684). */
const APP_HTML = APP_PAGE("en");

function stripFrom(href: string, html = APP_HTML): string | undefined {
  const start = html.indexOf("(function stripToken()");
  assert.ok(start > 0, "the page must still strip the token");
  const end = html.indexOf("})();", start) + 5;

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
  new Function("window", "URL", html.slice(start, end))(window, URL);
  return replaced;
}

test("a token in the URL is replaced away once the page has loaded", () => {
  assert.equal(stripFrom("http://127.0.0.1:7777/?token=secret123"), "/");
  // Nothing else is lost: which agent you were looking at is part of where you are.
  assert.equal(
    stripFrom("http://127.0.0.1:7777/?token=secret123&agent=ada#desktop"),
    "/?agent=ada#desktop"
  );
  assert.equal(
    stripFrom("http://127.0.0.1:7777/?ui=next&token=fixture&view=settings&pane=team", NEXT_PAGE("en")),
    "/?ui=next&view=settings&pane=team"
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

test("the whole inline page script parses — a syntax error breaks every feature at once", () => {
  // token-url only exercised the stripToken IIFE, so a syntax error anywhere else in
  // the page — a mismatched quote in a template string, say — shipped green while the
  // real page threw on load and rendered nothing. This parses the entire script the
  // browser runs, which is the cheapest thing that catches it.
  const open = APP_HTML.indexOf('<script>\n"use strict"');
  assert.ok(open > 0, "the inline script is still there");
  const close = APP_HTML.indexOf("</script>", open);
  const js = APP_HTML.slice(open + "<script>".length, close);
  assert.doesNotThrow(() => new Function(js), "the page script must parse");
});

test("INV-2081: an API 401 reloads either page once into the server's sign-in recovery page", async () => {
  for (const page of [NEXT_PAGE("en"), APP_HTML]) {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
    const first = scripts.findIndex(script => script.includes("function watchSignIn("));
    assert.ok(first >= 0 && !scripts.slice(0, first).some(script => /\bfetch\(/.test(script)), "installed before the page's first request");
  }
  const load = (stamp?: string) => {
    const store = new Map(stamp === undefined ? [] : [["lumenbox.signInReload", stamp]]);
    const reloads: number[] = [];
    let status = 200;
    const window: Record<string, unknown> = { fetch: (input: string) => Promise.resolve({ url: "http://h" + input, status }) };
    const sessionStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) };
    const location = { href: "http://h/", reload: () => reloads.push(1) };
    vm.runInNewContext(SIGN_IN_AGAIN_JS, { window, sessionStorage, location, URL, Date, Number, String, Promise });
    const fetch = window.fetch as (input: string) => Promise<{ status: number }>;
    return { fetch, reloads, store, answer: (next: number) => { status = next; } };
  };
  const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => "arrived"), new Promise(done => setTimeout(() => done("held"), 20))]);

  const page = load();
  assert.equal(await settled(page.fetch("/api/agents")), "arrived", "an answered request passes through");
  page.answer(401);
  assert.equal(await settled(page.fetch("/api/agents")), "held", "the 401 never reaches the caller's toast");
  assert.equal(await settled(page.fetch("/api/work")), "held");
  assert.equal(page.reloads.length, 1, "a burst of 401s reloads once");
  assert.ok(page.store.has("lumenbox.signInReload"));
  const other = load();
  other.answer(401);
  assert.equal(await settled(other.fetch("/vendor/a2ui.js")), "arrived", "only the API's 401 is the sign-in ending");
  assert.equal(other.reloads.length, 0);

  const again = load(String(Date.now()));
  again.answer(401);
  assert.equal(await settled(again.fetch("/api/agents")), "arrived", "straight back to a 401 after the reload: the error shows, no loop");
  assert.equal(again.reloads.length, 0);
});
