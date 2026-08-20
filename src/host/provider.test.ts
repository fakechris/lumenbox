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
import { describeProvider, providerNames, resolveProvider } from "./provider.ts";
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
    // Accepted by the endpoint but not implemented, so not sent.
    assert.equal(profile.promptCaching, false);
    assert.equal(profile.adaptiveThinking, false);
  });
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
    assert.match(describeProvider(resolveProvider("minimax")), /no prompt caching/);
    assert.doesNotMatch(describeProvider(resolveProvider("anthropic")), /no /);
  });
});
