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
  envNumber,
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


test("a setting that is not a number falls back to the default, loudly", () => {
  // Every tunable here used to be `Number(process.env.X ?? default)`, in forty-two places.
  // `Number("4000x")` is NaN and every comparison against NaN is false, so a typo in a value did
  // not fall back to the default — it removed the limit. AGENTBOX_MEMORY_BUDGET=4000x put the whole
  // memory file into every system prompt.
  const said: string[] = [];
  const error = console.error;
  console.error = (line: string) => said.push(line);
  try {
    process.env.AGENTBOX_TEST_NUMBER = "4000x";
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 4_000), 4_000);
    assert.ok(
      said.some(line => /AGENTBOX_TEST_NUMBER="4000x" is not a number; using 4000/.test(line)),
      // Silence would be indistinguishable from a setting that had no effect, and the person who
      // set it would go looking for the bug in the product.
      `expected it to say so, got ${JSON.stringify(said)}`
    );

    process.env.AGENTBOX_TEST_NUMBER = "12";
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 4_000), 12);

    // Absent and empty both mean "not set", and neither is worth a warning.
    process.env.AGENTBOX_TEST_NUMBER = "  ";
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 7), 7);
    delete process.env.AGENTBOX_TEST_NUMBER;
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 7), 7);
    assert.equal(said.length, 1, "one complaint, for the one unreadable value");

    // Fractions and zero are settings, not errors: 0.35 is a real default here and a port of 0
    // means "pick one".
    process.env.AGENTBOX_TEST_NUMBER = "0.35";
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 1), 0.35);
    process.env.AGENTBOX_TEST_NUMBER = "0";
    assert.equal(envNumber("AGENTBOX_TEST_NUMBER", 5), 0);
  } finally {
    console.error = error;
    delete process.env.AGENTBOX_TEST_NUMBER;
  }
});
