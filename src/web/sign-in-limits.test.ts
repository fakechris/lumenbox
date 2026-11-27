/**
 * The sign-in limiter (docs/106 §5 R4, INV-2204): one counter for every way in, by address and by
 * account, backing off rather than windowing. The routes that ask it are tested on a real server
 * in exposure.test.ts; here is the arithmetic, where a wrong number is an open door or a lockout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_BACKOFF, ADDRESS_BACKOFF, SignInLimiter, clientAddress, signInGuard, signInLedger, trustedProxies, type SignInRecord } from "./sign-in-limits.ts";

test("wrong tries are free at first, then each doubles the wait up to a ceiling; an address and an account are counted apart, and success clears only the account", () => {
  let now = 1_000_000;
  const limiter = new SignInLimiter(() => now);
  const from = (address: string, account?: string) => ({ door: "gateway" as const, address, ...(account !== undefined ? { account } : {}) });

  // One address guessing: people mistype, so the first few cost nothing.
  for (let n = 0; n < ADDRESS_BACKOFF.free; n += 1) assert.equal(limiter.failed(from("203.0.113.1")), undefined);
  assert.equal(limiter.waitFor(from("203.0.113.1")), undefined);
  const waits: number[] = [];
  for (let n = 0; n < 12; n += 1) {
    waits.push(limiter.failed(from("203.0.113.1"))!);
    assert.deepEqual(limiter.waitFor(from("203.0.113.1")), { seconds: waits.at(-1)!, first: true }, "refused until the wait is over");
    assert.equal(limiter.waitFor(from("203.0.113.1"))!.first, false, "and said once per wait, for the record");
    now += waits.at(-1)! * 1000;
    assert.equal(limiter.waitFor(from("203.0.113.1")), undefined, "then one more try");
  }
  assert.deepEqual(waits.slice(0, 5), [2, 4, 8, 16, 32], "each wrong try doubles it");
  assert.equal(waits.at(-1), ADDRESS_BACKOFF.ceilingMs / 1000, "up to the ceiling and no further");
  assert.equal(limiter.waitFor(from("203.0.113.2")), undefined, "another address is not held by it");
  assert.equal(limiter.waitFor({ door: "invite-code", address: "203.0.113.1" }), undefined, "nor is another way in from the same address");

  // Many addresses guessing at one account: no address reaches its own limit, the account does.
  for (let n = 0; n < ACCOUNT_BACKOFF.free; n += 1) assert.equal(limiter.failed(from(`198.51.100.${n}`, "Ana")), undefined);
  assert.equal(limiter.failed(from("198.51.100.200", "Ana")), 2);
  assert.equal(limiter.waitFor(from("192.0.2.9", "Ana"))?.seconds, 2, "and it waits whoever asks next");
  assert.equal(limiter.waitFor(from("192.0.2.9", "bob")), undefined);
  // Names are compared as written where they are checked (the gateway's password list), so `ana`
  // is another account: she is not held by Ana's count, and her signing in does not clear it.
  assert.equal(limiter.waitFor(from("192.0.2.9", "ana")), undefined);
  limiter.succeeded(from("192.0.2.9", "ana"));
  assert.equal(limiter.waitFor(from("192.0.2.9", "Ana"))?.seconds, 2);
  now += 2_000;

  // Signing in clears the account; the address that was guessing keeps what it earned.
  for (let n = 0; n < ADDRESS_BACKOFF.free + 1; n += 1) limiter.failed(from("192.0.2.50", "Ana"));
  limiter.succeeded(from("192.0.2.50", "Ana"));
  assert.equal(limiter.waitFor(from("192.0.2.77", "Ana")), undefined, "the account starts again");
  assert.ok(limiter.waitFor(from("192.0.2.50", "Ana")), "the address does not");

  // A quiet hour forgets.
  now += ADDRESS_BACKOFF.forgetMs + 1;
  assert.equal(limiter.failed(from("203.0.113.1")), undefined, "the count starts from nothing");
});

test("a person's address is what the adjacent proxy wrote, never what the client wrote; with no proxy it is the peer", () => {
  const req = (peer: string, forwarded?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } });
  assert.equal(clientAddress(req("10.0.0.7", "203.0.113.9"), true), "203.0.113.9");
  assert.equal(clientAddress(req("10.0.0.7", "1.2.3.4, 203.0.113.9"), true), "203.0.113.9", "the first entry is the client's own claim; the last is the proxy's");
  assert.equal(clientAddress(req("10.0.0.7", ["1.2.3.4", "2001:db8::1"]), true), "2001:db8::1");
  assert.equal(clientAddress(req("10.0.0.7", "not-an-address"), true), "10.0.0.7", "a value that is not an address is nobody's");
  assert.equal(clientAddress(req("::ffff:127.0.0.1"), true), "127.0.0.1", "the CLI on the server came through no proxy");
  assert.equal(clientAddress(req("127.0.0.1", "203.0.113.9"), false), "127.0.0.1", "local has no proxy to believe");

  // With the proxies declared, only their word is taken: a machine that reaches the port around
  // them is counted as the peer it is, whatever it wrote.
  const proxies = trustedProxies(" 10.42.0.0/16, 192.0.2.10 ,2001:db8:1::/48")!;
  assert.equal(clientAddress(req("10.42.3.7", "203.0.113.9"), true, proxies), "203.0.113.9", "the Ingress controller, inside the declared range");
  assert.equal(clientAddress(req("192.0.2.10", "203.0.113.9"), true, proxies), "203.0.113.9");
  assert.equal(clientAddress(req("2001:db8:1::5", "203.0.113.9"), true, proxies), "203.0.113.9");
  assert.equal(clientAddress(req("::ffff:127.0.0.1", "203.0.113.9"), true, proxies), "203.0.113.9", "a proxy on this machine needs no listing");
  assert.equal(clientAddress(req("10.43.0.9", "203.0.113.9"), true, proxies), "10.43.0.9", "another pod that reached the port directly is itself, not who it says");
  assert.equal(clientAddress(req("192.0.2.11", "1.1.1.1, 2.2.2.2"), true, proxies), "192.0.2.11");
  assert.equal(trustedProxies(undefined), undefined);
  assert.equal(trustedProxies(" , "), undefined);
  for (const bad of ["10.42.0.0/33", "ingress-nginx", "10.0.0.1/8/8", "2001:db8::/129"]) assert.throws(() => trustedProxies(bad), /AGENTBOX_TRUSTED_PROXIES has/, bad);
});

test("a refused try is recorded with who and from where and never with what was presented; local records and limits nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sign-ins-"));
  try {
    const path = join(dir, "sign-ins.jsonl");
    const logs: string[] = [];
    const guard = signInGuard({ enabled: true, record: signInLedger(path, line => logs.push(line)), log: line => logs.push(line), now: () => new Date("2026-11-27T10:00:00Z") });
    const attempt = { door: "gateway" as const, address: "203.0.113.9", peer: "10.0.0.7", account: "ana" };
    for (let n = 0; n < ADDRESS_BACKOFF.free + 1; n += 1) { assert.equal(guard.blocked(attempt), undefined); guard.failed(attempt, "wrong-password"); }
    assert.equal(guard.blocked(attempt), 2);
    assert.equal(guard.blocked(attempt), 2);
    guard.failed({ door: "door", address: "203.0.113.9", account: "ding:bob" }, "not-activated", false);
    const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as SignInRecord);
    assert.equal(lines.filter(line => line.outcome === "failed" && line.reason === "wrong-password").length, ADDRESS_BACKOFF.free + 1);
    assert.deepEqual(lines.filter(line => line.outcome === "limited"), [{ at: "2026-11-27T10:00:00.000Z", door: "gateway", outcome: "limited", address: "203.0.113.9", peer: "10.0.0.7", account: "ana", seconds: 2 }], "a flood of refused tries is one line");
    assert.deepEqual(Object.keys(lines[0]!).sort(), ["account", "address", "at", "door", "outcome", "peer", "reason"], "nothing in a line could hold a password, a code or a token; the peer is there because the address is a proxy's word");
    assert.equal(guard.blocked({ door: "door", address: "203.0.113.9" }), undefined, "a person an Admin has not let in yet is recorded, not counted");
    assert.ok(logs.some(line => /sign-in limited: gateway from 203\.0\.113\.9 for "ana"; refused for 2s/.test(line)));

    const off: SignInRecord[] = [];
    const local = signInGuard({ enabled: false, record: line => off.push(line), log: () => {} });
    for (let n = 0; n < 50; n += 1) { local.failed(attempt, "wrong-password"); assert.equal(local.blocked(attempt), undefined); }
    assert.deepEqual(off, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
