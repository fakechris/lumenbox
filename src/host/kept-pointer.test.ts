/**
 * Tests for the pointer that describes its own target.
 *
 * The property that matters is the one that only shows up after the artefact is gone: a
 * pointer to a pruned file must still be able to say what was there. Everything else here
 * is about not breaking the three consumers that already read these lines.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keepFetchedPage,
  keptPointer,
  KEPT_MARKER,
  KEPT_KIND,
  parseKeptPointer,
  sha256,
  verifyKept,
  verifyPointer,
} from "./fetched.ts";
import { keepToolResult, RESULT_KEPT_MARKER } from "./results.ts";
import { storableResult } from "./turn.ts";

function home(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-pointer-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const page = (path: string, text: string, at = new Date(Date.UTC(2026, 8, 22, 10, 0, 0))) =>
  keepFetchedPage(
    {
      url: "https://example.com/a",
      finalUrl: "https://example.com/a",
      title: "A page",
      text,
      contentType: "text/html",
      bytes: text.length * 2,
      clipped: false,
      meta: {},
      agent: { id: "a1", name: "Nova" },
      fetchedAt: at,
    },
    path
  );

test("a pointer says where, how big, what digest and when — and reads back", () => {
  const at = new Date(Date.UTC(2026, 8, 22, 10, 0, 0));
  const line = keptPointer({
    marker: KEPT_MARKER,
    path: "/home/.agentbox/fetched/2026-09/1a2b3c4d-20260922T100000Z.md",
    sha256: "a".repeat(64),
    chars: 61_606,
    at,
  });
  assert.equal(
    line,
    "[full page kept: /home/.agentbox/fetched/2026-09/1a2b3c4d-20260922T100000Z.md — 61,606 chars, " +
      `sha256 ${"a".repeat(64)}, kept 2026-09-22T10:00:00.000Z]`
  );
  const parsed = parseKeptPointer(line)!;
  assert.equal(parsed.path, "/home/.agentbox/fetched/2026-09/1a2b3c4d-20260922T100000Z.md");
  assert.equal(parsed.chars, 61_606);
  assert.equal(parsed.sha256, "a".repeat(64));
  assert.equal(parsed.at.toISOString(), at.toISOString());

  // Never contains a `]`, because storableResult's carry matches `[^\]]*`.
  assert.equal(line.indexOf("]"), line.length - 1);
  // The path is still the first token after the marker, which extractAnchors relies on.
  assert.match(line, /full page kept: (\S+) —/);
  assert.equal(parseKeptPointer("[full page kept: /a/b.md]"), undefined, "the old shape is not half-read");
});

test("the pointer outlives the file it points at", () => {
  const { path, cleanup } = home();
  try {
    const body = "the page said something at length. ".repeat(50);
    const kept = page(path, body);
    const line = keptPointer({
      marker: KEPT_MARKER,
      path: kept.path,
      sha256: kept.sha256,
      chars: body.length,
      at: new Date(Date.UTC(2026, 8, 22, 10, 0, 0)),
    });
    assert.deepEqual(verifyPointer(line), { state: "verified", sha256: kept.sha256 });

    // Ninety days later the file is pruned. The record must not go blank.
    rmSync(kept.path);
    const after = verifyPointer(line);
    assert.equal(after.state, "missing");
    assert.equal(after.sha256, kept.sha256, "and it still says what was there");
    assert.equal(parseKeptPointer(line)!.chars, body.length);
  } finally {
    cleanup();
  }
});

test("a kept file edited by one character stops verifying", () => {
  const { path, cleanup } = home();
  try {
    const kept = page(path, "the original sentence, as read.");
    assert.deepEqual(verifyKept(path).failures, []);
    assert.equal(verifyKept(path).verified, 1);

    const text = readFileSync(kept.path, "utf8");
    writeFileSync(kept.path, text.replace("original", "criginal"));
    const after = verifyKept(path);
    assert.equal(after.verified, 0);
    assert.equal(after.mismatched, 1);
    assert.deepEqual(after.failures, [{ path: kept.path, why: "mismatched" }]);
  } finally {
    cleanup();
  }
});

test("a kept tool result verifies the same way, over the same walk", () => {
  const { path, cleanup } = home();
  try {
    const text = "output ".repeat(500);
    const kept = keepToolResult(
      { text, turnId: "t1", toolUseId: "u1", tool: "browser_read", agent: { id: "a1", name: "Nova" }, at: new Date() },
      path
    );
    assert.equal(sha256(text), kept.sha256);
    const both = verifyKept(path);
    assert.equal(both.verified, 1, "the results store is walked as well as fetched");
    assert.equal(both.mismatched, 0);
  } finally {
    cleanup();
  }
});

test("storableResult writes a pointer that verifies against what it just wrote", () => {
  const { path, cleanup } = home();
  try {
    const whole = "a long answer from a tool that never spills. ".repeat(200);
    const stored = storableResult(
      { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: whole }] },
      undefined,
      { turnId: "turn-1", agent: { id: "a1", name: "Nova" }, tool: "browser_read", home: path }
    );
    const text = (stored.content as { text: string }[])[0]!.text;
    const parsed = parseKeptPointer(text)!;
    assert.equal(parsed.chars, whole.length);
    assert.equal(parsed.sha256, sha256(whole));
    assert.equal(verifyPointer(text).state, "verified");
    // And the replayed head is still bounded.
    assert.ok(text.length < whole.length / 2);
    assert.match(text, new RegExp(`^${whole.slice(0, 200).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    cleanup();
  }
});

test("the evidence stores say what they are, and the label is the honest one", () => {
  // `feed`, not `record`: these prune. The reason that is allowed is the test above — the
  // record keeps the digest, so an expired artefact degrades to a description.
  assert.equal(KEPT_KIND, "feed");
});
