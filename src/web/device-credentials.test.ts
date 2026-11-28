/**
 * Device credentials and the two ways a device signs in (INV-2214), on a clock the test moves: what the
 * contract tests cannot wait for — fifteen minutes, thirty seconds, two minutes — and the record each
 * step leaves. The whole flow on a real server is in client-api/contract.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_TTL_MS, DeviceStore, REFRESH_OVERLAP_MS, REFRESH_TTL_MS } from "./device-credentials.ts";
import { DeviceSignIns, CODE_TTL_MS, PAIRING_TTL_MS, START_TTL_MS, isAppRedirect } from "./device-sign-in.ts";
import { deviceRoute } from "./device-routes.ts";
import type { TokenRecord } from "./token-ledger.ts";

const holds = () => true;

test("a refresh token is spent by its use; within 30 seconds it ends nothing, after that it ends the device for both holders; access lasts fifteen minutes, refresh thirty idle days", t => {
  const home = mkdtempSync(join(tmpdir(), "devices-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = { ms: Date.parse("2026-11-28T10:00:00Z") }, records: TokenRecord[] = [];
  const store = new DeviceStore(join(home, "devices.json"), () => {}, record => records.push(record), () => new Date(clock.ms));
  const made = store.signIn({ principalId: "dee", identity: "ding:dee", via: "sign-in", method: "oauth", providerId: "ding", name: "Dee's phone", platform: "ios", scopes: ["work:read"], by: "ding:dee" });
  const credential = store.clientFor(made.tokens.accessToken, holds);
  assert.ok("credential" in credential && credential.credential.kind === "device" && credential.credential.id === made.device.id);

  clock.ms += ACCESS_TTL_MS;
  assert.deepEqual(store.clientFor(made.tokens.accessToken, holds), { refused: "expired" }, "fifteen minutes");
  const second = store.refresh(made.tokens.refreshToken, holds);
  assert.ok("tokens" in second);
  clock.ms += REFRESH_OVERLAP_MS;
  assert.deepEqual(store.refresh(made.tokens.refreshToken, holds), { refused: "superseded" }, "the device's other process, within 30 seconds");
  assert.ok("credential" in store.clientFor(second.tokens.accessToken, holds), "and nothing ended");
  clock.ms += 1;
  assert.deepEqual(store.refresh(made.tokens.refreshToken, holds), { refused: "reused" }, "past 30 seconds: two holders of one token");
  assert.deepEqual(store.refresh(second.tokens.refreshToken, holds), { refused: "removed" }, "the device's own current one ends too");
  assert.deepEqual(store.clientFor(second.tokens.accessToken, holds), { refused: "removed" }, "and its access token, at once");
  assert.deepEqual(records.map(record => [record.event, "reason" in record ? record.reason : undefined]), [["minted", undefined], ["rotated", undefined], ["revoked", "refresh-reuse"]]);

  // Reuse is known for thirty days, however often the device refreshed: a phone refreshing every fifteen minutes spends
  // ~2,900 tokens in that time, and the first of them, replayed at the end, still ends the device.
  const busy = store.signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "busy phone", platform: "ios", scopes: ["work:read"], by: "dee" });
  let held = busy.tokens.refreshToken;
  for (let rotation = 0; rotation < 29 * 96; rotation += 1) {
    clock.ms += ACCESS_TTL_MS;
    const next = store.refresh(held, holds);
    assert.ok("tokens" in next, `rotation ${rotation}`);
    held = next.tokens.refreshToken;
  }
  assert.deepEqual(store.refresh(busy.tokens.refreshToken, holds), { refused: "reused" }, "the first token, 29 days and 2,784 rotations later");
  assert.deepEqual(store.refresh(held, holds), { refused: "removed" });

  // A refresh token nobody used for thirty days is over; one this store never issued is unknown.
  const idle = store.signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "tablet", platform: "android", scopes: ["work:read"], by: "dee" });
  clock.ms += REFRESH_TTL_MS;
  assert.deepEqual(store.refresh(idle.tokens.refreshToken, holds), { refused: "expired" });
  assert.deepEqual(store.refresh(`lbxr_${"0".repeat(64)}`, holds), { refused: "invalid" });
  // The file holds hashes, never a token; a store read from it knows an ended device as ended.
  const text = readFileSync(join(home, "devices.json"), "utf8");
  for (const token of [made.tokens.accessToken, made.tokens.refreshToken, second.tokens.refreshToken, idle.tokens.refreshToken]) assert.ok(!text.includes(token));
  assert.ok(text.includes(createHash("sha256").update(made.tokens.refreshToken).digest("hex").slice(0, 32)), "a spent one as the start of its SHA-256, to know it again");

  // A rotation that cannot be written is not made: the token presented still works once the disk does.
  // (Its directory gone, which stops a write even for root, as CI runs.)
  const shaky = join(home, "shaky");
  mkdirSync(shaky);
  const fragile = new DeviceStore(join(shaky, "devices.json"), () => {}, () => {}, () => new Date(clock.ms));
  const careful = fragile.signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "careful phone", platform: "ios", scopes: ["work:read"], by: "dee" });
  rmSync(shaky, { recursive: true, force: true });
  assert.throws(() => fragile.refresh(careful.tokens.refreshToken, holds));
  mkdirSync(shaky);
  assert.ok("tokens" in fragile.refresh(careful.tokens.refreshToken, holds), "not superseded, not reused: as if nothing happened");

  // Neither token outlives the device's year: the last refresh before it gives what is left.
  const yearly = store.signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "old faithful", platform: "ios", scopes: ["work:read"], by: "dee" });
  const ends = clock.ms + 365 * 24 * 3_600_000;
  let current = yearly.tokens.refreshToken;
  while (clock.ms + REFRESH_TTL_MS - 60_000 < ends - 60_000) {
    clock.ms = Math.min(clock.ms + REFRESH_TTL_MS - 60_000, ends - 60_000);
    const next = store.refresh(current, holds);
    assert.ok("tokens" in next);
    current = next.tokens.refreshToken;
    if (clock.ms === ends - 60_000) {
      assert.equal(Date.parse(next.tokens.accessTokenExpiresAt), ends, "a minute of access, not fifteen");
      assert.equal(Date.parse(next.tokens.refreshTokenExpiresAt), ends);
    }
  }
});

test("a person's access ending ends their devices — only those of one sign-in when they keep another — and a sign-in taken from them ends the devices made from it", () => {
  const store = new DeviceStore();
  const sign = (identity: string, via: "sign-in" | "person" = "sign-in") => store.signIn({ principalId: "dee", identity, via, method: "oauth", name: identity, platform: "ios", scopes: ["work:read"], by: identity });
  const ding = sign("ding:dee"), feishu = sign("feishu:ou_dee"), paired = sign("dee", "person");
  assert.equal(store.endFor(["ding:dee"], true, "directory"), 1, "left one door, keeps the other");
  assert.deepEqual(store.clientFor(ding.tokens.accessToken, holds), { refused: "removed" });
  assert.ok("credential" in store.clientFor(feishu.tokens.accessToken, holds));
  // A sign-in an Admin took away: the device it made is refused as removed, by `holds`, before any sweep.
  assert.deepEqual(store.clientFor(feishu.tokens.accessToken, device => device.identity !== "feishu:ou_dee"), { refused: "removed" });
  assert.equal(store.endFor(["dee"], false, "operator"), 2, "removed: every device of theirs");
  assert.deepEqual(store.clientFor(paired.tokens.accessToken, holds), { refused: "removed" });
  assert.deepEqual(store.list("dee"), []);
  assert.equal(store.remove(paired.device.id, "removed", "dee"), false, "ended once");
});

test("a sign-in through a door: the start is taken once, its code works once, within a minute, with the verifier of its challenge; a pairing code once, within two minutes; only an app's own address is sent a code", () => {
  const clock = { ms: 0 };
  const sign = new DeviceSignIns(() => clock.ms);
  const verifier = "a".repeat(43), challenge = createHash("sha256").update(verifier).digest("base64url");
  const begin = () => sign.start({ providerId: "ding", codeChallenge: challenge, redirectUri: "lumenbox://oauth/callback?keep=1", state: "s1" });
  const codeOf = (location: string | undefined) => new URL(location!).searchParams.get("code")!;

  const started = begin();
  assert.deepEqual(sign.take(started.id), { providerId: "ding" });
  assert.equal(sign.take(started.id), undefined, "taken once");
  const location = sign.finish(started.id, { kind: "person", principalId: "dee", identity: "ding:dee" })!;
  assert.match(location, /^lumenbox:\/\/oauth\/callback\?keep=1&code=[A-Za-z0-9_-]{43}&state=s1$/);
  assert.equal(sign.finish(started.id, { kind: "person", principalId: "dee", identity: "ding:dee" }), undefined, "finished once");
  assert.equal(sign.exchange(codeOf(location), verifier, { providerId: "feishu", redirectUri: "lumenbox://oauth/callback?keep=1" }), undefined, "for the channel it started with");
  const again = begin(); sign.take(again.id);
  const code = codeOf(sign.finish(again.id, { kind: "person", principalId: "dee", identity: "ding:dee" }));
  assert.deepEqual(sign.exchange(code, verifier, { redirectUri: "lumenbox://oauth/callback?keep=1" }), { kind: "person", principalId: "dee", identity: "ding:dee", providerId: "ding" });
  assert.equal(sign.exchange(code, verifier, { redirectUri: "lumenbox://oauth/callback?keep=1" }), undefined, "once");

  const late = begin(); sign.take(late.id);
  const lateCode = codeOf(sign.finish(late.id, { kind: "asked", name: "Bob" }));
  clock.ms += CODE_TTL_MS + 1;
  assert.equal(sign.exchange(lateCode, verifier, { redirectUri: "lumenbox://oauth/callback?keep=1" }), undefined, "a minute");
  const slow = begin();
  clock.ms += START_TTL_MS + 1;
  assert.equal(sign.take(slow.id), undefined, "a start lasts ten minutes");
  const refused = begin(); sign.take(refused.id);
  assert.equal(new URL(sign.finish(refused.id, { kind: "refused", why: "not-a-member" })!).searchParams.get("error_description"), "not-a-member");

  // A person's access ending stops the codes waiting for them: only that sign-in's, or all of theirs.
  const dropped = [sign.showPairing({ principalId: "dee", identity: "ding:dee", via: "sign-in" }), sign.showPairing({ principalId: "dee", identity: "feishu:dee", via: "sign-in" })];
  sign.dropFor(["ding:dee"], true);
  assert.equal(sign.pair(dropped[0]!.code), undefined, "the sign-in that ended");
  const kept = sign.showPairing({ principalId: "dee", identity: "dee", via: "person" });
  sign.dropFor(["dee"], false);
  assert.deepEqual([sign.pair(dropped[1]!.code), sign.pair(kept.code)], [undefined, undefined], "everything of a person whose access ended");
  const shown = sign.showPairing({ principalId: "dee", identity: "ding:dee", via: "sign-in" });
  assert.deepEqual(sign.pair(shown.code), { principalId: "dee", identity: "ding:dee", via: "sign-in" });
  assert.equal(sign.pair(shown.code), undefined, "once");
  const stale = sign.showPairing({ principalId: "dee", identity: "dee", via: "person" });
  clock.ms += PAIRING_TTL_MS + 1;
  assert.equal(sign.pair(stale.code), undefined, "two minutes");

  for (const address of ["lumenbox://oauth/callback", "http://127.0.0.1:53682/cb", "http://[::1]:8080/"]) assert.ok(isAppRedirect(address), address);
  for (const address of ["https://evil.example/cb", "http://127.0.0.1/cb", "http://localhost:8080/", "lumenbox://cb#frag", "javascript:alert(1)"]) assert.ok(!isAppRedirect(address), address);
});

test("the page's pairing and removal refuse what they cannot serve before anything is made: an address too long for the QR code, a body that is not an object", async () => {
  let shown = 0;
  const deps = (publicUrl: string, body: unknown = {}) => ({
    readJson: async () => body as Record<string, unknown>, userId: "ding:dee", role: "driver" as const,
    principals: { list: () => [], isKnown: () => true, resolve: () => ({ id: "dee" }) } as never,
    devices: { showPairing: () => { shown += 1; return { code: "c".repeat(43), expiresAt: Date.now() + 120_000 }; }, list: () => [], remove: () => false },
    freshSignIn: () => ({ ok: true as const }), publicUrl: () => publicUrl,
  });
  const long = `https://${Array.from({ length: 4 }, () => "a".repeat(50)).join(".")}.example.com`;
  const refused = await deviceRoute("POST /api/devices/pairing", deps(long));
  assert.ok(refused !== undefined);
  assert.deepEqual([refused.status, (refused.body as { code: string }).code, shown], [503, "public-url-too-long", 0], "no code made for a QR code that cannot be drawn");
  assert.equal((await deviceRoute("POST /api/devices/pairing", deps("https://box.example.test")))?.status, 200);
  assert.equal((await deviceRoute("POST /api/devices/remove", deps("https://box.example.test", null)))?.status, 400, "null is not a body");
});
