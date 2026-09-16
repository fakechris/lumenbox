/**
 * What may be sent again after the answer is lost (INV-525). The asymmetry is the whole
 * design: an unnecessary "check first" is a sentence, a duplicated write is a duplicated
 * write, so anything undeclared is unsafe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_IDEMPOTENCY, afterTimeout, idempotencyOf, idempotencyOfAnnotations, idempotencyOfHttp } from "./idempotency.ts";

test("a tool nobody declared is unsafe, and the declared ones say what makes them safe", () => {
  assert.deepEqual(idempotencyOf("some_tool_added_next_month"), { kind: "unsafe" });
  assert.deepEqual(idempotencyOf("bash"), { kind: "unsafe" });
  assert.deepEqual(idempotencyOf("Read"), { kind: "read" });
  assert.deepEqual(idempotencyOf("Write"), { kind: "idempotent", key: "path" });
  // Every declared write names either a key or nothing, and no read is declared idempotent.
  for (const [tool, declaration] of Object.entries(TOOL_IDEMPOTENCY)) {
    if (declaration.kind === "idempotent") assert.ok(declaration.key === undefined || declaration.key !== "", `${tool} has an empty key`);
  }
});

test("a read retries, an idempotent write retries once, an unsafe write never does", () => {
  assert.deepEqual(afterTimeout({ kind: "read" }), { retry: true });
  assert.equal(afterTimeout({ kind: "read" }, {}, 2).retry, false);

  const write = idempotencyOf("Write");
  assert.deepEqual(afterTimeout(write, { path: "/home/box/work/a.md" }), { retry: true });
  const second = afterTimeout(write, { path: "/home/box/work/a.md" }, 2);
  assert.equal(second.retry, false);
  assert.match(second.note ?? "", /already retried once/);

  // Declared idempotent, but this call left out the field that makes it so.
  const unkeyed = afterTimeout(write, {});
  assert.equal(unkeyed.retry, false);
  assert.match(unkeyed.note ?? "", /left out path/);

  const unsafe = afterTimeout({ kind: "unsafe" }, { command: "deploy" });
  assert.equal(unsafe.retry, false);
  assert.match(unsafe.note ?? "", /may already have taken effect/);
});

test("HTTP says it itself, and an idempotency key says it louder", () => {
  assert.deepEqual(idempotencyOfHttp("get"), { kind: "read" });
  assert.deepEqual(idempotencyOfHttp("DELETE"), { kind: "idempotent", key: "method" });
  assert.deepEqual(idempotencyOfHttp("PUT"), { kind: "idempotent", key: "method" });
  assert.deepEqual(idempotencyOfHttp("POST"), { kind: "unsafe" });
  assert.deepEqual(idempotencyOfHttp("POST", { "Idempotency-Key": "abc" }), { kind: "idempotent", key: "Idempotency-Key" });
  assert.deepEqual(idempotencyOfHttp("PATCH", { "idempotency-key": "abc" }), { kind: "idempotent", key: "Idempotency-Key" });
});

test("an MCP server's own annotations are believed, and silence is not a claim", () => {
  assert.deepEqual(idempotencyOfAnnotations({ readOnlyHint: true }), { kind: "read" });
  assert.deepEqual(idempotencyOfAnnotations({ idempotentHint: true }), { kind: "idempotent" });
  assert.deepEqual(idempotencyOfAnnotations({ idempotentHint: false }), { kind: "unsafe" });
  assert.equal(idempotencyOfAnnotations({}), undefined, "no hint is not a hint of safety");
  assert.equal(idempotencyOfAnnotations(undefined), undefined);
});

test("the connector door's behaviour, as the tool applies it (INV-525 A2/A3)", () => {
  // A2: a lost answer on an idempotent call is sent again, once.
  const put = idempotencyOfHttp("PUT");
  assert.equal(afterTimeout(put, { method: "PUT" }, 1).retry, true);
  assert.equal(afterTimeout(put, { method: "PUT" }, 2).retry, false, "once, not forever");

  // A2 again, the case a service asks for: POST with an idempotency key.
  const keyed = idempotencyOfHttp("POST", { "Idempotency-Key": "pay-2026-09-15-01" });
  assert.equal(afterTimeout(keyed, { method: "POST", "Idempotency-Key": "pay-2026-09-15-01" }, 1).retry, true);

  // A3: a plain POST is never repeated, and the model is told what it does not know.
  const post = idempotencyOfHttp("POST");
  const plan = afterTimeout(post, { method: "POST" }, 1);
  assert.equal(plan.retry, false);
  assert.match(plan.note ?? "", /may already have taken effect — check before doing it again/);
});
