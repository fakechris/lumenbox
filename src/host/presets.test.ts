/**
 * Presets as data: the parts that are wrong quietly — a prompt that loses a quote,
 * a relay that hands out nothing, an engine name that does not exist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateEnv, PRESETS, presetNamed, quoteForShell } from "./presets.ts";
import * as presetsModule from "./presets.ts";

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

test("a headless run grants its own tools and carries the relay's model", () => {
  // Measured on opencode 1.18.25: without --auto every tool permission is silently
  // rejected, and the model only travels as a flag. A run that loses either "works"
  // and does nothing — the quiet kind of wrong this file exists for.
  const opencode = presetNamed("opencode")!;
  assert.match(opencode.run("'x'"), /--auto/, "permissions granted, or the engine is inert");
  assert.match(opencode.run("'x'", "minimax-cn/MiniMax-M3"), /-m minimax-cn\/MiniMax-M3 'x'/, "a qualified id names a catalogue provider and passes through");
  assert.match(opencode.run("'x'", "MiniMax-M3.1-Flash"), /-m lumenbox\/MiniMax-M3.1-Flash 'x'/, "a bare id is the relay's model, under the relay's provider entry");
  assert.doesNotMatch(opencode.run("'x'"), /-m /, "no model named means no flag, not an empty one");
  const claude = presetNamed("claude")!;
  assert.match(claude.run("'x'", "some-model"), /--model some-model/);
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
    assert.equal(env.LUMENBOX_RELAY_URL, "http://relay.local:8788");
    assert.equal(env.LUMENBOX_RELAY_TOKEN, "box-scoped-token");
    assert.equal(env.MINIMAX_API_KEY, undefined, "no vendor variable: a catalogue provider lit by the relay token sends it to the vendor (INV-1359)");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
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

test("opencode is driven through its global config: the relay as a provider, the token a reference, the SDK by wire", () => {
  // Measured by the INV-1359 matrix (2026-10-26): with the token in MINIMAX_API_KEY opencode
  // routed to minimax-cn directly and died with "Unexpected server error"; the relay saw no call.
  const opencode = presetNamed("opencode")!;
  const config = opencode.relayConfig!("http://host:7777/relay/abc/", "LUMENBOX_RELAY_TOKEN", "anthropic", "MiniMax-M3.1-Flash");
  assert.equal(config.file, "/home/box/.config/opencode/opencode.json");
  const parsed = JSON.parse(config.content) as { provider: { lumenbox: { npm: string; options: { baseURL: string; apiKey: string }; models: Record<string, unknown> } } };
  assert.equal(parsed.provider.lumenbox.npm, "@ai-sdk/anthropic");
  assert.equal(parsed.provider.lumenbox.options.baseURL, "{env:LUMENBOX_RELAY_URL}/v1", "the route is a reference too, so concurrent jobs never cross; the SDK appends /messages and the relay forwards /v1/messages");
  assert.ok(!config.content.includes("relay/abc"), "no per-job route in a file every job shares");
  assert.equal(parsed.provider.lumenbox.options.apiKey, "{env:LUMENBOX_RELAY_TOKEN}", "the token is a reference, never inline");
  assert.deepEqual(Object.keys(parsed.provider.lumenbox.models), ["MiniMax-M3.1-Flash"]);
  assert.ok(!config.content.includes("box-scoped"), "no secret in the file");
  const openai = JSON.parse(opencode.relayConfig!("u", "T", "openai", "m").content) as { provider: { lumenbox: { npm: string } } };
  assert.equal(openai.provider.lumenbox.npm, "@ai-sdk/openai-compatible");
});

test("pi is driven through a models.json entry that names the relay, and Claude Code's runtime is its environment", () => {
  const pi = presetNamed("pi")!;
  assert.deepEqual(pi.wires, ["anthropic", "openai"]);
  const config = pi.relayConfig!("http://host/relay/abc", "LUMENBOX_RELAY_TOKEN", "openai", "MiniMax-M3");
  const parsed = JSON.parse(config.content) as { providers: { lumenbox: { baseUrl: string; api: string; apiKey: string; models: { id: string }[] } } };
  assert.equal(parsed.providers.lumenbox.baseUrl, "http://host/relay/abc");
  assert.equal(parsed.providers.lumenbox.api, "openai-completions");
  assert.equal(parsed.providers.lumenbox.apiKey, "$LUMENBOX_RELAY_TOKEN", "the token is a reference, never inline");
  assert.deepEqual(parsed.providers.lumenbox.models, [{ id: "MiniMax-M3" }]);
  assert.match(pi.run("'fix it'", "MiniMax-M3"), /pi -p --no-session --approve --mode json --model 'lumenbox\/MiniMax-M3' 'fix it'/);
  assert.deepEqual(pi.relayEnv("http://host/relay/abc", "tok"), { LUMENBOX_RELAY_TOKEN: "tok" });

  const claude = presetNamed("claude")!;
  assert.deepEqual(claude.wires, ["anthropic"]);
  const env = claude.relayEnv("http://host/relay/abc", "tok", "MiniMax-M3");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://host/relay/abc");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(env.ANTHROPIC_MODEL, "MiniMax-M3");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/box/.claude");
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.match(claude.run("'x'", "claude-sonnet-5"), /--model claude-sonnet-5/);
});

test("an engine chosen at use time installs pinned, on the work volume, and is found on the PATH", () => {
  const { installCommand, withEnginesPath, ENGINES_DIR } = presetsModule;
  const claude = presetNamed("claude")!;
  const command = installCommand(claude);
  assert.match(command, new RegExp(`npm install -g --prefix ${ENGINES_DIR} '@anthropic-ai/claude-code@2\\.1\\.250'`));
  assert.match(command, /ln -sfn \/home\/box\/work\/skills ~\/.claude\/skills/);
  assert.doesNotMatch(command, /@latest/);
  const pi = presetNamed("pi")!;
  assert.match(installCommand(pi), /--ignore-scripts/, "pi's own install instruction");
  assert.match(withEnginesPath("command -v claude"), /export PATH="\$PATH:\/home\/box\/work\/\.lumenbox\/engines\/bin"; command -v claude/);
  for (const preset of PRESETS) {
    assert.match(preset.install.version, /^\d+\.\d+\.\d+$/, `${preset.name} is pinned`);
  }
});

test("Claude Code routes permissions to the face when told to, and opens or resumes its thread by capsule id", () => {
  const claude = presetNamed("claude")!;
  const routed = claude.run("'x'", undefined, `--mcp-config '/f.json' --strict-mcp-config ${claude.permissionArgs}`);
  assert.doesNotMatch(routed, /--dangerously-skip-permissions/);
  assert.match(routed, /--permission-prompt-tool mcp__lumenbox__permission/);
  assert.match(claude.run("'x'"), /--dangerously-skip-permissions/, "no face, no prompt tool: skipped, as before");
  assert.equal(claude.session!("abc", false), "--session-id abc");
  assert.equal(claude.session!("abc", true), "--resume abc");
});

test("every engine whose report the host reads is run in the mode that writes it (INV-908)", async () => {
  const { MACHINE_OUTPUT } = await import("./engine-report.ts");
  for (const [engine, flag] of Object.entries(MACHINE_OUTPUT)) {
    const preset = presetNamed(engine)!;
    assert.ok(preset.run("'go'", "m").includes(` ${flag}`), `${engine} runs with ${flag}`);
  }
});

test("mcode runs one-shot with full permissions, its profile written per run and never a file with the token in it (INV-1233)", () => {
  const mcode = presetNamed("mcode")!;
  const run = mcode.run("'fix the tests'", "MiniMax-M3", undefined);
  // The default, smart, sends tool inputs to MiniMax's cloud gateway; full keeps the box the sandbox.
  assert.match(run, /mcode exec .*--permission full/);
  assert.doesNotMatch(run, /--permission (smart|off)/);
  assert.match(run, /--max-steps \d+/);
  assert.match(run, /--model "custom_provider:lumenbox\/\$m"/);
  assert.match(run, /'fix the tests'$/);
  // The profile lives in a directory made for the run and removed when it ends, however it ends.
  assert.match(run, /mktemp -d/);
  assert.match(run, /trap 'rm -rf "\$d"' EXIT/);
  assert.match(run, /trap 'rm -rf "\$d"; exit 143' TERM INT HUP/, "a session ended by boxd's TERM must not leave the profile behind");
  assert.match(run, /MINIMAX_DATA_DIR="\$d"/);
  assert.match(run, /goal:\\n  verification: subagent/, "a custom provider defaults to no verification; ours insists on a sub-agent");
  // The token reaches the profile from the environment at run time and is never inlined.
  const env = mcode.relayEnv("http://host:7777/relay/abc", "tok-secret", "MiniMax-M3");
  assert.equal(env.LUMENBOX_RELAY_TOKEN, "tok-secret");
  assert.equal(env.MCODE_DISABLE_TELEMETRY, "1");
  assert.doesNotMatch(run, /tok-secret/);
  const config = mcode.relayConfig!("http://host:7777/relay/abc", "LUMENBOX_RELAY_TOKEN", "anthropic", "MiniMax-M3");
  assert.doesNotMatch(config.content, /tok-secret/);
  assert.equal(config.env.LUMENBOX_RELAY_API, "anthropic-messages");
  assert.equal(mcode.relayConfig!("u", "T", "openai", "m").env.LUMENBOX_RELAY_API, "openai-completions");
  assert.deepEqual(mcode.wires, ["anthropic", "openai"]);
  // No model named: the run insists on one from the relay rather than letting mcode pick.
  assert.match(mcode.run("'x'"), /LUMENBOX_RELAY_MODEL:\?/);
});
