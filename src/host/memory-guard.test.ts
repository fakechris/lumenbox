/** The memory guard (INV-1333): what is refused, by kind, and what is let through. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { guardMemoryCandidate } from "./memory-guard.ts";

const secret = "hunter2-very-secret-value-9";
const held = new Map([["SHOP_PASSWORD", secret]]);

test("a held value is refused in clear, encoded, spaced out, and inside a longer line; a short held value is not compared", () => {
  assert.match(guardMemoryCandidate(`the shop password is ${secret}`, { held })?.reason ?? "", /holds the value of SHOP_PASSWORD/);
  assert.match(guardMemoryCandidate(`shop login: ${Buffer.from(secret).toString("base64")}`, { held })?.reason ?? "", /SHOP_PASSWORD/);
  assert.match(guardMemoryCandidate(`shop login: ${Buffer.from(secret).toString("base64url")}`, { held })?.reason ?? "", /SHOP_PASSWORD/);
  assert.match(guardMemoryCandidate(`shop login: ${encodeURIComponent(secret)}`, { held })?.reason ?? "", /SHOP_PASSWORD/);
  assert.match(guardMemoryCandidate(`shop login: ${secret.split("-").join(" - ")}`, { held })?.reason ?? "", /SHOP_PASSWORD/);
  assert.equal(guardMemoryCandidate("the admin user is admin", { held: new Map([["USER", "admin"]]) }), undefined, "a short value would match the word");
  assert.doesNotMatch(guardMemoryCandidate(`${secret}`, { held })?.reason ?? "", /hunter2/, "the reason never quotes the value");
});

test("a credential shape is refused even when it arrives base64-encoded or percent-encoded", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  assert.match(guardMemoryCandidate(`their key is ${key}`)?.reason ?? "", /credential/);
  assert.match(guardMemoryCandidate(`their key is ${Buffer.from(`token=${key}`).toString("base64")}`)?.reason ?? "", /credential/);
  assert.match(guardMemoryCandidate(`their key is ${encodeURIComponent(`Bearer ${key}`)}`)?.reason ?? "", /credential/);
});

test("invisible characters are refused by name, and ordinary Unicode is not", () => {
  assert.match(guardMemoryCandidate("they prefer​ metric units")?.reason ?? "", /invisible characters/);
  assert.match(guardMemoryCandidate("they prefer ‮metric units")?.reason ?? "", /invisible characters/);
  assert.equal(guardMemoryCandidate("他们偏好公制单位，报告用 km 和 °C"), undefined);
  assert.equal(guardMemoryCandidate("Ils préfèrent les unités métriques — toujours"), undefined);
});

test("an identifier copied out of the conversation is a restatement, not a memory; a url, a path and a commit sha are facts", () => {
  const spoken = "my order is ORD-2026-10-24-ab12cd34ef56 and the repo is https://github.com/acme/widgets at commit 3f2a9c1d7b8e4f05a6b7c8d9e0f1a2b3c4d5e6f7";
  assert.match(guardMemoryCandidate("their order number is ORD-2026-10-24-ab12cd34ef56", { spoken })?.reason ?? "", /copies an identifier/);
  assert.equal(guardMemoryCandidate("their widgets repo is https://github.com/acme/widgets", { spoken }), undefined);
  assert.equal(guardMemoryCandidate("the release they care about is commit 3f2a9c1d7b8e4f05a6b7c8d9e0f1a2b3c4d5e6f7", { spoken }), undefined, "hex alone is a fact, not an identifier");
  assert.equal(guardMemoryCandidate("they keep order numbers in the ORD-<year> form", { spoken }), undefined);
});
