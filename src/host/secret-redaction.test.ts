/**
 * Vault values out of records and model requests (INV-1186).
 *
 * What is held to: exact values and their JSON-escaped form are replaced, longest first;
 * short values only where they stand alone; ids, roles, signed and opaque blocks come out
 * byte-for-byte; the same input redacts to the same bytes every time; and both wires — the
 * Anthropic SDK and the OpenAI translation client — send nothing in clear, checked on the
 * request body a local server actually receives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { buildRedactor, currentRedactor, setRedactionSource } from "./secret-redaction.ts";
import { Vault, RETIRED_KEEP_MS } from "./vault.ts";
import { createClient, withRedaction, type ProviderProfile } from "./provider.ts";
import { keepToolResult } from "./results.ts";
import { AgentRegistry } from "../agents/registry.ts";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("an exact value and its JSON-escaped form are both replaced", () => {
  const quoted = 'pa"ss\\word-123456';
  const redactor = buildRedactor([{ name: "GH", value: TOKEN }, { name: "DB", value: quoted }]);
  assert.equal(redactor.text(`token=${TOKEN} done`), "token=[secret:GH] done");
  const asJson = JSON.stringify({ password: quoted });
  assert.equal(redactor.text(asJson), '{"password":"[secret:DB]"}');
});

test("the longer value wins when one secret contains another", () => {
  const redactor = buildRedactor([{ name: "SHORT", value: "abcdefghijkl" }, { name: "LONG", value: "abcdefghijklmnop" }]);
  assert.equal(redactor.text("x abcdefghijklmnop y"), "x [secret:LONG] y");
});

test("a short value is replaced only where it stands alone, and a PIN never inside a date or a longer number", () => {
  const redactor = buildRedactor([{ name: "PIN", value: "2026" }, { name: "PW", value: "hunter2" }]);
  assert.equal(redactor.text("PIN 2026, ok"), "PIN [secret:PIN], ok");
  assert.equal(redactor.text("on 2026-10-14 at 10:2026"), "on 2026-10-14 at 10:2026");
  assert.equal(redactor.text("ref 120265 and v1.2026"), "ref 120265 and v1.2026");
  assert.equal(redactor.text("password hunter2."), "password [secret:PW].");
  assert.equal(redactor.text("hunter22 xhunter2"), "hunter22 xhunter2");
});

test("values under four characters are never replaced", () => {
  const redactor = buildRedactor([{ name: "X", value: "abc" }]);
  assert.equal(redactor.empty, true);
  assert.equal(redactor.text("abc abc"), "abc abc");
});

test("ids, roles, signed thinking and images come out byte-for-byte; prose is rewritten", () => {
  const redactor = buildRedactor([{ name: "GH", value: TOKEN }]);
  // A pathological id equal to the secret proves the walk does not touch structural keys.
  const messages = [
    { role: "assistant", content: [
      { type: "thinking", thinking: `I saw ${TOKEN}`, signature: "sig" },
      { type: "tool_use", id: TOKEN, name: "bash", input: { command: `echo ${TOKEN}` } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: TOKEN, content: [{ type: "text", text: `out ${TOKEN}` }] },
      { type: "image", source: { type: "base64", media_type: "image/png", data: TOKEN } },
    ] },
  ];
  const out = redactor.deep(messages) as typeof messages;
  const assistant = out[0]!.content as Record<string, unknown>[];
  const user = out[1]!.content as Record<string, unknown>[];
  assert.deepEqual(assistant[0], messages[0]!.content[0]);
  assert.equal(assistant[1]!.id, TOKEN);
  assert.deepEqual(assistant[1]!.input, { command: "echo [secret:GH]" });
  assert.equal(user[0]!.tool_use_id, TOKEN);
  assert.deepEqual(user[0]!.content, [{ type: "text", text: "out [secret:GH]" }]);
  assert.deepEqual(user[1], messages[1]!.content[1]);
  assert.equal((messages[0]!.content[1] as { input: { command: string } }).input.command, `echo ${TOKEN}`, "the input object is not mutated");
});

test("the same history redacts to the same bytes twice, and an untouched one is returned as is", () => {
  const history = [{ role: "user", content: `key ${TOKEN}` }, { role: "assistant", content: "fine" }];
  const first = JSON.stringify(buildRedactor([{ name: "GH", value: TOKEN }]).deep(history));
  const second = JSON.stringify(buildRedactor([{ name: "GH", value: TOKEN }]).deep(history));
  assert.equal(first, second);
  const clean = [{ role: "user", content: "nothing here" }];
  assert.equal(buildRedactor([{ name: "GH", value: TOKEN }]).deep(clean), clean);
});

async function withVault(run: (vault: Vault, dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "redact-vault-"));
  const vault = new Vault(join(dir, "vault.json"), join(dir, "audit.jsonl"));
  try {
    await run(vault, dir);
  } finally {
    setRedactionSource(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a rotated or deleted value is still redacted, across a reload, until it ages out", async () => {
  await withVault((vault, dir) => {
    vault.setSecret({ id: "GH", value: TOKEN, grants: [] });
    vault.setSecret({ id: "GH", value: "ghp_rotated_value_0000000000000000000" });
    vault.setSecret({ id: "DB", value: "db-password-0123456789" });
    vault.removeSecret("DB");
    const reloaded = new Vault(join(dir, "vault.json"), join(dir, "audit.jsonl"));
    const names = (now?: Date) => reloaded.redactionEntries(now).map(entry => `${entry.name}=${entry.value}`).sort();
    assert.deepEqual(names(), [
      "DB=db-password-0123456789",
      `GH=${TOKEN}`,
      "GH=ghp_rotated_value_0000000000000000000",
    ]);
    const later = new Date(Date.now() + RETIRED_KEEP_MS + 60_000);
    assert.deepEqual(names(later), ["GH=ghp_rotated_value_0000000000000000000"]);
    assert.equal(reloaded.list().some(view => view.id === "DB"), false, "a retired value is never listed");
    assert.equal(reloaded.resolve("DB", { agentId: "a" }), undefined, "nor resolvable");
  });
});

test("an OAuth refresh token and client secret are hidden too", async () => {
  await withVault(vault => {
    vault.setSecret({
      id: "LINEAR",
      value: "lin_access_000000000000",
      oauth: { provider: "linear", kind: "authorization_code", refreshToken: "lin_refresh_111111111111", clientSecret: "lin_client_222222222222" },
    });
    assert.deepEqual(vault.redactionEntries().map(entry => entry.name).sort(), ["LINEAR", "LINEAR.client", "LINEAR.refresh"]);
  });
});

test("the transcript and a kept tool result are written without the value", async () => {
  await withVault((vault, dir) => {
    vault.setSecret({ id: "GH", value: TOKEN });
    setRedactionSource(() => vault.redactionEntries());
    const registry = new AgentRegistry(join(dir, "agents"));
    registry.appendTranscript("a1", { role: "user", text: `use ${TOKEN}`, at: "2026-10-14T00:00:00Z" });
    const stored = readFileSync(registry.transcriptPathFor("a1"), "utf8");
    assert.equal(stored.includes(TOKEN), false);
    assert.match(stored, /\[secret:GH\]/);

    const kept = keepToolResult(
      { text: `printed ${TOKEN}`, turnId: "t1", toolUseId: "u1", agent: { id: "a1", name: "Ada" }, at: new Date("2026-10-14T00:00:00Z") },
      join(dir, "home")
    );
    assert.equal(readFileSync(kept.path, "utf8").includes(TOKEN), false);
  });
});

test("a vault change shows on the next write without re-registering", async () => {
  await withVault(vault => {
    setRedactionSource(() => vault.redactionEntries());
    assert.equal(currentRedactor().empty, true);
    vault.setSecret({ id: "GH", value: TOKEN });
    assert.equal(currentRedactor().text(TOKEN), "[secret:GH]");
  });
});

/** A local endpoint that records each request body and answers in the wire's own shape. */
async function recordingServer(answer: (url: string) => unknown): Promise<{ base: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", chunk => (body += chunk));
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer(request.url ?? "")));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, bodies, close: () => new Promise(resolve => server.close(() => resolve())) };
}

const history: Anthropic.MessageParam[] = [
  { role: "user", content: "deploy it" },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "cat .env" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: `GITHUB_TOKEN=${TOKEN}` }] }] },
];

function profile(wire: "anthropic" | "openai", base: string): ProviderProfile {
  return {
    label: `test-${wire}`,
    baseUrl: base,
    model: "m",
    maxTokens: 64,
    vision: false,
    adaptiveThinking: false,
    effort: false,
    promptCaching: false,
    keyEnv: "REDACTION_TEST_KEY",
    ...(wire === "openai" ? { wire: "openai" as const } : {}),
  } as ProviderProfile;
}

for (const wire of ["anthropic", "openai"] as const) {
  test(`the ${wire} wire sends no held value, keeps the tool pairing, and sends the same bytes twice`, async () => {
    const server = await recordingServer(() =>
      wire === "openai"
        ? { id: "c", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { id: "msg", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    );
    const previousKey = process.env.REDACTION_TEST_KEY;
    process.env.REDACTION_TEST_KEY = "test-key";
    try {
      await withVault(async vault => {
        vault.setSecret({ id: "GH", value: TOKEN });
        setRedactionSource(() => vault.redactionEntries());
        const client = createClient(profile(wire, server.base));
        const request = { model: "m", max_tokens: 64, system: `You hold ${TOKEN}? No.`, messages: history };
        await client.messages.create(request);
        await client.messages.create(request);
        assert.equal(server.bodies.length, 2);
        for (const body of server.bodies) {
          assert.equal(body.includes(TOKEN), false, `${wire} body carried the value`);
          assert.match(body, /\[secret:GH\]/);
          assert.match(body, /toolu_1/);
        }
        assert.equal(server.bodies[0], server.bodies[1], "same history, same bytes");
        assert.match(JSON.stringify(history), new RegExp(TOKEN), "the caller's history is not mutated");
      });
    } finally {
      if (previousKey === undefined) delete process.env.REDACTION_TEST_KEY;
      else process.env.REDACTION_TEST_KEY = previousKey;
      await server.close();
    }
  });
}

test("stream is redacted like create, and the rest of the client is left alone", async () => {
  await withVault(vault => {
    vault.setSecret({ id: "GH", value: TOKEN });
    setRedactionSource(() => vault.redactionEntries());
    const seen: unknown[] = [];
    const fake = {
      messages: {
        create: (params: unknown) => seen.push(["create", params]),
        stream: (params: unknown, options: unknown) => seen.push(["stream", params, options]),
      },
      other: 1,
    } as unknown as Anthropic;
    const client = withRedaction(fake);
    const params = { model: "m", max_tokens: 1, tools: [{ name: "t", description: TOKEN, input_schema: {} }], messages: [{ role: "user", content: TOKEN }] };
    client.messages.stream(params as never, { signal: undefined } as never);
    const [kind, sent, options] = seen[0] as [string, typeof params, unknown];
    assert.equal(kind, "stream");
    assert.equal(JSON.stringify(sent.messages).includes(TOKEN), false);
    assert.equal(sent.tools[0]!.description, TOKEN, "tool schemas are ours and are not rewritten");
    assert.deepEqual(options, { signal: undefined });
    assert.equal((client as unknown as { other: number }).other, 1);
  });
});
