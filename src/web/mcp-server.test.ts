/**
 * The side door. What must hold: nothing happens without a token, every call is
 * attributed to the person whose token it is, and a tool's own failure comes back as
 * a readable result rather than as a broken transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  handleMcpRequest,
  mintMcpToken,
  principalForToken,
  type McpServerTool,
} from "./mcp-server.ts";
import { IdempotencyStore } from "./idempotency.ts";

/** A real server, because the claims are about HTTP: status codes, headers, bodies. */
async function withServer(
  tools: readonly McpServerTool[],
  tokens: ReturnType<typeof mintMcpToken>[],
  idempotency?: IdempotencyStore,
  headers: Record<string, string> = {}
): Promise<{
  // The parsed JSON body is what the assertions interrogate; naming a shape here would
  // assert the thing under test.
  call: (
    body: unknown,
    token?: string
    // biome-ignore lint/suspicious/noExplicitAny: see above
  ) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}> {
  const logged: string[] = [];
  const server: Server = createServer((req, res) => {
    void handleMcpRequest(req, res, {
      tools,
      principalFor: presented => principalForToken(presented, tokens),
      log: line => logged.push(line),
      ...(idempotency !== undefined ? { idempotency } : {}),
    }).then(handled => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    call: async (body, token) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

const echoTool = (seen: string[]): McpServerTool => ({
  name: "assign_task",
  description: "Give the team a piece of work.",
  inputSchema: { type: "object", properties: { brief: { type: "string" } } },
  readOnly: false,
  run: async (input, principalId) => {
    seen.push(`${principalId}:${String(input.brief)}`);
    return "t42";
  },
});

test("no token, no capability — and the refusal says nothing a guesser could use", async () => {
  const seen: string[] = [];
  const token = mintMcpToken("feishu:ou_chris", "Chris's laptop");
  const { call, stop } = await withServer([echoTool(seen)], [token]);
  try {
    for (const attempt of [undefined, "", "lmbx_wrong", "Bearer-ish nonsense"]) {
      const { status, body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, attempt);
      assert.equal(status, 401, `refused: ${String(attempt)}`);
      assert.match(body.error, /issued to a person/);
      assert.doesNotMatch(body.error, /unknown|expired|malformed/i, "one answer for every miss");
    }
    assert.deepEqual(seen, [], "nothing ran");
  } finally {
    await stop();
  }
});

test("every call carries the name of whoever the token belongs to", async () => {
  const seen: string[] = [];
  const chris = mintMcpToken("feishu:ou_chris", "laptop");
  const sam = mintMcpToken("web:sam", "ide");
  const { call, stop } = await withServer([echoTool(seen)], [chris, sam]);
  try {
    await call(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assign_task", arguments: { brief: "one" } } },
      chris.token
    );
    await call(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "assign_task", arguments: { brief: "two" } } },
      sam.token
    );
    assert.deepEqual(seen, ["feishu:ou_chris:one", "web:sam:two"],
      "attribution is the whole differentiator: a bare wrapper hands out capability with nobody's name on it");
  } finally {
    await stop();
  }
});

test("the handshake, the catalog, and annotations that are declared rather than guessed", async () => {
  const token = mintMcpToken("web:sam", "ide");
  const readTool: McpServerTool = {
    name: "task_status",
    description: "Ask how a piece of work is going.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: async () => "doing",
  };
  const { call, stop } = await withServer([readTool, echoTool([])], [token]);
  try {
    const hello = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, token.token);
    assert.equal(hello.body.result.serverInfo.name, "lumenbox");
    assert.ok(hello.body.result.capabilities.tools);

    const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token.token);
    const [read, write] = listed.body.result.tools;
    assert.equal(read.annotations.readOnlyHint, true);
    assert.equal(write.annotations.readOnlyHint, false, "assigning work changes the world");
    assert.equal(write.annotations.destructiveHint, true);

    const unknown = await call(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } },
      token.token
    );
    assert.match(unknown.body.error.message, /No tool named nope/);
    const badMethod = await call({ jsonrpc: "2.0", id: 4, method: "resources/list" }, token.token);
    assert.equal(badMethod.body.error.code, -32601);
  } finally {
    await stop();
  }
});

test("a tool's own failure is a readable result, not a broken transport", async () => {
  const token = mintMcpToken("web:sam", "ide");
  const angry: McpServerTool = {
    name: "assign_task",
    description: "x",
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    run: async () => {
      throw new Error("that agent is not on this installation");
    },
  };
  const { call, stop } = await withServer([angry], [token]);
  try {
    const { status, body } = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assign_task" } },
      token.token
    );
    assert.equal(status, 200, "the transport is fine; the tool is not");
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /not on this installation/,
      "the caller's agent should read this and decide, like any other failed tool");
  } finally {
    await stop();
  }
});

// ── the written contract (INV-1358) ──────────────────────────────────────────────

test("initialize states every side-door capability, the false ones included", async () => {
  const token = mintMcpToken("p1", "test");
  const { call, stop } = await withServer([echoTool([])], [token]);
  try {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, token.token);
    const caps = body.result.capabilities.experimental.lumenbox;
    assert.equal(caps.idempotency_key, true);
    assert.equal(caps.terminal_states, true);
    assert.equal(caps.cancel, false, "a capability we lack is reported false");
    assert.equal(caps.streaming, false);
  } finally {
    await stop();
  }
});

test("fields the tool's schema does not name are accepted and listed as ignored_fields on the result", async () => {
  const token = mintMcpToken("p1", "test");
  const seen: string[] = [];
  const { call, stop } = await withServer([echoTool(seen)], [token]);
  try {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assign_task", arguments: { brief: "do it", tools: ["x"], priority: 3 } } }, token.token);
    assert.match(body.result.content[0].text, /^t42\n\nignored_fields: priority, tools$/);
    assert.deepEqual(seen, ["p1:do it"], "the call still ran, once");
  } finally {
    await stop();
  }
});

test("an Idempotency-Key makes a retry return the first answer, waits while the first is running, and refuses a different body", async () => {
  const token = mintMcpToken("p1", "test");
  let runs = 0;
  let release: (() => void) | undefined;
  const slow: McpServerTool = {
    name: "assign_task",
    description: "d",
    inputSchema: { type: "object", properties: { brief: { type: "string" } } },
    readOnly: false,
    run: async input => {
      runs += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return `t${runs}:${String(input.brief)}`;
    },
  };
  const store = new IdempotencyStore({ ttlMs: 60_000 });
  const { call, stop } = await withServer([slow], [token], store, { "idempotency-key": "key-0001" });
  try {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "assign_task", arguments: { brief: "once" } } };
    const first = call(body, token.token);
    await new Promise(resolve => setTimeout(resolve, 30));
    const second = call(body, token.token); // same key, same body, first still running: waits
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(runs, 1, "the second call did not start a second run");
    release?.();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.body.result.content[0].text, "t1:once");
    assert.deepEqual(b.body.result, a.body.result, "the retry got the first answer");
    const third = await call(body, token.token);
    assert.deepEqual(third.body.result, a.body.result, "and so does a later one");
    assert.equal(runs, 1);
    const changed = await call({ ...body, params: { name: "assign_task", arguments: { brief: "something else" } } }, token.token);
    assert.equal(changed.body.error.code, -32009, "same key, different body is a conflict");
    assert.match(changed.body.error.message, /Idempotency-Key reused/);
  } finally {
    release?.();
    await stop();
  }
});
