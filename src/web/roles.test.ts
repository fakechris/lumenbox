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

// These requests carry identity the way the hosted gateway sends it, so this file runs as a box behind one (INV-1543).
process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";

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
    assert.equal(await status("/api/channels", dana), 403, "channel roster and invitation secrets");
    assert.equal(await status("/api/channels", vic), 403, "viewers cannot read invitation secrets");
    assert.equal(await status("/api/config", dana, { provider: "anthropic" }), 403, "provider");
    assert.equal(await status("/api/scopes", dana, { scopes: [] }), 403, "scopes");
    assert.equal(await status("/api/principals", dana, { principals: [] }), 403, "roster");
    assert.equal(await status("/api/channels/approve", dana, { identity: "x" }), 403, "knocks");
    assert.equal(await status("/api/teaching-drafts", vic), 403, "private teaching drafts");
    for (const action of ["approve", "reject", "clarify"]) {
      assert.equal(await status(`/api/teaching-drafts/${action}`, dana, { id: "draft", digest: "hash" }), 403, "teaching publication needs admin");
    }

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

    // The desktop with nobody signed in (INV-1681) is the installation's one admin: its Mine
    // lists that person's tokens — the supervision and watchdog ones are issued to them — and
    // Issue gives it one, instead of an empty list and a 400. With no single admin it is asked whom.
    const operator = async (path: string, body?: unknown) => {
      const response = await fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: ui, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const nobody = await operator("/api/mcp/tokens", { label: "my editor" });
    assert.equal(nobody.status, 400);
    // A program reads the code; a person reads the words in their language, the count in both (INV-1686).
    assert.equal(nobody.body.code, "token-needs-person");
    assert.match(String(nobody.body.error), /有 0 位管理员/, "no admin to issue it to is said, with the count, in the default language");
    const asked = await fetch(`${BASE}/api/mcp/tokens`, { method: "POST", headers: { ...ui, "accept-language": "en-US,en;q=0.9" }, body: JSON.stringify({ label: "my editor" }) });
    assert.match(String(((await asked.json()) as { error: string }).error), /has 0 admins/, "and in English to a browser that asks for it");
    const people = (await operator("/api/channels")).body.principals as unknown[];
    assert.equal((await operator("/api/principals", { principals: [...people, { id: "chris", name: "Chris", role: "admin" }] })).status, 200);
    const issued = await operator("/api/mcp/tokens", { label: "watchdog" });
    assert.equal(issued.status, 200);
    const listed = () => operator("/api/mcp").then(answer => answer.body.tokens as { principalId: string; label: string; createdAt: string; mine: boolean }[]);
    const shown = (await listed()).filter(token => token.mine);
    assert.deepEqual(shown.map(token => [token.principalId, token.label]), [["chris", "watchdog"]], "the admin's, not Dana's");
    assert.equal((await operator("/api/mcp/tokens/revoke", { createdAt: shown[0]!.createdAt })).status, 200);
    assert.equal((await listed()).some(token => token.mine), false, "and revoked from there");
  } finally {
    // Released, or the port and its timers outlive the test and the runner hangs.
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── behind a gateway, the gateway's word is the roster (2026-09-08, k8s) ──────────────────
//
// On the multi-tenant control plane every request arrives with x-agentbox-user and
// x-agentbox-role, and the tenant's roster lives in the control plane. This pod's own roster is
// empty, so consulting it turned a tenant's owner into a viewer on their first click ("This
// account can watch but not drive").

test("a role asserted by the gateway is honoured over the pod's empty roster", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-roles-gw-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({ port: PORT + 1, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const base = `http://127.0.0.1:${PORT + 1}`;
    const as = (role: string) => ({
      "content-type": "application/json",
      authorization: "Bearer t0k",
      "x-agentbox-user": "u-chris",
      "x-agentbox-role": role,
    });
    const status = async (path: string, role: string, body: unknown): Promise<number> =>
      (await fetch(`${base}${path}`, { method: "POST", headers: as(role), body: JSON.stringify(body) })).status;

    // An owner drives and administers; a member drives; a viewer watches.
    assert.notEqual(await status("/api/templates/stamp", "owner", {}), 403, "owner stamps");
    assert.notEqual(await status("/api/scopes", "owner", { scopes: [] }), 403, "owner administers");
    assert.notEqual(await status("/api/templates/stamp", "member", {}), 403, "member stamps");
    assert.equal(await status("/api/scopes", "member", { scopes: [] }), 403, "member does not administer");
    assert.equal(await status("/api/templates/stamp", "viewer", {}), 403, "viewer watches");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
