/** The box's CPU ceiling (INV-1552): half the engine's cores by default, at least 2, and only when given. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultCpusFor } from "./box-cpus.ts";
import { BoxManager } from "./docker.ts";
import { validCpus } from "../config.ts";

test("by default a box may use half the engine's cores, and never fewer than two", () => {
  assert.deepEqual([12, 16, 8, 3, 2, 1].map(defaultCpusFor), ["6", "8", "4", "2", "2", "2"]);
});

test("a ceiling from the settings file or the page is a finite number of cores from 0.5 to 1024, nothing else", () => {
  assert.deepEqual(["4", 2.5, " 6 ", "0.5"].map(validCpus), ["4", "2.5", "6", "0.5"]);
  for (const bad of ["0.1", "1e309", "2000", true, [2], "two", "", null, -1]) assert.equal(validCpus(bad), undefined, `${JSON.stringify(bad)} is refused`);
});

test("the run arguments carry --cpus with the chosen ceiling, and none without one", () => {
  const manager = new BoxManager({ containerName: "t", image: "i", boxdPort: 0, token: "x", host: "127.0.0.1", displayWidth: 1280, displayHeight: 800, runArgs: [] });
  const capped = manager.runArguments("6");
  assert.equal(capped[capped.indexOf("--cpus") + 1], "6");
  assert.equal(manager.runArguments().includes("--cpus"), false);
});
