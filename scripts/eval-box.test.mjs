/** The eval box's guard (INV-1370): it removes only what it created, under its own prefix, and says what first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDisposable, boxMode, evalBoxName, renderTeardown, teardownList } from "./lib/eval-box.mjs";

test("an eval box name is under the prefix, and nothing else is removable", () => {
  assert.equal(evalBoxName("Matrix 7bb2461 x"), "lumenbox-eval-matrix-7bb2461-x");
  assert.throws(() => evalBoxName("  "), /run id/);
  assertDisposable("lumenbox-eval-matrix-1");
  for (const name of ["lumenbox-box", "agentbox", "lumenbox-eval-", "my-lumenbox-eval-x", undefined]) {
    assert.throws(() => assertDisposable(name), /Refusing to remove/, String(name));
  }
  assert.throws(() => teardownList("lumenbox-box"), /Refusing/);
});

test("the teardown list names every leftover of a created box, and only eval images", () => {
  const list = teardownList("lumenbox-eval-r1", { tokenPath: "/tmp/home/tokens/lumenbox-eval-r1", images: ["lumenbox-eval:0.3.7", "fakechris/lumenbox:0.3.7"] });
  assert.deepEqual(list.volumes, ["lumenbox-eval-r1-work", "lumenbox-eval-r1-config", "lumenbox-eval-r1-hostd"]);
  assert.equal(list.network, "lumenbox-eval-r1-net");
  assert.deepEqual(list.images, ["lumenbox-eval:0.3.7"], "a published image is never on the list");
  const text = renderTeardown(list);
  for (const part of ["container  lumenbox-eval-r1", "volume     lumenbox-eval-r1-work", "network    lumenbox-eval-r1-net", "token      /tmp/home/tokens/lumenbox-eval-r1", "image      lumenbox-eval:0.3.7"]) {
    assert.ok(text.includes(part), part);
  }
});

test("the mode: create by default, use when a box is named, keep on request", () => {
  assert.deepEqual(boxMode([], {}), { mode: "create" });
  assert.deepEqual(boxMode([], { AGENTBOX_CONTAINER: "lumenbox-eval-box" }), { mode: "use", name: "lumenbox-eval-box" }, "the old way still attaches and removes nothing");
  assert.deepEqual(boxMode(["--box", "keep"], {}), { mode: "keep" });
  assert.deepEqual(boxMode(["--box", "use", "other"], {}), { mode: "use", name: "other" });
  assert.deepEqual(boxMode(["--box", "create"], { AGENTBOX_CONTAINER: "x" }), { mode: "create" }, "an explicit create wins over the environment");
  assert.throws(() => boxMode(["--box", "use"], {}), /needs a box name/);
  assert.throws(() => boxMode(["--box", "nuke"], {}), /expected create, keep or use/);
});
