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

/** A real server, because the claims are about HTTP: status codes, headers, bodies. */
async function withServer(
  tools: readonly McpServerTool[],
  tokens: ReturnType<typeof mintMcpToken>[]
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
