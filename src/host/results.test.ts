/**
 * Tests for keeping what the cut cuts.
 *
 * The property that matters is not the file format: it is that a tool which never thought
 * about spilling still leaves the whole of its answer behind, and that the pointer in the
 * transcript leads to exactly those bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storableResult } from "./turn.ts";
import { keepToolResult, keptResultPath, resetKeptPruneClock, RESULT_KEPT_MARKER, resultsDir } from "./results.ts";
import { readFrontmatter, pruneFetched, sha256 } from "./fetched.ts";
import { DURABLE_RESULT_CHARS } from "../protocol/index.ts";

function home(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-results-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

const keep = (path: string) => ({
  turnId: "turn-1",
  agent: { id: "a1", name: "Nova" },
  tool: "browser_read",
  conversation: "feishu-personal-oc_x",
  home: path,
  at: new Date(Date.UTC(2026, 8, 22, 10, 0, 0)),
});

const block = (text: string, id = "toolu_01") => ({
  type: "tool_result" as const,
  tool_use_id: id,
  content: [{ type: "text" as const, text }],
});

test("a long result from a tool that never spills is kept whole, and the pointer leads to it", () => {
  const { path, cleanup } = home();
  try {
    const whole = "the page said something at length. ".repeat(1_000);
    const stored = storableResult(block(whole), undefined, keep(path));
    const text = (stored.content as { text: string }[])[0]!.text;

    const pointer = new RegExp(`\\[${RESULT_KEPT_MARKER} (\\S+) — all (\\d+) characters\\]`).exec(text);
    assert.ok(pointer !== null, text.slice(-200));
    assert.equal(Number(pointer[2]), whole.length);

    // The replayed head is still bounded: keeping is not the same as showing.
    assert.ok(text.length <= DURABLE_RESULT_CHARS + 200, `stored ${text.length} chars`);
    assert.ok(text.startsWith(whole.slice(0, DURABLE_RESULT_CHARS)));

    const kept = readFileSync(pointer[1]!, "utf8");
    const head = readFrontmatter(kept);
    assert.equal(head.schema, "lumenbox.result/v1");
    assert.equal(head.tool, "browser_read");
    assert.equal(head.tool_use_id, "toolu_01");
    assert.equal(head.turn_id, "turn-1");
    assert.equal(head.agent, "Nova");
    assert.equal(head.conversation, "feishu-personal-oc_x");
    assert.equal(head.text_chars, String(whole.length));
    assert.equal(head.sha256, sha256(whole));
    // And the body is the result itself, byte for byte.
    const body = kept.slice(kept.indexOf("\n---\n") + 5);
    assert.equal(body, `${whole}\n`);
    assert.equal(sha256(body.slice(0, -1)), head.sha256);
  } finally {
    cleanup();
  }
});

test("a result that already carries a pointer is not kept twice", () => {
  const { path, cleanup } = home();
  try {
    const spilled = `${"x".repeat(5_000)}\n\n[full output kept: /home/box/work/.spool/t1.txt — all 5000 bytes of stdout]`;
    const stored = storableResult(block(spilled), undefined, keep(path));
    const text = (stored.content as { text: string }[])[0]!.text;
    assert.match(text, /\.spool\/t1\.txt/, "the box's own pointer is the one carried");
    assert.doesNotMatch(text, /agentbox-results-/);
    assert.throws(() => statSync(resultsDir(path)), "nothing was written");
  } finally {
    cleanup();
  }
});

test("a withheld result is not kept: the secret was the reason for withholding it", () => {
  const { path, cleanup } = home();
  try {
    const secret = `token=${"s".repeat(4_000)}`;
    const stored = storableResult(block(secret), "ran a command on the host", keep(path));
    assert.equal((stored.content as { text: string }[])[0]!.text, "ran a command on the host");
    assert.throws(() => statSync(resultsDir(path)));
  } finally {
    cleanup();
  }
});

test("a short result is left alone, and a caller with no turn keeps nothing", () => {
  const { path, cleanup } = home();
  try {
    const stored = storableResult(block("brief"), undefined, keep(path));
    assert.equal((stored.content as { text: string }[])[0]!.text, "brief");
    assert.throws(() => statSync(resultsDir(path)));

    // The parameter is optional, and without it the old behaviour is exactly the old one.
    const unkept = storableResult(block("y".repeat(5_000)));
    const text = (unkept.content as { text: string }[])[0]!.text;
    assert.equal(text.length, DURABLE_RESULT_CHARS);
    assert.doesNotMatch(text, /kept:/);
  } finally {
    cleanup();
  }
});

test("a failed call is kept too, and says it failed", () => {
  const { path, cleanup } = home();
  try {
    const stored = storableResult(
      { ...block("stack trace\n".repeat(400)), is_error: true },
      undefined,
      keep(path)
    );
    const text = (stored.content as { text: string }[])[0]!.text;
    const pointer = /full output kept: (\S+)/.exec(text);
    assert.ok(pointer !== null);
    assert.equal(readFrontmatter(readFileSync(pointer[1]!, "utf8")).is_error, "true");
    assert.equal(stored.is_error, true);
  } finally {
    cleanup();
  }
});

test("a turn is not lost because the result could not be filed", () => {
  const { path, cleanup } = home();
  try {
    // A home that cannot be written into — a plain file where a directory has to go — so
    // the write is impossible. The turn is not.
    writeFileSync(join(path, "blocked"), "not a directory");
    const stored = storableResult(block("z".repeat(5_000)), undefined, {
      ...keep(path),
      home: join(path, "blocked"),
    });
    const text = (stored.content as { text: string }[])[0]!.text;
    assert.match(text, /could not keep the whole result/);
    assert.ok(text.startsWith("z".repeat(100)), "and the head is stored as it always was");
  } finally {
    cleanup();
  }
});

test("two calls in one turn are two files; the same call is one path", () => {
  const { path, cleanup } = home();
  try {
    const first = keptResultPath({ turnId: "t", toolUseId: "toolu_a", at: new Date(Date.UTC(2026, 8, 22)) }, path);
    const second = keptResultPath({ turnId: "t", toolUseId: "toolu_b", at: new Date(Date.UTC(2026, 8, 22)) }, path);
    assert.notEqual(first, second);
    assert.match(first, /results\/2026-09\/t-toolu_a\.txt$/);
    // A name that tried to leave the directory cannot.
    const escaped = keptResultPath({ turnId: "../../etc", toolUseId: "p", at: new Date(Date.UTC(2026, 8, 22)) }, path);
    assert.doesNotMatch(escaped, /\.\./);
    assert.ok(escaped.startsWith(resultsDir(path)));
  } finally {
    cleanup();
  }
});

test("kept results age out in the same pass as kept pages", () => {
  const { path, cleanup } = home();
  try {
    resetKeptPruneClock();
    const now = new Date(Date.UTC(2026, 8, 22, 12, 0, 0));
    const old = keepToolResult(
      { text: "old", turnId: "t1", toolUseId: "u1", agent: { id: "a", name: "N" }, at: new Date(Date.UTC(2026, 3, 1)) },
      path
    );
    const fresh = keepToolResult(
      { text: "fresh", turnId: "t2", toolUseId: "u2", agent: { id: "a", name: "N" }, at: now },
      path
    );
    // Taken by mtime, which is a fact, not by the name, which is a claim.
    const stale = new Date(now.getTime() - 120 * 86_400_000);
    utimesSync(old.path, stale, stale);

    const result = pruneFetched(path, { retentionDays: 90, now, roots: [resultsDir(path)] });
    assert.deepEqual(result, { removed: 1, kept: 1 });
    assert.throws(() => statSync(old.path));
    assert.ok(statSync(fresh.path).isFile());
  } finally {
    cleanup();
  }
});
