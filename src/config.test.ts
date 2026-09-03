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
import { statSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  applyConfigEnv,
  configPath,
  ensureConfigFile,
  envNumber,
  loadConfig,
  saveConfig,
} from "./config.ts";
import { resolveProvider } from "./host/provider.ts";

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


// ── the persisted provider choice ────────────────────────────────────────────────────

test("provider, model, baseUrl and env load, and wrong types are ignored loudly", () => {
  const { warnings } = withHome(
    '{"activityLimit": 10, "provider": "minimax", "model": " M3 ", "baseUrl": 7, ' +
      '"env": {"GOOD_KEY": "value", "BAD_KEY": 42}}'
  );
  const config = loadConfig(line => warnings.push(line));
  assert.equal(config.provider, "minimax");
  assert.equal(config.model, "M3", "strings are trimmed");
  assert.equal(config.baseUrl, undefined, "a number is not a URL");
  assert.deepEqual(config.env, { GOOD_KEY: "value" });
  assert.ok(warnings.some(line => /baseUrl/.test(line)));
  assert.ok(warnings.some(line => /env\.BAD_KEY/.test(line)));
});

test("saveConfig merges into the file and keeps keys it does not know", () => {
  withHome('{"activityLimit": 55, "somethingLater": true, "env": {"KEEP": "me"}}');
  saveConfig({ provider: "minimax", env: { NEW_KEY: "abc" } });

  const raw = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.equal(raw.activityLimit, 55, "untouched fields survive");
  assert.equal(raw.somethingLater, true, "unknown keys survive a save from this version");
  assert.equal(raw.provider, "minimax");
  assert.deepEqual(raw.env, { KEEP: "me", NEW_KEY: "abc" }, "env merges, not replaces");

  // The file may hold a key now, so it is private even if it was not before.
  assert.equal(statSync(configPath()).mode & 0o777, 0o600);

  // null clears; absent leaves alone.
  saveConfig({ model: null, provider: null, env: { KEEP: null } });
  const cleared = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.equal(cleared.provider, undefined);
  assert.deepEqual(cleared.env, { NEW_KEY: "abc" });
});

test("the config's env sits under the real environment, never over it", () => {
  withHome();
  delete process.env.AGENTBOX_TEST_FROM_CONFIG;
  process.env.AGENTBOX_TEST_FROM_SHELL = "shell";
  try {
    applyConfigEnv({
      activityLimit: 400,
      env: { AGENTBOX_TEST_FROM_CONFIG: "config", AGENTBOX_TEST_FROM_SHELL: "config" },
    });
    assert.equal(process.env.AGENTBOX_TEST_FROM_CONFIG, "config");
    assert.equal(process.env.AGENTBOX_TEST_FROM_SHELL, "shell", "an exported variable wins");
  } finally {
    delete process.env.AGENTBOX_TEST_FROM_CONFIG;
    delete process.env.AGENTBOX_TEST_FROM_SHELL;
  }
});

test("provider precedence: flag beats env beats config beats default", () => {
  // The failure this ordering prevents: a restart that forgot the flag silently
  // switching to a different company's model with a credential that cannot work.
  const provider = process.env.AGENTBOX_PROVIDER;
  const baseUrl = process.env.AGENTBOX_BASE_URL;
  delete process.env.AGENTBOX_BASE_URL;
  try {
    delete process.env.AGENTBOX_PROVIDER;
    assert.equal(resolveProvider(undefined, "minimax").label, "MiniMax (China)", "config default holds");
    assert.equal(resolveProvider(undefined, undefined).label, "Anthropic", "no config, old default");

    process.env.AGENTBOX_PROVIDER = "anthropic";
    assert.equal(resolveProvider(undefined, "minimax").label, "Anthropic", "env beats config");
    assert.equal(resolveProvider("minimax", "anthropic").label, "MiniMax (China)", "flag beats both");
  } finally {
    if (provider === undefined) delete process.env.AGENTBOX_PROVIDER;
    else process.env.AGENTBOX_PROVIDER = provider;
    if (baseUrl !== undefined) process.env.AGENTBOX_BASE_URL = baseUrl;
  }
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

test("a box whose class cannot be read is treated as shared, not dropped", () => {
  // Dropping the entry would land the box on the same default, silently — the reader
  // would see "shared" either way and never learn their config was wrong. The default is
  // only honest because it is the class that promises nothing; a typo must not be able to
  // turn that into a promise, and must not be able to hide itself either.
  const { warnings } = withHome(
    JSON.stringify({
      boxes: {
        "agentbox-box": { access: "shared", group: "\u5e73\u53f0\u7ec4" },
        "agentbox-dana": { access: "private" },
        "agentbox-typo": { access: "priavte" },
      },
    })
  );
  const boxes = loadConfig(line => warnings.push(line)).boxes;
  assert.deepEqual(boxes?.["agentbox-box"], { access: "shared", group: "\u5e73\u53f0\u7ec4" });
  assert.deepEqual(boxes?.["agentbox-dana"], { access: "private" });
  assert.deepEqual(boxes?.["agentbox-typo"], { access: "shared" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /agentbox-typo/);
});

test("startupItem can be loaded and saved", () => {
  withHome();
  assert.equal(loadConfig().startupItem, undefined);

  saveConfig({ startupItem: true });
  assert.equal(loadConfig().startupItem, true);

  saveConfig({ startupItem: false });
  assert.equal(loadConfig().startupItem, undefined);

  saveConfig({ startupItem: true });
  assert.equal(loadConfig().startupItem, true);

  saveConfig({ startupItem: null });
  assert.equal(loadConfig().startupItem, undefined);
});

