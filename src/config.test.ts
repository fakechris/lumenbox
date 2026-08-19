/**
 * Tests for the config file.
 *
 * It is meant to be edited by hand, so the cases that matter are the malformed ones:
 * a config someone mistyped must not stop the UI from starting, and it must say what
 * it ignored rather than silently running on a different value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configPath,
  ensureConfigFile,
  loadConfig,
} from "./config.ts";

/** Each test gets its own home, so none of them sees another's config. */
function withHome(contents?: string): { warnings: string[] } {
  const home = mkdtempSync(join(tmpdir(), "agentbox-config-"));
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_CONFIG;
  if (contents !== undefined) writeFileSync(join(home, "config.json"), contents, "utf8");
  return { warnings: [] };
}

test("no config file means the defaults", () => {
  const { warnings } = withHome();
  assert.deepEqual(loadConfig(line => warnings.push(line)), DEFAULT_CONFIG);
  assert.deepEqual(warnings, []);
});

test("a value in the file wins over the default", () => {
  const { warnings } = withHome('{"activityLimit": 1200}');
  assert.equal(loadConfig(line => warnings.push(line)).activityLimit, 1200);
  assert.deepEqual(warnings, []);
});

test("unknown keys are ignored, so a newer config still loads", () => {
  const { warnings } = withHome('{"activityLimit": 10, "somethingLater": {"a": 1}}');
  assert.equal(loadConfig(line => warnings.push(line)).activityLimit, 10);
  assert.deepEqual(warnings, []);
});

test("broken JSON falls back to the defaults and says so", () => {
  const { warnings } = withHome('{"activityLimit": 400,}');
  assert.deepEqual(loadConfig(line => warnings.push(line)), DEFAULT_CONFIG);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /not valid JSON/);
});

test("a value of the wrong type falls back and says so", () => {
  const { warnings } = withHome('{"activityLimit": "lots"}');
  assert.equal(
    loadConfig(line => warnings.push(line)).activityLimit,
    DEFAULT_CONFIG.activityLimit
  );
  assert.match(warnings[0]!, /whole number/);
});

test("a number written as a string is still read", () => {
  const { warnings } = withHome('{"activityLimit": "50"}');
  assert.equal(loadConfig(line => warnings.push(line)).activityLimit, 50);
  assert.deepEqual(warnings, []);
});

test("an out-of-range value is clamped, not obeyed", () => {
  const { warnings } = withHome('{"activityLimit": 0}');
  assert.equal(loadConfig(line => warnings.push(line)).activityLimit, 1);
  assert.match(warnings[0]!, /between 1 and/);

  const huge = withHome('{"activityLimit": 999999999}');
  const limit = loadConfig(line => huge.warnings.push(line)).activityLimit;
  assert.ok(limit < 999999999, String(limit));
  assert.match(huge.warnings[0]!, /between 1 and/);
});

test("a config that is not an object falls back", () => {
  const { warnings } = withHome("[1, 2, 3]");
  assert.deepEqual(loadConfig(line => warnings.push(line)), DEFAULT_CONFIG);
  assert.match(warnings[0]!, /should contain an object/);
});

test("the file is written on first use, so the settings are findable", () => {
  withHome();
  const path = ensureConfigFile();
  assert.equal(path, configPath());
  assert.ok(existsSync(path));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), DEFAULT_CONFIG);

  // Writing again must not overwrite what someone edited.
  writeFileSync(path, '{"activityLimit": 7}\n', "utf8");
  ensureConfigFile();
  assert.equal(loadConfig().activityLimit, 7);
});
