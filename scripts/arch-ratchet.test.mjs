/**
 * The ratchet only turns one way (INV-1225): every way it must fail, and the ways it passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { earned, lowered, scan, verify } from "./arch-ratchet.mjs";

const lines = n => `${"x\n".repeat(n - 1)}x`;
function tree(spec) {
  const root = mkdtempSync(join(tmpdir(), "arch-"));
  for (const [path, text] of Object.entries(spec)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const baseline = (files, env, allowed = ["src/config.ts"]) => ({ size: { limit: 1000, files }, env: { allowed, files: env } });

test("scan: production .ts only, counting lines and env reads", () => {
  const root = tree({
    "src/a.ts": lines(1200),
    "src/b.ts": "const x = process.env.X;\n",
    "src/b.test.ts": lines(5000),
    "src/testing/fake.ts": lines(5000),
    "src/fixtures/x.ts": lines(5000),
    "src/c.md": lines(5000),
  });
  try {
    assert.deepEqual(scan(root), [
      { path: "src/a.ts", lines: 1200, readsEnv: false },
      { path: "src/b.ts", lines: 2, readsEnv: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean tree against its earned baseline passes; every violation names its file and what to do", () => {
  const root = tree({ "src/big.ts": lines(1200), "src/env.ts": "process.env.A\n", "src/config.ts": "process.env.B\n", "src/small.ts": lines(10) });
  try {
    const files = scan(root);
    const base = earned(baseline({}, []), files);
    assert.deepEqual(base, { size: { limit: 1000, files: { "src/big.ts": 1200 } }, env: { allowed: ["src/config.ts"], files: ["src/env.ts"] } });
    assert.deepEqual(verify(base, files), []);

    // A listed file grew.
    assert.match(verify(base, files.map(f => (f.path === "src/big.ts" ? { ...f, lines: 1201 } : f))).join("\n"), /src\/big\.ts is 1201 lines, over its ceiling of 1200/);
    // A new file over the limit.
    assert.match(verify(base, [...files, { path: "src/new.ts", lines: 1500, readsEnv: false }]).join("\n"), /src\/new\.ts is 1500 lines, over the 1000-line limit, and is not in the baseline: split it/);
    // A new env reader outside the layers.
    assert.match(verify(base, [...files, { path: "src/new.ts", lines: 3, readsEnv: true }]).join("\n"), /src\/new\.ts reads process\.env outside the configuration and startup layers/);
    // A stale size entry, a stale env entry, a gone file.
    assert.match(verify(base, files.map(f => (f.path === "src/big.ts" ? { ...f, lines: 900 } : f))).join("\n"), /src\/big\.ts is 900 lines, within the limit: remove its baseline entry/);
    assert.match(verify(base, files.map(f => (f.path === "src/env.ts" ? { ...f, readsEnv: false } : f))).join("\n"), /src\/env\.ts no longer reads process\.env: remove its baseline entry/);
    assert.match(verify(base, files.filter(f => f.path !== "src/big.ts")).join("\n"), /baseline lists src\/big\.ts \(1200 lines\) but the file is gone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("against the merge base, a baseline may only lose entries and lower ceilings; the allowed layers are a rule, changed on purpose", () => {
  const files = [{ path: "src/big.ts", lines: 1200, readsEnv: false }, { path: "src/env.ts", lines: 2, readsEnv: true }, { path: "src/other.ts", lines: 1100, readsEnv: true }];
  const before = baseline({ "src/big.ts": 1200 }, ["src/env.ts"]);
  const gained = baseline({ "src/big.ts": 1200, "src/other.ts": 1100 }, ["src/env.ts", "src/other.ts"]);
  const problems = verify(gained, files, before).join("\n");
  assert.match(problems, /baseline gained src\/other\.ts: the ratchet only turns one way/);
  assert.match(problems, /baseline gained src\/other\.ts as an env reader/);
  const raised = baseline({ "src/big.ts": 1300 }, ["src/env.ts"]);
  assert.match(verify(raised, files.filter(f => f.path !== "src/other.ts"), before).join("\n"), /ceiling rose from 1200 to 1300/);
  const widened = baseline({ "src/big.ts": 1200 }, ["src/env.ts"], ["src/config.ts", "src/env.ts"]);
  assert.match(verify(widened, files.filter(f => f.path !== "src/other.ts"), before).join("\n"), /src\/env\.ts is both allowed and listed|was added to the env-reading layers/);
  // Lowering is fine, and the same tree against the same baseline is fine.
  assert.deepEqual(verify(baseline({ "src/big.ts": 1200 }, ["src/env.ts"]), files.filter(f => f.path !== "src/other.ts"), before), []);
});

test("--write-baseline lowers and removes, never adds", () => {
  const base = baseline({ "src/big.ts": 1200, "src/gone.ts": 1500 }, ["src/env.ts", "src/fixed.ts"]);
  const files = [
    { path: "src/big.ts", lines: 1100, readsEnv: false },
    { path: "src/env.ts", lines: 2, readsEnv: true },
    { path: "src/fixed.ts", lines: 2, readsEnv: false },
    { path: "src/new.ts", lines: 2000, readsEnv: true },
  ];
  assert.deepEqual(lowered(base, files), { size: { limit: 1000, files: { "src/big.ts": 1100 } }, env: { allowed: ["src/config.ts"], files: ["src/env.ts"] } });
  // And what it did not add is exactly what verify then refuses.
  assert.match(verify(lowered(base, files), files).join("\n"), /src\/new\.ts is 2000 lines.*not in the baseline[\s\S]*src\/new\.ts reads process\.env/);
});
