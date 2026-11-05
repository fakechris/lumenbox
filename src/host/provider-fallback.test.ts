/** When the agent's provider is out of usage the turn goes on with a fallback, and comes back after (INV-1578). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { fakeModel } from "./testing/fake-model.ts";
import { runTurn, type TurnEvent } from "./turn.ts";
import { gateClient, ProviderRests } from "./provider-rest.ts";
import { fallbackNames, nextFallback, switchLine, type Runtime } from "./provider-fallback.ts";
import { resolveProvider, type ProviderProfile } from "./provider.ts";

const TOKEN_PLAN_2056 = Object.assign(new Error('429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}'), { status: 429 });
const reply = (text: string): Anthropic.Message => ({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text, citations: null }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as Anthropic.Message;
const primary: ProviderProfile = { ...resolveProvider("anthropic"), label: "MiniMax (China)", model: "MiniMax-M3.1-Flash", baseUrl: "https://api.minimaxi.com/anthropic" };
const backup: ProviderProfile = { ...resolveProvider("anthropic"), label: "Backup", model: "backup-model", baseUrl: "https://backup.example" };
const ask = (text: string) => [{ id: `m-${text}`, fromId: "user", fromName: "user", text, priority: false, receivedAt: "" }];

test("scenario: the plan runs out mid-work; the round finishes on the fallback, the chat says so, spend is the fallback's; after the reset the agent is back on its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-fallback-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    let clock = Date.parse("2026-11-04T09:00:00Z");
    const rests = new ProviderRests({ now: () => clock });
    let exhausted = true, primaryCalls = 0, backupCalls = 0;
    const primaryClient = gateClient(fakeModel(() => { primaryCalls++; if (exhausted) throw TOKEN_PLAN_2056; return reply("Back on MiniMax."); }), "minimax-acct", primary.label, rests);
    const fallbacks: Runtime[] = [{ client: fakeModel(() => { backupCalls++; return reply("Done on the backup."); }), provider: backup }];
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const rows: { provider: string; model: string; outputTokens: number }[] = [];
    const usage = { record: (row: { provider: string; model: string; outputTokens: number }) => rows.push(row), notePromptCache: () => undefined, noteAnomaly: () => {} } as never;
    const events: TurnEvent[] = [];
    const deps = { client: primaryClient, provider: primary, fallbacks, registry, bus, box: undefined, resolution: undefined, usage, onEvent: (event: TurnEvent) => events.push(event) };

    await runTurn(ada, ask("summarise today"), new AbortController().signal, deps as never);
    assert.equal(primaryCalls, 1, "MiniMax was asked once and not retried");
    assert.equal(backupCalls, 1, "the same round went to the backup");
    assert.match(JSON.stringify(registry.readTranscript(ada.id)), /Done on the backup/);
    const switched = events.filter(event => event.type === "retrying") as { detail: string }[];
    assert.equal(switched.length, 1);
    assert.match(switched[0]!.detail, /MiniMax \(China\) is out of usage; this turn continues on Backup.*backup-model/);
    assert.deepEqual(rows.map(row => [row.provider, (row as { fallbackFor?: string }).fallbackFor]), [["Backup", "MiniMax (China)"]], "spend is recorded under the provider that answered, marked as standing in");

    // While MiniMax rests, the next turn does not even ask it: refused at the gate, straight to the backup.
    await runTurn(ada, ask("and the next thing"), new AbortController().signal, deps as never);
    assert.equal(primaryCalls, 1);
    assert.equal(backupCalls, 2);

    // The plan resets; the next turn starts on MiniMax again, and stays there.
    exhausted = false;
    clock += 15 * 60_000 + 1;
    await runTurn(ada, ask("one more"), new AbortController().signal, deps as never);
    assert.equal(primaryCalls, 2);
    assert.equal(backupCalls, 2);
    assert.equal(rows.at(-1)?.provider, "MiniMax (China)");
    assert.equal((rows.at(-1) as { fallbackFor?: string }).fallbackFor, undefined);
    assert.match(JSON.stringify(registry.readTranscript(ada.id).at(-1)), /Back on MiniMax/);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("each provider is tried at most once a turn; with every one out of usage the turn ends saying why", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-fallback-all-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    let calls = 0;
    const out = () => fakeModel(() => { calls++; throw TOKEN_PLAN_2056; });
    const second: ProviderProfile = { ...backup, label: "Second", model: "second-model" };
    const registry = new AgentRegistry(join(root, "agents"));
    const vic = registry.create({ name: "Vic" });
    const deps = { client: out(), provider: primary, fallbacks: [{ client: out(), provider: backup }, { client: out(), provider: second }, { client: out(), provider: backup }], registry, bus: new AgentBus(registry, async () => {}), box: undefined, resolution: undefined };
    await assert.rejects(runTurn(vic, ask("anything"), new AbortController().signal, deps as never), /用量上限/);
    assert.equal(calls, 3, "MiniMax, Backup and Second once each; Backup listed twice is still tried once");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("which fallbacks: the agent's own list wins, at most three, never the primary; a resting one is skipped; the line names the price when one is set", () => {
  const minimax = resolveProvider("minimax");
  assert.deepEqual(fallbackNames(["deepseek", "kimi"], ["glm"], minimax), ["deepseek", "kimi"]);
  assert.deepEqual(fallbackNames(undefined, ["glm", "deepseek", "kimi", "anthropic"], minimax), ["glm", "deepseek", "kimi"]);
  assert.deepEqual(fallbackNames(undefined, ["minimax", "deepseek"], minimax), ["deepseek"], "not the provider it falls back from");
  const rests = new ProviderRests();
  const a = { client: {} as Anthropic, provider: { ...backup, label: "A", keyEnv: "NO_SUCH_KEY_A" } };
  const b = { client: {} as Anthropic, provider: { ...backup, label: "B", keyEnv: "NO_SUCH_KEY_B" } };
  rests.failed("A|https://backup.example|nokey", "A", TOKEN_PLAN_2056);
  assert.equal(nextFallback([a, b], new Set(), rests)?.provider.label, "B", "A rests, so B");
  assert.equal(nextFallback([a, b], new Set([`B\0backup-model\0https://backup.example`]), rests), undefined, "B already tried");
  assert.match(switchLine(primary, backup, { "backup-model": { inputPerM: 0.27, outputPerM: 1.1 } }), /\$0\.27\/M in · \$1\.1\/M out/);
  assert.match(switchLine(primary, backup, {}), /no price configured/);
});

test("the fallback setting: admin only, presets only, at most three; the last day's fallback spend is summed per stand-in", async () => {
  const { fallbackRoute } = await import("../web/provider-fallback-routes.ts");
  let saved: string[] = [];
  const now = Date.parse("2026-11-05T02:00:00Z");
  const row = (at: string, provider: string, fallbackFor: string | undefined, input: number) => ({ seq: 1, at, agentId: "a", agentName: "Ada", provider, model: "m", round: 1, inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, ...(fallbackFor ? { fallbackFor } : {}) });
  const deps = (body: Record<string, unknown>, admin = true) => ({
    refusedAdmin: () => !admin, readJson: async () => body, names: () => saved, save: (names: string[]) => { saved = names; },
    presets: () => ["deepseek", "kimi", "glm", "anthropic"].map(name => ({ name, label: name, model: "m", hasKey: name !== "glm" })),
    usage: () => [row("2026-11-05T01:00:00Z", "deepseek", "MiniMax (China)", 100), row("2026-11-05T01:30:00Z", "deepseek", "MiniMax (China)", 50), row("2026-11-03T01:00:00Z", "deepseek", "MiniMax (China)", 999), row("2026-11-05T01:40:00Z", "MiniMax (China)", undefined, 7)] as never,
    now: () => now,
  });
  assert.equal((await fallbackRoute("GET /api/provider/fallbacks", deps({}, false)))?.status, 0, "refused to a non-admin");
  assert.equal((await fallbackRoute("POST /api/provider/fallbacks", deps({ names: ["deepseek", "nonsense"] })))?.status, 400);
  const posted = await fallbackRoute("POST /api/provider/fallbacks", deps({ names: ["deepseek", "kimi", "glm", "anthropic"] }));
  assert.deepEqual(saved, ["deepseek", "kimi", "glm"], "three at most, in order");
  const body = posted?.body as { lastDay: { provider: string; standingInFor: string; rounds: number; inputTokens: number }[]; presets: { hasKey: boolean }[] };
  assert.deepEqual(body.lastDay, [{ provider: "deepseek", standingInFor: "MiniMax (China)", rounds: 2, inputTokens: 150, outputTokens: 2 }], "only fallback rows, only the last day");
  assert.equal(body.presets.filter(preset => !preset.hasKey).length, 1);
});
