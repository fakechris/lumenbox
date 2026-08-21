/**
 * Tests for one agent taking a piece of work.
 *
 * Two agents told to do the same thing both do it. That is not a communication failure and no
 * amount of asking them to coordinate fixes it — it is the absence of a claim. What is on test is
 * that a claim holds across a restart, that it lapses on its own, and that renewing is not a
 * conflict with yourself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_TTL_MS, Claims, claimKey, heldElsewhere } from "./claims.ts";

function path(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-claims-"));
  return { file: join(dir, "claims.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const AT = new Date("2026-08-20T10:00:00Z");
const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

test("the second agent to take the same work is told who has it", () => {
  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    assert.deepEqual(
      claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT }),
      { ok: true, renewed: false }
    );

    const second = claims.claim({ agentId: "rex", about: "rewrite the deploy script", now: later(1) });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.held.agentId === "ada");

    const told = heldElsewhere(!second.ok ? second.held : ({} as never), id => (id === "ada" ? "Ada" : id));
    assert.match(told, /Ada claimed this/);
    assert.match(told, /two of you doing the same work/);
    // A refusal that does not say what to do instead is just an obstacle.
    assert.match(told, /Pick something else, or ask them where they have got to/);
    assert.match(told, /lapses on its own/);
  } finally {
    cleanup();
  }
});

test("a claim survives the process that made it", () => {
  const { file, cleanup } = path();
  try {
    new Claims(file).claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT });
    // A restart is exactly when two agents are most likely to pick up the same thing.
    const successor = new Claims(file);
    assert.equal(successor.claim({ agentId: "rex", about: "rewrite the deploy script", now: later(1) }).ok, false);
  } finally {
    cleanup();
  }
});

test("a claim lapses on its own, so a dead agent does not park a task forever", () => {
  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT });

    // Expiry is computed on read, so nothing has to be running for a claim to lapse — which is the
    // property that matters when the thing that stopped running is the process holding it.
    const after = new Date(AT.getTime() + CLAIM_TTL_MS + 1_000);
    assert.equal(claims.claim({ agentId: "rex", about: "rewrite the deploy script", now: after }).ok, true);
  } finally {
    cleanup();
  }
});

test("claiming what you already hold is a renewal, not a conflict", () => {
  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT });
    const again = claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: later(20) });
    assert.deepEqual(again, { ok: true, renewed: true });

    // And the renewal moved the clock: it does not lapse at the original moment.
    const afterOriginal = new Date(AT.getTime() + CLAIM_TTL_MS + 1_000);
    assert.equal(claims.claim({ agentId: "rex", about: "rewrite the deploy script", now: afterOriginal }).ok, false);
  } finally {
    cleanup();
  }
});

test("releasing hands it back immediately", () => {
  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT });
    claims.release("ada", "Rewrite the deploy script", later(1));
    assert.equal(claims.claim({ agentId: "rex", about: "rewrite the deploy script", now: later(2) }).ok, true);
  } finally {
    cleanup();
  }
});

test("matching is on the words, and says nothing it cannot know", () => {
  // Crude on purpose, like memory's dedupe: two agents will not phrase a task identically, and
  // being slightly too eager to call two descriptions the same is cheaper than doing the work
  // twice. It cannot catch genuinely different wordings, and nothing textual can.
  assert.equal(claimKey("Rewrite the deploy script"), claimKey("rewrite deploy script!"));
  assert.notEqual(claimKey("rewrite the deploy script"), claimKey("rewrite the build script"));

  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    // An empty description matches everything or nothing; it is allowed through and holds nothing.
    assert.deepEqual(claims.claim({ agentId: "ada", about: "   ", now: AT }), { ok: true, renewed: false });
    assert.deepEqual(claims.all(AT), []);
  } finally {
    cleanup();
  }
});

test("a torn line costs one claim, not the file", () => {
  const { file, cleanup } = path();
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ key: "deploy script", event: "claim", agentId: "ada", at: AT.toISOString(), about: "deploy" })}\n` +
        `{"key":"other","event":"claim","agentId":"rex","at":"2026`
    );
    assert.deepEqual(new Claims(file).all(later(1)).map(claim => claim.agentId), ["ada"]);
  } finally {
    cleanup();
  }
});

test("no claims file means nothing is refused", () => {
  const claims = new Claims(null);
  assert.equal(claims.claim({ agentId: "ada", about: "x", now: AT }).ok, true);
  assert.equal(claims.claim({ agentId: "rex", about: "x", now: AT }).ok, true);
});


test("a late release from a lapsed owner does not delete the new holder's claim", () => {
  // Ada's claim expires and Rex takes the work. Ada, finishing late, releases her old claim. If
  // release deleted by key alone, it would delete Rex's live claim and let a third agent take the
  // work while Rex is still on it.
  const { file, cleanup } = path();
  try {
    const claims = new Claims(file);
    claims.claim({ agentId: "ada", about: "Rewrite the deploy script", now: AT });

    // Long enough later that Ada's claim has lapsed and Rex takes it.
    const afterLapse = new Date(AT.getTime() + CLAIM_TTL_MS + 60_000);
    assert.equal(
      claims.claim({ agentId: "rex", about: "rewrite the deploy script", now: afterLapse }).ok,
      true
    );

    // Ada releases her old one. It must not touch Rex's.
    claims.release("ada", "Rewrite the deploy script", new Date(afterLapse.getTime() + 60_000));

    const holder = claims.holderOf(claimKey("rewrite the deploy script"), new Date(afterLapse.getTime() + 120_000));
    assert.equal(holder?.agentId, "rex", "Rex still holds it");
  } finally {
    cleanup();
  }
});
