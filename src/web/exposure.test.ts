/**
 * Where an installation is reachable, and what that requires of it (docs/106 §5, INV-2204).
 *
 * The first test pins `local` — every personal installation and the desktop app — as it was before
 * levels existed: it was written against the code before the change and passed there unchanged.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_INSECURE", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUST_GATEWAY_IDENTITY"] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;

/** A real server on a temporary home with exactly `env` of the settings a level is read from; an organisation's roster, so people can be invited. */
async function serve(t: TestContext, options: { host?: string; token?: string }, env: Env = {}) {
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "agentbox-exposure-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const restore = () => { for (const key of KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } };
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env, { AGENTBOX_HOME: home });
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
  const logs: string[] = [];
  let base = "";
  let stop: (() => void) | undefined;
  t.after(() => { stop?.(); restore(); rmSync(home, { recursive: true, force: true }); });
  try {
    stop = await startWebServer({ port: 0, host: options.host ?? "127.0.0.1", ...(options.token !== undefined ? { token: options.token } : {}), useBox: false, onLog: line => logs.push(line), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
  } finally { restore(); process.env.AGENTBOX_HOME = home; }
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: "manual" });
  /** A person invited by the operator's machine credential and signed in with the code: their Set-Cookie line. */
  const signIn = async (name: string, role: string, operator: Record<string, string>) => {
    const invite = await fetch(base + "/api/channels/invite", { method: "POST", headers: { ...operator, "content-type": "application/json" }, body: JSON.stringify({ role }) });
    assert.equal(invite.status, 200, "the operator's machine credential makes an invitation");
    const { code } = await invite.json() as { code: string };
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
    assert.equal(login.status, 200);
    return login.headers.getSetCookie()[0]!;
  };
  return { base, home, logs, get, signIn };
}

test("local is what it was: no token on loopback, ?token= to a cookie, the bearer token, no Secure and no HSTS", async t => {
  const open = await serve(t, {});
  const anyone = await open.get("/api/me");
  assert.equal(anyone.status, 200, "loopback with no token configured serves whoever reaches it");
  assert.equal(anyone.headers.get("strict-transport-security"), null);

  const TOKEN = "l0cal-t0ken";
  const { get, signIn } = await serve(t, { token: TOKEN });
  const refused = await get("/api/me");
  assert.equal(refused.status, 401);
  assert.match((await refused.json() as { error: string }).error, /\?token=/, "and says how the operator gets in");

  const bootstrap = await get(`/?token=${TOKEN}`);
  assert.equal(bootstrap.status, 200, "the desktop app's first page load");
  assert.equal(bootstrap.headers.get("set-cookie"), `agentbox_ui=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`, "the token becomes a cookie the plain-HTTP loopback page can store");
  assert.equal(bootstrap.headers.get("strict-transport-security"), null);

  assert.equal((await get("/api/me", { cookie: `agentbox_ui=${TOKEN}` })).status, 200, "the cookie carries the page's later requests");
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}` })).status, 200, "the app shell and the CLI send it as a header");
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.9" })).status, 200, "from wherever");
  assert.equal((await get("/api/me", { authorization: "Bearer wrong" })).status, 401);

  const session = await signIn("Ana", "driver", { authorization: `Bearer ${TOKEN}` });
  assert.match(session, /^agentbox_who=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/, "a person's session is not Secure on plain loopback");
  const me = await get("/api/me", { cookie: session.split(";")[0]! });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { role: string }).role, "driver");
});
