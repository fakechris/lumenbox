/**
 * Rules about where things may live, checked against the sources rather than remembered.
 *
 * Each rule below was once a comment somebody was expected to have read. A guard that
 * scans the tree turns "we agreed" into "the build says" (TurnkeyAI's architecture-guard
 * test is the pattern; the rules are ours).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "catalog-data" || name === "node_modules") continue;
        walk(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(ROOT);
  return out;
}

test("ledgers append through jsonl.ts, which syncs; raw appends stay where they were", () => {
  // These two predate the rule and keep their own reasons (vault audit with mode 0600,
  // the activity feed as a best-effort log). Anything new appends through appendLine.
  const allowed = new Set(["host/jsonl.ts", "host/vault.ts", "web/activity.ts"]);
  const offenders = sources()
    .filter(file => /\bappendFileSync\(/.test(file.text) && !allowed.has(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, [], "a new raw appendFileSync: use appendLine from jsonl.ts");
});

test("the policy gate is asked from the few places that act, and nowhere else", () => {
  const allowed = new Set(["cli.ts", "host/mcp-face.ts", "host/tools.ts", "host/turn.ts", "web/server.ts"]);
  const offenders = sources()
    .filter(file => /\.check\(\{\s*kind:/.test(file.text) && !allowed.has(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, [], "a new caller of policy.check: add it here on purpose, with the reason");
});

test("an engine skips permissions only where presets.ts decides so", () => {
  const offenders = sources()
    .filter(file => file.text.includes("--dangerously-skip-permissions") && file.path !== "host/presets.ts")
    .map(file => file.path);
  assert.deepEqual(offenders, []);
});

test("policy limits are never read at module load", () => {
  // The bug of 2026-09-07: a constant built from process.env at import time, before the
  // config's env block landed. Only defaultLimits() may read those variables.
  const offenders = sources()
    .filter(file => file.path !== "host/policy.ts" && /AGENTBOX_APPROVAL_(TOOLS|COMMANDS)/.test(file.text))
    .filter(file => !/absences\.ts|config\.ts/.test(file.path))
    .map(file => file.path);
  assert.deepEqual(offenders, []);
});
