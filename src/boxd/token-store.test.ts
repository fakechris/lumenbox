/**
 * The box daemon's token changes in two steps and survives a restart (docs/106 §5 R7, INV-2204).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxdTokens, TOKEN_OVERLAP_MS } from "./token-store.ts";

const OLD = "old-token-0123456789", NEXT = "next-token-0123456789", THIRD = "third-token-012345678";

test("a rotation is named with the current token, confirmed with the new one; the old one works for the overlap and then never", () => {
  const dir = mkdtempSync(join(tmpdir(), "boxd-tokens-"));
  try {
    let now = 1_000_000;
    const state = join(dir, "config", "boxd-token.json");
    const tokens = new BoxdTokens(OLD, state, () => now);
    assert.equal(tokens.accepts(OLD), true);
    assert.equal(tokens.accepts(NEXT), false);
    assert.deepEqual(tokens.answer("POST /token/rotate", NEXT, { token: THIRD }), { status: 409, body: { error: "Rotate with the current token; this one is being replaced." } }, "only the current token may rotate");
    assert.equal(tokens.answer("POST /token/rotate", OLD, { token: "short" }).status, 400);
    assert.deepEqual(tokens.answer("POST /token/rotate", OLD, { token: NEXT }), { status: 200, body: { pending: true } });
    assert.ok(tokens.accepts(OLD) && tokens.accepts(NEXT), "named, not confirmed: both open the box, for as long as it takes");
    now += 24 * 3_600_000;
    assert.ok(tokens.accepts(OLD) && tokens.accepts(NEXT), "an unconfirmed rotation does not expire either token");
    assert.equal(statSync(state).mode & 0o777, 0o600);

    // A restart before the confirmation: both still work.
    const restarted = new BoxdTokens(OLD, state, () => now);
    assert.ok(restarted.accepts(OLD) && restarted.accepts(NEXT));
    assert.equal(restarted.answer("POST /token/confirm", OLD, {}).status, 409, "only the new token may confirm");
    const confirmed = restarted.answer("POST /token/confirm", NEXT, { overlap_seconds: 300 });
    assert.deepEqual(confirmed, { status: 200, body: { overlapUntil: new Date(now + 300_000).toISOString() } });
    assert.equal(restarted.accepts(NEXT), true);
    assert.equal(restarted.accepts(OLD), true, "the old one, during the overlap");
    now += 300_000;
    assert.equal(restarted.accepts(OLD), false, "and not after it");
    assert.equal(restarted.accepts(NEXT), true);

    // A restart during an overlap keeps the new token and drops the old one.
    const again = new BoxdTokens(OLD, state, () => now);
    assert.deepEqual([again.accepts(NEXT), again.accepts(OLD)], [true, false]);
    assert.equal(TOKEN_OVERLAP_MS, 5 * 60_000);

    // BOXD_TOKEN set to something new on purpose: the operator wins and the rotated token is forgotten.
    const replaced = new BoxdTokens(THIRD, state, () => now);
    assert.deepEqual([replaced.accepts(THIRD), replaced.accepts(NEXT)], [true, false]);
    assert.throws(() => readFileSync(state), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
