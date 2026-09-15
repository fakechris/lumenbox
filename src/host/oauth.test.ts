/**
 * The OAuth gate against a scripted provider: the dance lands a token in the vault, the
 * vault never shows it, a lapsed token is re-minted before it is handed out, and a
 * caller nobody granted gets nothing — with the refusal on the audit trail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "./vault.ts";
import { OAuthGate, scrubToken, type FetchLike } from "./oauth.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-oauth-"));
  const vault = new Vault(join(root, "vault.json"), join(root, "audit.jsonl"));
  const calls: { url: string; body: string }[] = [];
  const clock = { now: 1_800_000_000_000 };
  let mint = 0;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body ?? "" });
    mint += 1;
    if (url.includes("feishu")) {
      return { status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: `t-${mint}`, expire: 7200 }) };
    }
    const form = new URLSearchParams(init.body ?? "");
    if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good") {
      return { status: 200, text: async () => JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }) };
    }
    return { status: 200, text: async () => JSON.stringify({ access_token: `gh-${mint}`, refresh_token: `r-${mint}`, expires_in: 3600, token_type: "bearer" }) };
  };
  const gate = new OAuthGate(vault, fetchFn, () => clock.now);
  return { root, vault, gate, calls, clock };
}

test("the authorization-code dance lands a token the vault never shows, and refreshes it when it lapses", async () => {
  const { root, vault, gate, calls, clock } = harness();
  try {
    const { url, state } = gate.begin({ provider: "github", clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:7777/oauth/callback", grants: [{ holder: "agent:a1" }] });
    const sent = new URL(url);
    assert.equal(sent.origin + sent.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(sent.searchParams.get("state"), state);
    assert.equal(sent.searchParams.get("scope"), "repo read:org");

    await assert.rejects(gate.complete("nope", "good"), /unknown or has lapsed/);
    await assert.rejects(gate.complete(state, "bad"), /did not issue a token: The code passed/);
    // A failed exchange spent the state: start again.
    const again = gate.begin({ provider: "github", clientId: "cid", clientSecret: "csecret", redirectUri: "http://localhost:7777/oauth/callback", grants: [{ holder: "agent:a1" }] });
    const done = await gate.complete(again.state, "good");
    assert.equal(done.id, "oauth:github");
    assert.match(calls[1]!.body, /client_secret=csecret/, "the exchange carries the client secret to the provider");

    const view = vault.list().find(s => s.id === "oauth:github")!;
    assert.equal(view.oauth?.provider, "github");
    assert.equal(view.oauth?.expiresAt, new Date(clock.now + 3600_000).toISOString());
    assert.equal("value" in view, false);
    assert.equal("refreshToken" in (view.oauth ?? {}), false, "the view drops the refresh token");
    assert.deepEqual(gate.connected().map(c => c.provider), ["github"]);

    assert.equal(await gate.bearerFor("oauth:github", { agentId: "a1" }), "gh-2");
    assert.equal(calls.length, 2, "a live token is not refreshed");

    clock.now += 3600_000;
    assert.equal(await gate.bearerFor("oauth:github", { agentId: "a1" }), "gh-3", "a lapsed token is re-minted first");
    assert.match(calls[2]!.body, /grant_type=refresh_token&refresh_token=r-2/);
    assert.equal(vault.oauthOf("oauth:github")?.refreshToken, "r-3", "a rotated refresh token replaces the old one");

    // Not granted: nothing, and the refusal is audited.
    assert.equal(await gate.bearerFor("oauth:github", { agentId: "a9" }), undefined);
    const audit = readFileSync(join(root, "audit.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { agentId: string; allowed: boolean });
    assert.deepEqual(audit.map(a => `${a.agentId}:${a.allowed}`), ["a1:true", "a1:true", "a9:false"]);
    // A bundle grant (INV-420) is the other door in.
    assert.equal(await gate.bearerFor("oauth:github", { agentId: "a9", scopeGrants: true }), "gh-3");
    assert.equal(await gate.bearerFor("oauth:nowhere", { agentId: "a1" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("client credentials mint a tenant token now and re-mint it when it lapses", async () => {
  const { root, gate, calls, clock } = harness();
  try {
    assert.throws(() => gate.begin({ provider: "feishu", clientId: "app", clientSecret: "s", redirectUri: "x" }), /uses client credentials/);
    await assert.rejects(gate.connect({ provider: "github", clientId: "a", clientSecret: "b" }), /needs an authorization/);
    const done = await gate.connect({ provider: "feishu", clientId: "cli_app", clientSecret: "app-secret", grants: [{ holder: "*" }] });
    assert.equal(done.id, "oauth:feishu");
    assert.equal(done.expiresAt, new Date(clock.now + 7200_000).toISOString());
    assert.equal(JSON.parse(calls[0]!.body).app_secret, "app-secret");
    assert.equal(await gate.bearerFor("oauth:feishu", { agentId: "any" }), "t-1");
    clock.now += 7200_000 - 30_000;
    assert.equal(await gate.bearerFor("oauth:feishu", { agentId: "any" }), "t-2", "re-minted inside the refresh window");
    assert.equal(calls.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scrubbing removes every copy of a token and nothing else", () => {
  assert.equal(scrubToken('{"auth":"Bearer gh-1","again":"gh-1"}', "gh-1"), '{"auth":"Bearer <redacted>","again":"<redacted>"}');
  assert.equal(scrubToken("plain", ""), "plain");
});
