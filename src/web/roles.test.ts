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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { defaultLimits, PolicyGate } from "../host/policy.ts";
import { Principals } from "../host/principals.ts";
import { heartbeatSlug, seedStanding, standingDir } from "../host/standing.ts";

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
    for (const jar of [dana, vic]) {
      for (const route of ["/api/config/test", "/api/long-work", "/api/box/up", "/api/boxes/attach", "/api/boxes/update", "/api/boxes/detach"]) {
        assert.equal(await status(route, jar, {}), 403, route);
      }
    }
    const get = async (path: string, headers: HeadersInit) => (await fetch(BASE + path, { headers })).json();
    const providerUrl = "http://127.0.0.1:1/installation-provider";
    writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseUrl: providerUrl }));
    assert.equal((await get("/api/config", ui)).config.baseUrl, providerUrl);
    for (const [jar, role] of [[dana, "driver"], [vic, "viewer"]] as const) {
      const headers = { cookie: jar };
      assert.equal((await get("/api/me", headers)).role, role);
      assert.equal((await get("/api/state", headers)).provider, undefined, "no provider URL in member state");
      const config = await get("/api/config", headers);
      assert.deepEqual(Object.keys(config), ["presets"], "the agent editor still gets a provider catalogue");
      assert.ok(config.presets.length > 0);
      const setup = await get("/api/setup", headers);
      assert.deepEqual(Object.keys(setup), role === "driver" ? ["installationId", "hasPersonalBox"] : ["installationId"]);
      if (role === "driver") assert.equal(setup.hasPersonalBox, false);
    }
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
    assert.deepEqual((await operator("/api/mcp")).body.setup, { admins: 0, bootstrap: false }, "a nonempty driver/viewer roster cannot bootstrap");
    const before = (await operator("/api/mcp")).body.tokens;
    const nonexistent = await operator("/api/mcp/tokens", { label: "no owner", principalId: "missing-person" });
    assert.equal(nonexistent.status, 400);
    assert.equal(nonexistent.body.code, "token-needs-person");
    assert.deepEqual((await operator("/api/mcp")).body.tokens, before, "refusals mint nothing");
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

// The approval gate, the MCP page and the restart were the routes #794's role scoping did not reach
// (INV-2083): a driver or viewer read every box's approvals and grants, a driver revoked any agent's
// grant and restarted the installation, and a viewer read everyone's token metadata.
test("approvals, grants, tokens and the restart answer to the boxes a person may enter", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-roles-boxes-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    new Principals().save([
      { id: "ada", name: "Ada", role: "driver", identities: ["web:ada"] },
      { id: "vic", name: "Vic", role: "viewer", identities: ["web:vic"] },
      { id: "bob", name: "Bob", role: "driver", identities: ["web:bob"] },
      { id: "olga", name: "Olga", role: "admin", identities: ["web:olga"] },
    ]);
    const registry = new AgentRegistry(join(home, "agents"));
    const [one, two] = (["one", "two"] as const).map(id => {
      registry.attachBox({ id, name: id, kind: "attached", endpoint: { baseUrl: "http://127.0.0.1:1", tokenFile: join(home, `${id}.token`) },
        members: id === "one" ? ["ada", "vic"] : ["bob"], displayFloor: 1, workDir: "/home/box/work", createdAt: new Date().toISOString() });
      return registry.create({ name: `Agent ${id}`, boxId: id }).id;
    }) as [string, string];
    // One question waiting and one standing grant per box, on the gate the server replays at start.
    const gate = new PolicyGate({ path: join(home, "policy.jsonl"), boxOf: id => registry.boxOf(id).id, limits: { ...defaultLimits(), approvalRequiredTools: ["bash"] } });
    const ask = (agentId: string, command: string) => {
      const decision = gate.check({ kind: "tool", agentId, agentName: agentId, tool: "bash", input: { command } });
      assert.ok(!decision.allow && decision.approval);
      return decision.approval;
    };
    for (const agentId of [one, two]) { ask(agentId, `deploy waiting ${agentId}`); assert.ok(gate.grant(ask(agentId, `deploy granted ${agentId}`).id, "user", "always")); }
    // A routine per box: each agent's heartbeat, which needs no box to be listed (INV-2094).
    for (const agentId of [one, two]) { seedStanding(registry.dirFor(agentId), agentId); writeFileSync(join(standingDir(registry.dirFor(agentId)), "HEARTBEAT.md"), "- [ ] check in\n"); }
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {}, onReady: url => { base = url; } });
    const gateway = { ada: "member", vic: "viewer", bob: "member", olga: "owner" } as const;
    const call = async (who: keyof typeof gateway, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "content-type": "application/json", authorization: "Bearer t0k", "x-agentbox-user": `web:${who}`, "x-agentbox-role": gateway[who] } });
      return { status: response.status, data: (await response.json()) as Record<string, unknown> };
    };
    type Item = { agentId: string; fingerprint: string; id: string };
    const policy = async (who: keyof typeof gateway) => {
      const got = await call(who, "/api/policy");
      assert.equal(got.status, 200, JSON.stringify(got.data));
      return { pending: (got.data.pending as Item[]).map(item => item.agentId), standing: got.data.standing as Item[] };
    };

    for (const who of ["ada", "vic"] as const) {
      const seen = await policy(who);
      assert.deepEqual(seen.pending, [one], `${who} sees only box one's waiting approval`);
      assert.deepEqual(seen.standing.map(grant => grant.agentId), [one], `${who} sees only box one's grants`);
    }
    const all = await policy("olga");
    assert.deepEqual([...all.pending].sort(), [one, two].sort(), "an admin sees across boxes");
    const theirs = all.standing.find(grant => grant.agentId === two)!, ours = all.standing.find(grant => grant.agentId === one)!;

    assert.equal((await call("ada", "/api/policy/revoke", { fingerprint: theirs.fingerprint })).status, 403, "a driver does not revoke another box's grant");
    assert.equal((await call("vic", "/api/policy/revoke", { fingerprint: ours.fingerprint })).status, 403, "a viewer revokes nothing");
    const waitingTwo = (await call("olga", "/api/policy")).data.pending as Item[];
    assert.equal((await call("ada", "/api/approve", { id: waitingTwo.find(item => item.agentId === two)!.id })).status, 403, "nor answers its approvals");
    assert.equal((await call("ada", "/api/policy/revoke", { fingerprint: ours.fingerprint })).status, 200, "her own box's grant is hers to end");
    assert.equal((await call("olga", "/api/policy/revoke", { fingerprint: theirs.fingerprint })).status, 200, "an admin's reach is the installation");
    assert.deepEqual((await policy("olga")).standing, [], "both ended, and only those two");

    // Tokens: everybody their own, nobody else's; the installation's servers are an admin's.
    for (const who of ["ada", "bob"] as const) assert.equal((await call(who, "/api/mcp/tokens", { label: who })).status, 200);
    const tokens = async (who: keyof typeof gateway) => (await call(who, "/api/mcp")).data;
    assert.deepEqual(((await tokens("ada")).tokens as { label: string }[]).map(token => token.label), ["ada"]);
    const viewer = await tokens("vic");
    assert.deepEqual(viewer.tokens, [], "a viewer reads no one else's tokens");
    assert.deepEqual(viewer.servers, [], "nor the installation's servers");
    assert.ok(viewer.setup, "the setup notice the Mine page reads is still there");
    assert.deepEqual(((await tokens("olga")).tokens as { label: string }[]).map(token => token.label).sort(), ["ada", "bob"]);

    // Running a routine by hand is for the people of the box whose agent runs it (INV-2094).
    assert.equal((await call("ada", "/api/schedules/run", { slug: heartbeatSlug(two) })).status, 403, "a driver does not fire another box's routine");
    assert.equal((await call("bob", "/api/schedules/run", { slug: heartbeatSlug(two) })).status, 200, "its own box's driver does");
    assert.equal((await call("olga", "/api/schedules/run", { slug: heartbeatSlug(one) })).status, 200, "and so does an admin");

    // Restarting the installation is an admin's. Only the refusals are exercised: an admin's would exit the process.
    for (const who of ["ada", "vic"] as const) assert.equal((await call(who, "/api/restart", {})).status, 403, `${who} may not restart`);
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
