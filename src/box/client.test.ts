/**
 * Tests for how a box call fails.
 *
 * The property under test: refused, timed out, crashed and unreachable are different
 * situations with different remedies, and each answer must say which it is and what to
 * do — they used to arrive as one undifferentiated message, and the reader (model or
 * person) had to guess whether to retry, to check, or to give up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { BoxClient, BoxError } from "./client.ts";

function serve(
  handler: (path: string, respond: (status: number, body: string) => void) => void
): Promise<{ server: Server; url: string }> {
  return new Promise(resolvePort => {
    const server = createServer((req, res) => {
      handler(req.url ?? "", (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePort({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function failureOf(work: Promise<unknown>): Promise<BoxError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof BoxError, `expected a BoxError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

test("each way a box call fails says which way it was, and the remedy", async () => {
  const { server, url } = await serve((path, respond) => {
    if (path === "/refused") respond(403, JSON.stringify({ error: "not yours" }));
    else if (path === "/crashed") respond(500, JSON.stringify({ error: "boom" }));
    else if (path === "/garbled") respond(200, "<html>not the protocol</html>");
    else respond(200, "{}");
  });
  try {
    const client = new BoxClient({ baseUrl: url, token: "t", timeoutMs: 2000 });
    const post = (path: string) =>
      (client as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post(path, {});

    const refused = await failureOf(post("/refused"));
    assert.equal(refused.kind, "refused");
    assert.match(refused.message, /refused again/);

    const crashed = await failureOf(post("/crashed"));
    assert.equal(crashed.kind, "crashed");
    assert.match(crashed.message, /effect is unknown/);

    const garbled = await failureOf(post("/garbled"));
    assert.equal(garbled.kind, "protocol");
  } finally {
    server.close();
  }
});

test("a box that is not there is unreachable, which is the one safe-to-retry failure", async () => {
  // A port nothing listens on, which is what a stopped box looks like.
  const client = new BoxClient({ baseUrl: "http://127.0.0.1:9", token: "t", timeoutMs: 2000 });
  const failure = await failureOf(
    (client as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post("/x", {})
  );
  assert.equal(failure.kind, "unreachable");
  assert.match(failure.message, /safe to retry/);
});

test("a timeout says the operation may still be running", async () => {
  const { server, url } = await serve(() => {
    // Never respond: the request must die by its own timer.
  });
  try {
    const client = new BoxClient({ baseUrl: url, token: "t", timeoutMs: 150 });
    const failure = await failureOf(
      (client as unknown as { post: (p: string, b: unknown) => Promise<unknown> }).post("/slow", {})
    );
    assert.equal(failure.kind, "timeout");
    assert.match(failure.message, /may still be running/);
  } finally {
    server.close();
  }
});
