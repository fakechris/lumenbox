/**
 * The parts of the page script that can be checked without a page: the find query runs
 * against an index shaped like the one the outline leaves behind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { findScript, snapshotScript, STALE_MUTATIONS } from "./browser-snapshot.ts";

const index = [
  ["e1a", "button", "Save"],
  ["e2b", "button", "Delete"],
  ["e3c", "link", "Delete account"],
  ["e4d", "button", "Delete"],
];

function find(query: Parameters<typeof findScript>[0], withIndex: unknown = index) {
  // `null` means "no outline on this page"; undefined would take the default.
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  if (withIndex !== null) sandbox.__lumenIndex = withIndex;
  return JSON.parse(runInNewContext(findScript(query), sandbox)) as {
    ref: string | null;
    count: number;
    sample: string[];
    error?: string;
  };
}

test("find resolves 'the second Delete button' by role, name and nth", () => {
  assert.equal(find({ role: "button", name: "delete", nth: 2 }).ref, "e4d");
  assert.equal(find({ role: "button", name: "Delete" }).ref, "e2b");
  // Name alone is a substring across roles; the link counts too.
  const any = find({ name: "delete" });
  assert.equal(any.count, 3);
  assert.equal(any.ref, "e2b");
  // Role alone.
  assert.equal(find({ role: "link" }).ref, "e3c");
});

test("a miss says how many matched and what they were, and no outline says so", () => {
  const none = find({ role: "button", name: "Publish" });
  assert.equal(none.ref, null);
  assert.equal(none.count, 0);
  const past = find({ role: "button", name: "delete", nth: 3 });
  assert.equal(past.ref, null);
  assert.equal(past.count, 2);
  assert.deepEqual(past.sample, ['button "Delete" [ref=e2b]', 'button "Delete" [ref=e4d]']);
  assert.equal(find({ role: "button" }, null).error, "no outline");
});

test("the outline script leaves an index and a mutation counter on the page", () => {
  const script = snapshotScript(100);
  assert.match(script, /globalThis\.__lumenIndex = index/);
  assert.match(script, /index\.push\(\[ref, role, name\]\)/);
  assert.match(script, /new MutationObserver/);
  assert.match(script, /globalThis\.__lumenMutations = 0/);
  assert.ok(STALE_MUTATIONS > 5, "a banner appearing must not refuse every ref");
});

test("a field the box filled from the vault is redacted in the outline (INV-402)", () => {
  assert.match(snapshotScript(10), /data-lumen-secret/);
});
