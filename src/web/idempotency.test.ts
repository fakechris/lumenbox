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

// ── a day-long key survives a restart (INV-1358) ────────────────────────────────

test("a settled reply persisted to the jsonl is replayed by a fresh store, within its TTL and not past it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "idem-"));
  const path = join(dir, "keys.jsonl");
  try {
    let now = 1_000_000;
    const first = new IdempotencyStore({ now: () => now, ttlMs: 24 * 60 * 60_000, persistTo: path });
    assert.equal(first.claim("key-persist-1", { a: 1 }).kind, "fresh");
    first.settle("key-persist-1", { status: 200, body: { ok: true } });
    const second = new IdempotencyStore({ now: () => now + 60_000, ttlMs: 24 * 60 * 60_000, persistTo: path });
    const replay = second.claim("key-persist-1", { a: 1 });
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") assert.deepEqual((await replay.reply).body, { ok: true });
    assert.equal(second.claim("key-persist-1", { a: 2 }).kind, "conflict");
    const late = new IdempotencyStore({ now: () => now + 25 * 60 * 60_000, ttlMs: 24 * 60 * 60_000, persistTo: path });
    assert.equal(late.claim("key-persist-1", { a: 1 }).kind, "fresh", "a day later the key is forgotten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
