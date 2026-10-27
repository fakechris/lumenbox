/** Declared write paths (INV-1379): a commit step pressed once is not pressed again until the page says not_done. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterCommit, WritePaths, withWritePath } from "./write-path.ts";

test("a declared path records each mark, refuses a repeat, and lets not_done through once", () => {
  const paths = new WritePaths();
  const key = "ada:main";
  assert.match(paths.before(key, "pay", undefined) ?? "", /no write path is open/);
  assert.equal(paths.before(key, "cart", ["cart", "pay"]), undefined);
  assert.match(paths.after(key, "cart", "entered"), /cart ✓ → pay\. Not yet entered or unconfirmed: pay/);
  assert.match(paths.before(key, "cart", undefined) ?? "", /already pressed.*browser_verify_write/);
  assert.match(paths.before(key, "ship", undefined) ?? "", /not on the declared write path/);
  assert.match(paths.before(key, "cart", ["other"]) ?? "", /already open/, "no second path while one is open");

  // The pay click went out and the result is unknown: refused until verified.
  assert.equal(paths.before(key, "pay", undefined), undefined);
  assert.match(paths.after(key, "pay", "unknown"), /pay \?/);
  assert.match(paths.incomplete(key) ?? "", /^incomplete \(write_path\): cart → pay — not entered or unconfirmed: pay/);
  assert.match(paths.before(key, "pay", undefined) ?? "", /result was not confirmed/);
  paths.verify(key, "pay", "unknown", "spinner still showing");
  assert.match(paths.before(key, "pay", undefined) ?? "", /unknown.*ask/, "unknown keeps it refused and says to ask");
  paths.verify(key, "pay", "not_done", "the form is back with the card field empty");
  assert.equal(paths.before(key, "pay", undefined), undefined, "not_done allows one more press");
  paths.after(key, "pay", "entered");
  assert.match(paths.before(key, "pay", undefined) ?? "", /already pressed/, "the verdict is spent by that press");
  assert.equal(paths.incomplete(key), undefined);
  assert.match(paths.status(key), /Write path complete/);
  assert.equal(paths.before(key, "cart", ["cart", "pay"]), undefined, "a finished path makes room for the next one");
});

test("done from the page counts as entered; other keys and expiry stay apart", () => {
  let now = 0;
  const paths = new WritePaths(() => now);
  paths.before("a", "send", ["send"]);
  paths.after("a", "send", "unknown");
  paths.verify("a", "send", "done", "order #123 shown");
  assert.equal(paths.incomplete("a"), undefined);
  assert.equal(paths.status("b"), "");
  paths.before("c", "x", ["x"]);
  now = 7 * 60 * 60_000;
  assert.match(paths.before("c", "x", undefined) ?? "", /no write path is open/, "a stale path is forgotten after six hours");
  assert.match(paths.before("c", "bad;name", ["bad;name"]) ?? "", /short name/);
});

test("afterCommit appends the status to a commit step's result; plain clicks are untouched", () => {
  const plain = { text: "Outcome: ok." };
  assert.equal(afterCommit("k", { action: "click" }, plain), plain);
});

test("withWritePath adds commit and writePath to browser_act and offers browser_verify_write", () => {
  const tools = [{ name: "browser_act", input_schema: { type: "object", properties: { action: {} } } }];
  withWritePath(tools);
  const props = (tools[0]!.input_schema as { properties: Record<string, unknown> }).properties;
  assert.ok("commit" in props && "writePath" in props);
  assert.equal(tools[1]!.name, "browser_verify_write");
  const none: { name: string; input_schema: unknown }[] = [];
  withWritePath(none);
  assert.equal(none.length, 0, "no browser, nothing added");
});
