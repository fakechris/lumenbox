/**
 * Presets as data: the parts that are wrong quietly — a prompt that loses a quote,
 * a relay that hands out nothing, an engine name that does not exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateEnv, PRESETS, presetNamed, quoteForShell } from "./presets.ts";

test("a prompt survives quoting, including the character that would end it", () => {
  assert.equal(quoteForShell("make the tests pass"), "'make the tests pass'");
  // The one that matters: an apostrophe in prose must not close the quote and turn
  // the rest of a brief into shell.
  assert.equal(quoteForShell("don't break it"), `'don'\\''t break it'`);
  assert.match(quoteForShell("rm -rf /; echo $HOME"), /^'.*'$/);
});

test("every preset is complete, and a run carries the prompt", () => {
  for (const preset of PRESETS) {
    assert.match(preset.probe, /command -v/, `${preset.name} says how to check it is there`);
    assert.match(preset.run("'x'"), /'x'/, `${preset.name} passes the prompt through`);
    assert.notEqual(preset.summary, "", `${preset.name} tells a model when to pick it`);
  }
  assert.equal(presetNamed("opencode")?.name, "opencode");
  assert.equal(presetNamed("nothing-like-this"), undefined);
});

test("without a relay a delegated engine gets nothing, and with one it gets only the relay", () => {
  const preset = presetNamed("opencode")!;
  const url = process.env.AGENTBOX_RELAY_URL;
  const token = process.env.AGENTBOX_RELAY_TOKEN;
  try {
    delete process.env.AGENTBOX_RELAY_URL;
    delete process.env.AGENTBOX_RELAY_TOKEN;
    assert.deepEqual(delegateEnv(preset), {}, "no relay, no credential — never ours instead");

    process.env.AGENTBOX_RELAY_URL = "http://relay.local:8788";
    process.env.AGENTBOX_RELAY_TOKEN = "box-scoped-token";
    const env = delegateEnv(preset);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://relay.local:8788");
    assert.equal(env.ANTHROPIC_API_KEY, "box-scoped-token");
    assert.ok(
      !Object.values(env).includes(process.env.MINIMAX_API_KEY ?? " "),
      "the installation's own key never travels"
    );
  } finally {
    if (url === undefined) delete process.env.AGENTBOX_RELAY_URL;
    else process.env.AGENTBOX_RELAY_URL = url;
    if (token === undefined) delete process.env.AGENTBOX_RELAY_TOKEN;
    else process.env.AGENTBOX_RELAY_TOKEN = token;
  }
});
