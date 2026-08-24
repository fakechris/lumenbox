/**
 * Who decides what.
 *
 * Three kinds of setting answer to different people: what the installation *is*
 * (provider, key, box, channels) and what the organisation *is* (roster, scopes,
 * budgets) are an admin's to decide, while a person's own access is their own. The
 * settings dialog hides what you may not decide — but hiding is the experience, and
 * this is the boundary. These assertions are what stop it drifting back into
 * decoration, which is exactly what had happened: a driver could rewrite the
 * provider and its key, and a viewer who signed in could drive an agent, because
 * identity arrived through the session while authority was still being read from a
 * gateway header that is not there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";

const PORT = 7922;
const BASE = `http://127.0.0.1:${PORT}`;

test("installation and organisation are an admin's; a person's own access is theirs", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-roles-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({
      port: PORT,
      host: "127.0.0.1",
      token: "t0k",
      useBox: false,
      onLog: () => {},
    });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };

    /** Signs somebody in the way a real person does: an invite code, then cookies. */
    const signIn = async (role: string, name: string): Promise<string> => {
      const invite = (await (
        await fetch(`${BASE}/api/channels/invite`, {
          method: "POST",
          headers: ui,
          body: JSON.stringify({ role }),
        })
      ).json()) as { code: string };
      const response = await fetch(`${BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: invite.code, name }),
      });
      return response.headers
        .getSetCookie()
        .map(cookie => cookie.split(";")[0])
        .join("; ");
    };
    const dana = await signIn("driver", "Dana");
    const vic = await signIn("viewer", "Vic");

    const status = async (path: string, jar: string, body?: unknown): Promise<number> =>
      (
        await fetch(`${BASE}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json", cookie: jar },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
      ).status;

    // What the installation is, and what the organisation is: an admin's.
    assert.equal(await status("/api/config", dana, { provider: "anthropic" }), 403, "provider");
    assert.equal(await status("/api/scopes", dana, { scopes: [] }), 403, "scopes");
    assert.equal(await status("/api/principals", dana, { principals: [] }), 403, "roster");
    assert.equal(await status("/api/channels/approve", dana, { identity: "x" }), 403, "knocks");

    // A person's own access is their own — and needs no principal named, because the
    // session already says who is asking.
    const minted = await fetch(`${BASE}/api/mcp/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: dana },
      body: JSON.stringify({ label: "my editor" }),
    });
    const token = (await minted.json()) as { token?: string };
    assert.equal(minted.status, 200);
    assert.ok(token.token?.startsWith("lmbx_"), "a driver may issue their own");

    // And the work it does carries their name, which is the point of issuing it to a
    // person rather than to the installation.
    await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "assign_task", arguments: { brief: "dana's work" } },
      }),
    });
    const board = (await (await fetch(`${BASE}/api/tasks`, { headers: ui })).json()) as {
      tasks: { title: string; requester: string }[];
    };
    const theirs = board.tasks.find(task => task.title === "dana's work");
    assert.ok(theirs?.requester.startsWith("web:"), `attributed: ${theirs?.requester}`);

    // A viewer watches. Reading is the whole of it.
    assert.equal(await status("/api/prompt", vic, { agentId: "x", text: "go" }), 403, "driving");
    assert.equal(await status("/api/mcp/tokens", vic, { label: "nope" }), 403, "tokens");
    assert.equal(await status("/api/tasks", vic), 200, "but the board is readable");
  } finally {
    // Released, or the port and its timers outlive the test and the runner hangs.
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
