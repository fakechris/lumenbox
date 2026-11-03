/** Held values never leave on the stream (INV-1360): clear, encoded, spaced; long enough only; named, never quoted. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { outboundRedactor, redactEvent } from "./redact-outbound.ts";

const secret = "hunter2-very-secret-value-9";
const held = new Map([["SHOP_PASSWORD", secret], ["USER", "admin"]]);

test("a held value is replaced by its name in clear, base64, base64url and percent-encoded forms; a short value is left alone", () => {
  const redact = outboundRedactor(held);
  assert.equal(redact(`the password is ${secret}, use it`), "the password is [vault:SHOP_PASSWORD], use it");
  assert.equal(redact(`b64 ${Buffer.from(secret).toString("base64")}`), "b64 [vault:SHOP_PASSWORD]");
  assert.equal(redact(`url ${encodeURIComponent(secret)}`), "url [vault:SHOP_PASSWORD]");
  assert.equal(redact(`twice ${secret} and ${secret}`), "twice [vault:SHOP_PASSWORD] and [vault:SHOP_PASSWORD]");
  assert.equal(redact("the admin user is admin"), "the admin user is admin", "a five-character value would match ordinary words");
  assert.equal(redact(""), "");
  assert.ok(!redact(secret).includes("hunter2"), "no character of the value survives");
});

test("no held values means the identity, and only text and interim events are touched", () => {
  const none = outboundRedactor(undefined);
  assert.equal(none("anything"), "anything");
  const redact = outboundRedactor(held);
  assert.deepEqual(redactEvent({ type: "text", agentId: "a", agentName: "Ada", delta: `x ${secret}` }, redact), { type: "text", agentId: "a", agentName: "Ada", delta: "x [vault:SHOP_PASSWORD]" });
  assert.deepEqual(redactEvent({ type: "interim", agentId: "a", agentName: "Ada", text: secret }, redact), { type: "interim", agentId: "a", agentName: "Ada", text: "[vault:SHOP_PASSWORD]" });
  const other = { type: "tool_start", agentId: "a", tool: "bash", input: { command: secret } };
  assert.equal(redactEvent(other, redact), other, "a tool_start is the record's business, not the stream's");
});

test("two sources may use one name and both values are still replaced; a tool's summary line is scrubbed too (INV-1543)", () => {
  const vault = "vault-value-0123456789abcdef";
  const host = "host-token-fedcba9876543210";
  const redact = outboundRedactor([["LUMENBOX_UI_TOKEN", vault], ["LUMENBOX_UI_TOKEN", host]]);
  assert.equal(redact(`${vault} and ${host}`), "[vault:LUMENBOX_UI_TOKEN] and [vault:LUMENBOX_UI_TOKEN]");
  const ended = redactEvent({ type: "tool_end", summary: `cookie agentbox_ui=${host}` }, redact);
  assert.equal(ended.summary, "cookie agentbox_ui=[vault:LUMENBOX_UI_TOKEN]");
});
