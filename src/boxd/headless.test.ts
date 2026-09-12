/**
 * A box without a desktop, and the directories it may touch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Roots, headlessRefusal, parseRepositories } from "./headless.ts";

test("repositories come from JSON in the environment; anything malformed is no restriction", () => {
  assert.deepEqual(parseRepositories(undefined), []);
  assert.deepEqual(parseRepositories("not json"), []);
  assert.deepEqual(parseRepositories('{"path":"/x"}'), []);
  const parsed = parseRepositories('[{"path":"/tmp/a","mode":"ro"},{"path":"/tmp/b"},{"nope":1}]');
  assert.deepEqual(parsed.map(r => [r.path, r.mode]), [["/tmp/a", "ro"], ["/tmp/b", "rw"]]);
});

test("inside an rw root is fine, inside an ro root refuses writes, outside refuses everything, a symlink out is outside", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentbox-roots-")));
  try {
    const rw = join(dir, "proj");
    const ro = join(dir, "docs");
    const elsewhere = join(dir, "else");
    for (const d of [rw, ro, elsewhere]) mkdirSync(d);
    writeFileSync(join(rw, "a.txt"), "x");
    symlinkSync(elsewhere, join(rw, "escape"));
    const roots = new Roots([{ path: rw, mode: "rw" }, { path: ro, mode: "ro" }]);
    assert.equal(roots.restricted, true);
    assert.equal(roots.refusal(join(rw, "a.txt"), "rw"), undefined);
    assert.equal(roots.refusal(join(rw, "new", "deep", "file.txt"), "rw"), undefined, "a path that does not exist yet is judged by its ancestor");
    assert.equal(roots.refusal(rw, "ro"), undefined, "the root itself");
    assert.match(roots.refusal(join(ro, "readme.md"), "rw") ?? "", /may only read/);
    assert.equal(roots.refusal(join(ro, "readme.md"), "ro"), undefined);
    assert.match(roots.refusal(join(elsewhere, "x"), "ro") ?? "", /outside the directories this box may touch/);
    assert.match(roots.refusal(join(rw, "escape", "x"), "ro") ?? "", /outside/, "a symlink inside pointing out is outside");
    assert.match(roots.refusal(`${rw}-sibling/x`, "ro") ?? "", /outside/, "a sibling with the root as a prefix is not inside");
    assert.equal(new Roots([]).refusal("/anything", "rw"), undefined, "no roots, no restriction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a headless box refuses the desktop routes with a sentence and serves the rest", () => {
  for (const route of ["POST /computer", "POST /browser", "POST /displays/ensure", "POST /displays/control", "GET /displays", "POST /record/start", "GET /recordings", "POST /clipboard/read", "POST /teach/claim", "POST /xwatchdog/events"]) {
    assert.match(headlessRefusal(route) ?? "", /no desktop/, route);
  }
  for (const route of ["POST /exec", "POST /fs/read", "POST /fs/write", "POST /fs/list", "POST /jobs", "POST /jobs/wait", "GET /health"]) {
    assert.equal(headlessRefusal(route), undefined, route);
  }
});
