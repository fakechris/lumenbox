/**
 * Tests for provider resolution and capability gating.
 *
 * The failure these guard against is the one MiniMax demonstrated: a compatible
 * endpoint accepts a request containing a capability it does not implement and
 * returns 200. Nothing surfaces at the HTTP layer, so the guard has to be in how
 * we build the request, and that is worth pinning down.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeProvider, effectiveProviderFor, effortConfig, effortForKind, providerNames, resolveProvider, resolveProviderPreset, type ProviderProfile } from "./provider.ts";
import { modelConfigured } from "./model-readiness.ts";
import { buildTools } from "./tools.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `fn` with the given env, restoring whatever was there before. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN = {
  AGENTBOX_PROVIDER: undefined,
  AGENTBOX_BASE_URL: undefined,
  AGENTBOX_MODEL: undefined,
  AGENTBOX_MAX_TOKENS: undefined,
  AGENTBOX_VISION: undefined,
  AGENTBOX_CACHING: undefined,
  AGENTBOX_THINKING: undefined,
};

test("model readiness refuses only absent selected auth, preserving profiles and local endpoints", async () => {
  const anthropic = resolveProvider("anthropic"), other = resolveProvider("minimax");
  const absent = async () => null;
  assert.equal(await modelConfigured(anthropic, false, absent), false);
  assert.equal(await modelConfigured(other, false, async () => ({ authentication: {} })), false);
  assert.equal(await modelConfigured(anthropic, false, async () => ({ authentication: { type: "user_oauth" } })), true);
  assert.equal(await modelConfigured(anthropic, false, async () => { throw new Error("unreadable config"); }), true);
  assert.equal(await modelConfigured({ ...other, baseUrl: "http://localhost:1234" }, false, absent), true);
  for (const vars of [
    { ANTHROPIC_API_KEY: "fixture", ANTHROPIC_AUTH_TOKEN: undefined },
    { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "fixture" },
    { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
  ]) {
    let ready: Promise<boolean> | undefined;
    withEnv(vars, () => { ready = modelConfigured(anthropic, undefined, absent); });
    assert.equal(await ready, Boolean(vars.ANTHROPIC_API_KEY || vars.ANTHROPIC_AUTH_TOKEN));
  }
});

test("anthropic is the default and has every capability", () => {
  withEnv(CLEAN, () => {
    const profile = resolveProvider();
    assert.equal(profile.label, "Anthropic");
    assert.equal(profile.model, "claude-opus-5");
    assert.equal(profile.vision, true);
    assert.equal(profile.promptCaching, true);
    assert.equal(profile.adaptiveThinking, true);
    assert.equal(profile.auth, "x-api-key");
  });
});

test("minimax defaults to M3, which can see", () => {
  withEnv(CLEAN, () => {
    const profile = resolveProvider("minimax");
    assert.equal(profile.model, "MiniMax-M3");
    assert.match(profile.baseUrl ?? "", /minimaxi\.com\/anthropic$/);
    assert.equal(profile.auth, "bearer", "third-party endpoints want Bearer");
    // Verified live: M3 read a real 1280x800 WebP screenshot back correctly.
    assert.equal(profile.vision, true);
    // Caching markers and adaptive thinking are still not sent. Effort is: omitting it leaves max.
    assert.equal(profile.promptCaching, false);
    assert.equal(profile.adaptiveThinking, false);
    assert.equal(profile.effort, true);
  });
});

test("effort follows the call, and a caller's value replaces the turn default", () => {
  const sending = { effort: true } as ProviderProfile;
  const silent = { effort: false } as ProviderProfile;
  assert.equal(effortForKind("turn"), "medium");
  assert.equal(effortForKind("delegate"), "medium");
  // A profile that names its own turn effort keeps it (INV-1613): Claude's turns were high before the split by kind.
  assert.equal(effortForKind("turn", { turnEffort: "high" }), "high");
  assert.equal(effortForKind("summarize", { turnEffort: "high" }), "low");
  assert.deepEqual(effortConfig({ ...sending, turnEffort: "high" }, "turn"), { output_config: { effort: "high" } });
  for (const kind of ["summarize", "memory", "review", "select", "steward", "handoff", "anomaly", "switch"] as const) {
    assert.equal(effortForKind(kind), "low", kind);
  }
  assert.deepEqual(effortConfig(sending, "turn"), { output_config: { effort: "medium" } });
  assert.deepEqual(effortConfig(sending, "summarize"), { output_config: { effort: "low" } });
  assert.deepEqual(effortConfig(sending, "turn", "xhigh"), { output_config: { effort: "xhigh" } });
  assert.deepEqual(effortConfig(silent, "turn", "max"), {});
});

test("vision follows the model, not the provider", () => {
  withEnv({ ...CLEAN, AGENTBOX_MODEL: "MiniMax-M2" }, () => {
    // M2 accepts images on the same endpoint and silently discards them.
    assert.equal(resolveProvider("minimax").vision, false);
  });

  withEnv({ ...CLEAN, AGENTBOX_MODEL: "MiniMax-M9-future" }, () => {
    // Unknown models are assumed blind: that is the assumption whose failure shows.
    assert.equal(resolveProvider("minimax").vision, false);
  });

  withEnv({ ...CLEAN, AGENTBOX_MODEL: "MiniMax-M9-future", AGENTBOX_VISION: "1" }, () => {
    // An explicit opt-in wins, so a newly-capable model needs no code change.
    assert.equal(resolveProvider("minimax").vision, true);
  });

  withEnv({ ...CLEAN, AGENTBOX_VISION: "0" }, () => {
    assert.equal(resolveProvider("minimax").vision, false, "opt-out also wins");
  });
});

test("a bare base URL selects the custom provider", () => {
  withEnv({ ...CLEAN, AGENTBOX_BASE_URL: "https://example.test/anthropic" }, () => {
    const profile = resolveProvider();
    assert.equal(profile.baseUrl, "https://example.test/anthropic");
    assert.equal(profile.label, "custom");
  });
});

test("custom capabilities default off and are opt-in", () => {
  withEnv({ ...CLEAN, AGENTBOX_BASE_URL: "https://example.test" }, () => {
    const off = resolveProvider("custom");
    // A wrong "yes" fails silently; a wrong "no" only costs a feature.
    assert.equal(off.vision, false);
    assert.equal(off.promptCaching, false);
    assert.equal(off.adaptiveThinking, false);
  });

  withEnv(
    {
      ...CLEAN,
      AGENTBOX_BASE_URL: "https://example.test",
      AGENTBOX_VISION: "1",
      AGENTBOX_CACHING: "true",
    },
    () => {
      const on = resolveProvider("custom");
      assert.equal(on.vision, true);
      assert.equal(on.promptCaching, true);
      assert.equal(on.adaptiveThinking, false, "not opted into");
    }
  );
});

test("AGENTBOX_MODEL overrides a preset's model", () => {
  withEnv({ ...CLEAN, AGENTBOX_MODEL: "MiniMax-M2" }, () => {
    assert.equal(resolveProvider("minimax").model, "MiniMax-M2");
  });
});

test("an unknown provider name is refused, not guessed at", () => {
  withEnv(CLEAN, () => {
    assert.throws(() => resolveProvider("gpt"), /Unknown provider "gpt"/);
  });
});

test("every advertised provider resolves", () => {
  withEnv(CLEAN, () => {
    for (const name of providerNames()) {
      assert.ok(resolveProvider(name).label, `${name} did not resolve`);
    }
  });
});

test("the computer tool is withheld from a model that cannot see", () => {
  const sighted = buildTools(true, true).map(tool => tool.name);
  const blind = buildTools(true, false).map(tool => tool.name);

  assert.ok(sighted.includes("computer"));
  assert.ok(
    !blind.includes("computer"),
    "offering a screen to a blind model invites it to invent one"
  );

  // Everything that does not need sight must survive.
  for (const name of ["bash", "read_file", "write_file", "list_dir", "SendToAgent"]) {
    assert.ok(blind.includes(name), `${name} should not depend on vision`);
  }
});

test("the prompt tells a blind agent it has no screen", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-provider-"));
  try {
    const registry = new AgentRegistry(root);
    const agent = registry.create({ name: "Ada" });
    const context = {
      agent,
      teammates: [agent],
      memory: [],
      resolution: {
        display: { width: 1280, height: 800 },
        api: { width: 1280, height: 800 },
      },
      agentsRoot: root,
      hasBox: true,
    };

    const blind = buildSystemPrompt({ ...context, vision: false });
    assert.match(blind, /do \*\*not\*\* have vision/i);
    assert.match(blind, /Never describe the contents of a screen/);
    assert.doesNotMatch(blind, /Screenshots come to you at/);

    const sighted = buildSystemPrompt({ ...context, vision: true });
    assert.match(sighted, /Screenshots come to you at 1280x800/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("describeProvider surfaces what is missing", () => {
  withEnv(CLEAN, () => {
    // MiniMax caches a repeated prefix on its own (measured 2026-09-01; the usage ledger shows
    // cache reads on every turn), so the header must not say it has none.
    assert.doesNotMatch(describeProvider(resolveProvider("minimax")), /no prompt caching/);
    assert.match(describeProvider(resolveProvider("deepseek")), /no prompt caching/);
    assert.doesNotMatch(describeProvider(resolveProvider("anthropic")), /no /);
  });
});

test("effectiveProviderFor: an agent's override wins; no override reuses the default object", () => {
  const fallback = resolveProvider("anthropic");

  // No override → the very same object, so the caller reuses the default client.
  assert.equal(effectiveProviderFor({}, fallback), fallback, "identity, not a copy");
  assert.equal(effectiveProviderFor({ provider: "", model: "" }, fallback), fallback, "empty is no override");

  // Model-only override keeps the provider, swaps the model, on a fresh object.
  const modelOnly = effectiveProviderFor({ model: "claude-haiku-4-5" }, fallback);
  assert.notEqual(modelOnly, fallback, "a copy, so the default is untouched");
  assert.equal(modelOnly.label, "Anthropic");
  assert.equal(modelOnly.model, "claude-haiku-4-5");
  assert.equal(fallback.model, "claude-opus-5", "the default object was not mutated");

  // Provider override resolves that preset; a model on top applies to it.
  const other = effectiveProviderFor({ provider: "minimax", model: "MiniMax-M2" }, fallback);
  assert.equal(other.label, "MiniMax (China)");
  assert.equal(other.model, "MiniMax-M2");
});

test("an agent's provider override keeps the provider-independent overrides, not the default's model or endpoint (INV-2084)", () => {
  withEnv({ ...CLEAN, AGENTBOX_VISION: "0", AGENTBOX_MAX_TOKENS: "4000", AGENTBOX_KEY_ENV: "RELAY_TOKEN", AGENTBOX_MODEL: "default-model", AGENTBOX_BASE_URL: "https://default.example" }, () => {
    const openai = effectiveProviderFor({ provider: "openai" }, resolveProvider("anthropic"));
    assert.equal(openai.label, "OpenAI");
    assert.equal(openai.vision, false, "AGENTBOX_VISION=0 holds on an override");
    assert.equal(openai.maxTokens, 4000);
    assert.equal(openai.keyEnv, "OPENAI_API_KEY", "the default's credential never goes to another provider's endpoint");
    assert.equal(resolveProvider("anthropic").keyEnv, "RELAY_TOKEN", "the installation's own provider still takes it");
    assert.equal(openai.model, resolveProviderPreset("openai")!.model, "the default's model does not leak (INV-2060)");
    assert.equal(openai.baseUrl, resolveProviderPreset("openai")!.baseUrl, "nor its endpoint");
  });
  withEnv({ ...CLEAN, AGENTBOX_VISION: "1" }, () => {
    assert.equal(effectiveProviderFor({ provider: "deepseek" }, resolveProvider("anthropic")).vision, true, "an opt-in reaches an override too");
  });
});

test("the automatic default uses a credentialed preset, not an unconfigured Anthropic or the wrong MiniMax region", () => {
  const openaiOnly = { ...CLEAN, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: undefined, OPENAI_API_KEY: "fixture" };
  withEnv(openaiOnly, () => {
    assert.equal(resolveProvider().label, "OpenAI");
    assert.equal(resolveProvider(undefined, "anthropic").label, "Anthropic", "explicit choice still wins");
  });
  withEnv({ ...openaiOnly, MINIMAX_CODE_CN_API_KEY: "fixture" }, () => {
    assert.equal(resolveProvider().label, "MiniMax (China)", "preset order breaks ties");
    assert.notEqual(resolveProvider("minimax-global").keyEnv, resolveProvider().keyEnv);
  });
  withEnv({ ...openaiOnly, ANTHROPIC_AUTH_TOKEN: "fixture" }, () => {
    assert.equal(resolveProvider().label, "Anthropic", "existing default wins when credentialed");
  });
});

test("every client speaks the pinned Messages API version, not the SDK's default (INV-1439)", async () => {
  const { createClient, ANTHROPIC_API_VERSION } = await import("./provider.ts");
  const { createServer } = await import("node:http");
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers["anthropic-version"]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = resolveProvider("minimax");
  const saved = process.env[base.keyEnv];
  try {
    process.env[base.keyEnv] = "test-key";
    const profile = { ...base, baseUrl: `http://127.0.0.1:${port}` };
    await createClient(profile).messages.create({ model: "x", max_tokens: 4, messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(seen, [ANTHROPIC_API_VERSION]);
    assert.equal(ANTHROPIC_API_VERSION, "2023-06-01");
  } finally {
    if (saved === undefined) delete process.env[base.keyEnv];
    else process.env[base.keyEnv] = saved;
    server.close();
  }
});
