/**
 * Signing in gives you *your* credential, not the installation's (INV — docs/52 M1).
 *
 * The failure this pins: both login paths used to set `agentbox_ui=<installation token>`
 * beside the session cookie, so a viewer's browser held the full-power credential. Roles
 * were enforced only on requests that still carried the session cookie — sending the very
 * token the login had just handed over, without that cookie, was served as the unnamed
 * owner, which is every route with no role check at all. Verified against this server
 * before the fix: `POST /api/prompt` reached body validation as a viewer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { startWebServer } from "./server.ts";

const PORT = 7942;
const BASE = `http://127.0.0.1:${PORT}`;

test("a login hands out a session, never the installation token; the session authenticates and carries the roster's role", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-session-credential-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const signIn = async (role: string, name: string): Promise<string[]> => {
      const invite = (await (await fetch(`${BASE}/api/channels/invite`, { method: "POST", headers: ui, body: JSON.stringify({ role }) })).json()) as { code: string };
      const response = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, name }) });
      return response.headers.getSetCookie();
    };

    const cookies = await signIn("viewer", "Vic");
    assert.deepEqual(
      cookies.map(cookie => cookie.split("=")[0]),
      ["agentbox_who"],
      "the only thing a login sets is the session: the installation token is not a thing people are handed"
    );
    const jar = cookies.map(cookie => cookie.split(";")[0]).join("; ");
    const prompt = (headers: Record<string, string>) =>
      fetch(`${BASE}/api/prompt`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ agent: ada, text: "drive it" }) });

    // The session authenticates — and says who, so the roster's role applies.
    const asViewer = await prompt({ cookie: jar });
    assert.equal(asViewer.status, 403);
    assert.match(((await asViewer.json()) as { error: string }).error, /watch but not drive/);

    // And there is nothing else in that browser to send instead.
    const withoutSession = await prompt({});
    assert.equal(withoutSession.status, 401, "no session, no token, no service");

    // A driver signs in the same way and is served.
    const driver = (await signIn("driver", "Dana")).map(cookie => cookie.split(";")[0]).join("; ");
    const asDriver = await prompt({ cookie: driver });
    assert.notEqual(asDriver.status, 401);
    assert.notEqual(asDriver.status, 403);

    // A session is only good while the roster still knows the person: signing out is
    // removing them, not waiting for a cookie to lapse.
    const roster = JSON.parse(await (await fetch(`${BASE}/api/state`, { headers: ui })).text()) as unknown;
    void roster;
    const viewerRead = await fetch(`${BASE}/api/state`, { headers: { cookie: jar } });
    assert.equal(viewerRead.status, 200, "a viewer may still watch");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("one vocabulary, three entrances, and signing one person out of everywhere (INV-537)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-roles-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    stop = await startWebServer({ port: PORT + 1, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const base = `http://127.0.0.1:${PORT + 1}`;
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const drive = (headers: Record<string, string>) =>
      fetch(`${base}/api/prompt`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ agent: ada, text: "" }) });

    // Entrance 1: the installation's own credential. Nobody asserted a role; the operator drives.
    assert.equal((await drive({ authorization: "Bearer t0k" })).status, 400, "reached the body: not refused");

    // Entrance 2: a gateway asserting the control plane's words, translated at the edge.
    assert.equal((await drive({ authorization: "Bearer t0k", "x-agentbox-user": "u1", "x-agentbox-role": "viewer" })).status, 403);
    assert.equal((await drive({ authorization: "Bearer t0k", "x-agentbox-user": "u1", "x-agentbox-role": "member" })).status, 400);
    assert.equal((await drive({ authorization: "Bearer t0k", "x-agentbox-user": "u1", "x-agentbox-role": "owner" })).status, 400);

    // Entrance 3: a session, whose authority is the roster's answer.
    const signIn = async (role: string, name: string): Promise<string> => {
      const invite = (await (await fetch(`${base}/api/channels/invite`, { method: "POST", headers: ui, body: JSON.stringify({ role }) })).json()) as { code: string };
      const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, name }) });
      return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    };
    const vic = await signIn("viewer", "Vic");
    const dana = await signIn("driver", "Dana");
    assert.equal((await drive({ cookie: vic })).status, 403);
    assert.equal((await drive({ cookie: dana })).status, 400);

    // Signing Dana out everywhere: her cookie stops being served, Vic's still is.
    const people = (await (await fetch(`${base}/api/channels`, { headers: ui })).json()) as { principals?: { id: string; name: string }[] };
    const danaId = (people.principals ?? []).find(person => person.name === "Dana")?.id;
    assert.ok(danaId, "the roster knows Dana");
    const out = await fetch(`${base}/api/principals/logout`, { method: "POST", headers: ui, body: JSON.stringify({ principalId: danaId }) });
    assert.equal(out.status, 200);
    assert.equal((await drive({ cookie: dana })).status, 401, "her generation moved on");
    assert.equal((await drive({ cookie: vic })).status, 403, "and nobody else was signed out");
  } finally {
    stop?.();
    if (previous === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
