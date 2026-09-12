/**
 * The three rules of browser recovery (INV-146), each against a scripted op: a read is
 * retried once and says so; a write is never repeated and comes back unknown; a browser
 * that fails twice is unavailable; and everything else passes through untouched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADLESS_NOTE, classifyFailure, headlessFetch, isReadOnlyOp, textOfHtml, withRecovery } from "./browser-recovery.ts";

const failing = (messages: string[], then?: string) => {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      calls += 1;
      const message = messages.shift();
      if (message !== undefined) throw new Error(message);
      return then ?? "fine";
    },
  };
};

test("failure shapes are classified: connection, transient, or the browser's own answer", () => {
  assert.equal(classifyFailure("The browser connection closed."), "connection");
  assert.equal(classifyFailure("Runtime.evaluate did not answer within 15000ms; it may still have run."), "connection");
  assert.equal(classifyFailure("Browser returned HTTP 502 listing targets."), "connection");
  assert.equal(classifyFailure("Execution context was destroyed."), "transient");
  assert.equal(classifyFailure("Cannot find context with specified id"), "transient");
  assert.equal(classifyFailure('"e9" is not in the last snapshot; take a fresh one.'), undefined);
  assert.ok(isReadOnlyOp("snapshot") && isReadOnlyOp("open") && !isReadOnlyOp("act") && !isReadOnlyOp("fill_secret"));
});

test("a read that lost its connection is retried once after forgetting the page, and the reply says it recovered", async () => {
  const forgotten: number[] = [];
  const op = failing(["The browser connection closed."]);
  const result = await withRecovery("snapshot", op.run, { forget: () => forgotten.push(1), delay: async () => {} });
  assert.deepEqual(result, { kind: "ok", result: "fine", recovered: "connection" });
  assert.equal(op.calls(), 2);
  assert.equal(forgotten.length, 1);
});

test("a page mid-navigation is retried after a wait, without forgetting the page", async () => {
  const waits: number[] = [];
  const op = failing(["Execution context was destroyed."]);
  const result = await withRecovery("read", op.run, { forget: () => assert.fail("a transient failure keeps the page"), delay: async ms => { waits.push(ms); } });
  assert.equal(result.kind, "ok");
  assert.deepEqual(waits, [600]);
});

test("a write is never repeated: it comes back unknown with the reason", async () => {
  const op = failing(["The browser connection closed."]);
  const result = await withRecovery("act", op.run, { forget: () => assert.fail("nothing to forget for a write"), delay: async () => {} });
  assert.equal(result.kind, "unknown");
  assert.equal(op.calls(), 1, "the click may have landed; it is not sent again");
  if (result.kind === "unknown") assert.match(result.error.message, /connection closed/);
});

test("a browser that fails twice on the connection is unavailable; a second answer of another kind passes through", async () => {
  const twice = failing(["The browser connection closed.", "The browser did not start on desktop 1 within 20s. Try box-doctor."]);
  const result = await withRecovery("open", twice.run, { forget: () => {}, delay: async () => {} });
  assert.equal(result.kind, "unavailable");
  const stale = failing(["The browser connection closed.", '"e1" is not a ref.']);
  await assert.rejects(withRecovery("snapshot", stale.run, { forget: () => {}, delay: async () => {} }), /is not a ref/);
  const own = failing(["That element has no position on the page, so it cannot be clicked."]);
  await assert.rejects(withRecovery("act", own.run, { forget: () => {}, delay: async () => {} }), /no position/);
});

test("the headless floor: a page's text without a browser, said as such", async () => {
  const { title, text } = textOfHtml("<html><head><title> Hello &amp; welcome </title><style>p{}</style></head><body><script>x()</script><h1>Hi</h1><p>One&nbsp;two</p><ul><li>a</li><li>b</li></ul></body></html>");
  assert.equal(title, "Hello & welcome");
  assert.equal(text, "Hi\nOne two\na\nb");
  const page = await headlessFetch("https://example.test/x", async () => ({ ok: true, status: 200, url: "https://example.test/x/", text: async () => "<title>T</title><p>body</p>" }));
  assert.deepEqual(page, { url: "https://example.test/x/", title: "T", text: "body" });
  await assert.rejects(headlessFetch("https://example.test/gone", async () => ({ ok: false, status: 404, url: "", text: async () => "" })), /HTTP 404/);
  assert.match(HEADLESS_NOTE, /no login state/);
});
