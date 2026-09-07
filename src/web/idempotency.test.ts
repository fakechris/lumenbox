import { test } from "node:test";
import assert from "node:assert/strict";
import { IDEMPOTENCY_TTL_MS, IdempotencyStore } from "./idempotency.ts";

test("a repeated key replays the first answer, a changed body under it conflicts, keys expire", async () => {
  let now = 1_000;
  const store = new IdempotencyStore(() => now);
  assert.equal(store.claim(undefined, {}).kind, "none");
  assert.equal(store.claim("short", {}).kind, "invalid");
  assert.equal(store.claim("req-000001", { text: "hi" }).kind, "fresh");
  // In flight: the replay waits for the first attempt to settle.
  const second = store.claim("req-000001", { text: "hi" });
  assert.equal(second.kind, "replay");
  store.settle("req-000001", { status: 202, body: { accepted: true } });
  assert.deepEqual(await (second as { reply: Promise<unknown> }).reply, { status: 202, body: { accepted: true } });
  assert.equal(store.claim("req-000001", { text: "hi" }).kind, "replay");
  assert.equal(store.claim("req-000001", { text: "bye" }).kind, "conflict");
  now += IDEMPOTENCY_TTL_MS + 1;
  assert.equal(store.claim("req-000001", { text: "bye" }).kind, "fresh", "expired, so the name is free again");
});
