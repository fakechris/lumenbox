import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Keychain = { items: Map<string, string>; set(a: string, s: string): Promise<void>; get(a: string): Promise<string | undefined>; remove(a: string): Promise<void> };
type Connection = { id: string; name: string; origin: string; identity: string; person: string; role: string };
type Store = { list(): Connection[]; get(id: string): Connection | undefined; token(id: string): Promise<string | undefined>; add(c: Omit<Connection, "id">, token: string): Promise<Connection>; remove(id: string): Promise<boolean> };
const load = createRequire(import.meta.url);
const { memoryKeychain, systemKeychain } = load("../../electron/keychain.cjs") as { memoryKeychain(): Keychain; systemKeychain(platform: string): Keychain };
const orgs = load("../../electron/organisations.cjs") as {
  connectionStore(o: { file: string; keychain: Keychain }): Store;
  parseOrganisationAddress(input: string): { origin: string; code?: string };
  readOrganisation(origin: string, token: string, f?: typeof fetch): Promise<{ identity: string; name: string; role: string }>;
  sessionTokenIn(cookies: { name: string; value: string }[]): string | undefined;
  signInUrl(a: { origin: string; code?: string }): string;
};

test("an organisation address is https, or this computer's loopback; an invite link carries its code to the sign-in page (INV-1690)", () => {
  assert.deepEqual(orgs.parseOrganisationAddress("org.example.com"), { origin: "https://org.example.com" });
  const invite = orgs.parseOrganisationAddress(" https://org.example.com/login?code=4f7kqz ");
  assert.deepEqual(invite, { origin: "https://org.example.com", code: "4F7KQZ" });
  assert.equal(orgs.signInUrl(invite), "https://org.example.com/login?code=4F7KQZ");
  assert.equal(orgs.parseOrganisationAddress("http://127.0.0.1:9000/").origin, "http://127.0.0.1:9000");
  for (const [input, code] of [["", "no-address"], ["http://org.example.com", "not-https"], ["https://a:b@org.example.com", "bad-address"], ["https://", "bad-address"]] as const) {
    assert.throws(() => orgs.parseOrganisationAddress(input), (error: { code?: string }) => error.code === code, input);
  }
  assert.equal(orgs.sessionTokenIn([{ name: "agentbox_ui", value: "x" }, { name: "agentbox_who", value: "web%3Aab%7C0.sig" }]), "web%3Aab%7C0.sig");
});

test("a connection is a record in the shell's file and a token in the keychain, never both in one place; disconnecting clears both (INV-1690)", async t => {
  const dir = mkdtempSync(join(tmpdir(), "org-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "organisations.json");
  const keychain = memoryKeychain();
  const store = orgs.connectionStore({ file, keychain });
  assert.deepEqual(store.list(), []);
  const a = await store.add({ origin: "https://acme.example", name: "", identity: "web:aa", person: "Ana", role: "driver" }, "secret-a");
  const b = await store.add({ origin: "https://other.example", name: "Other", identity: "feishu:ou_1", person: "Ana", role: "viewer" }, "secret-b");
  assert.equal(a.name, "acme.example", "the host when no name was given");
  assert.deepEqual(store.list().map(c => c.name), ["acme.example", "Other"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const onDisk = readFileSync(file, "utf8");
  assert.ok(!onDisk.includes("secret-a") && !onDisk.includes("secret-b"), "no token in the record file");
  assert.equal(keychain.items.get(a.id), "secret-a");
  assert.equal(await store.token(b.id), "secret-b");
  const again = await store.add({ origin: "https://acme.example", name: "Acme", identity: "web:aa", person: "Ana", role: "driver" }, "secret-a2");
  assert.equal(again.id, a.id, "signing in again renews the same connection");
  assert.equal(store.list().length, 2);
  assert.equal(await store.remove(a.id), true);
  assert.equal(keychain.items.has(a.id), false, "the token left the keychain");
  assert.deepEqual(store.list().map(c => c.id), [b.id]);
  assert.equal(await store.token(a.id), undefined);
  writeFileSync(file, JSON.stringify({ connections: [{ id: "org-x", origin: "https://x", token: "leaked" }] }));
  assert.throws(() => store.list(), /tokens live in the keychain only/);
  await assert.rejects(systemKeychain("linux").set("org-x", "t"), /macOS keychain/, "no keychain: nowhere else to keep it");
});

/** One `agentbox web` in its own process and its own AGENTBOX_HOME, as the app or a server starts it. */
async function startInstallation(t: { after(fn: () => void): void }, label: string, args: string[]): Promise<{ base: string; home: string; child: ChildProcess }> {
  const root = mkdtempSync(join(tmpdir(), `org-${label}-`));
  const home = join(root, ".agentbox");
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-transform-types", cli, "web", "--port", "0", "--no-box", ...args], {
    env: { ...process.env, HOME: root, AGENTBOX_HOME: home, AGENTBOX_SCHEDULER: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${label} did not start:\n${out}`)), 60_000);
    const onData = (chunk: Buffer) => {
      out += String(chunk);
      // eslint-disable-next-line no-control-regex
      const found = /agentbox web.*? on (http:\/\/127\.0\.0\.1:\d+)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ""));
      if (found) { clearTimeout(timer); resolve(found[1]!); }
    };
    child.stdout!.on("data", onData); child.stderr!.on("data", onData);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`${label} exited ${code}:\n${out}`)); });
  });
  return { base, home, child };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
}

test("the app joins a throwaway organisation beside its personal installation, reads its agents, and keeps nothing of it in ~/.agentbox (INV-1690)", { timeout: 150_000 }, async t => {
  const orgToken = "org-fixture-ui-token";
  const [personal, org] = await Promise.all([
    startInstallation(t, "personal", ["--desktop"]),
    startInstallation(t, "server", ["--token", orgToken]),
  ]);
  // The organisation's Admin hands out an invite link; the person opens it in the app.
  const invite = await (await fetch(`${org.base}/api/channels/invite`, { method: "POST", headers: { authorization: `Bearer ${orgToken}`, "content-type": "application/json" }, body: JSON.stringify({ role: "driver" }) })).json() as { code: string };
  const address = orgs.parseOrganisationAddress(`${org.base}/login?code=${invite.code}`);
  assert.equal(address.code, invite.code);
  // What the sign-in window does: the organisation's own page posts the code, and the organisation sets its session cookie.
  assert.equal((await fetch(orgs.signInUrl(address))).status, 200);
  const signedIn = await fetch(`${address.origin}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: address.code, name: "Ana" }) });
  assert.equal(signedIn.status, 200);
  const cookies = signedIn.headers.getSetCookie().map(line => { const [pair] = line.split(";"); const at = pair!.indexOf("="); return { name: pair!.slice(0, at), value: pair!.slice(at + 1) }; });
  const token = orgs.sessionTokenIn(cookies);
  assert.ok(token, "the organisation issued a session token");

  const who = await orgs.readOrganisation(address.origin, token);
  assert.equal(who.role, "driver");
  assert.equal(who.name, "Ana");
  await assert.rejects(orgs.readOrganisation(address.origin, "web%3Anobody%7C0.forged"), (error: { code?: string }) => error.code === "not-signed-in");
  await assert.rejects(orgs.readOrganisation(personal.base, token), (error: { code?: string }) => error.code === "personal-installation", "a personal installation is not something to join");

  const shellData = mkdtempSync(join(tmpdir(), "org-shell-userdata-"));
  t.after(() => rmSync(shellData, { recursive: true, force: true }));
  const keychain = memoryKeychain();
  const store = orgs.connectionStore({ file: join(shellData, "organisations.json"), keychain });
  const connection = await store.add({ origin: address.origin, name: "Fixture org", identity: who.identity, person: who.name, role: who.role }, token);

  // Opening the connection: the organisation's agents, with the token from the keychain and nothing else.
  const kept = await store.token(connection.id);
  const state = await (await fetch(`${connection.origin}/api/state`, { headers: { cookie: `agentbox_who=${kept}` } })).json() as { agents: { name: string }[] };
  assert.ok(state.agents.length > 0, "the organisation's agents are listed");
  assert.equal((await fetch(`${connection.origin}/api/state`)).status, 401, "and without the token, nothing");
  // The personal installation, at the same time, is its Owner's.
  const installation = await (await fetch(`${personal.base}/api/installation`)).json() as { installation: { mode: string } };
  assert.equal(installation.installation.mode, "single-machine");
  assert.ok(((await (await fetch(`${personal.base}/api/state`)).json()) as { agents: unknown[] }).agents.length > 0);

  // Nothing of the organisation on the personal side: not its address, not its token, not a file of its data.
  const personalFiles = filesUnder(personal.home);
  assert.ok(personalFiles.length > 0, "the personal installation wrote its own files");
  for (const path of personalFiles) {
    const text = readFileSync(path, "latin1");
    assert.ok(!text.includes(token) && !text.includes(decodeURIComponent(token)) && !text.includes(address.origin), `${relative(personal.home, path)} mentions the organisation`);
  }
  const orgNames = new Set(filesUnder(org.home).map(path => relative(org.home, path)));
  assert.ok(orgNames.has("principals.json"), "the organisation keeps its roster on its server");
  assert.ok(!personalFiles.some(path => path.startsWith(org.home)) && !org.home.startsWith(personal.home), "two data directories, no overlap");
  assert.ok(!readFileSync(join(shellData, "organisations.json"), "utf8").includes(token), "the shell's list holds no token");

  assert.equal(await store.remove(connection.id), true);
  assert.equal(keychain.items.size, 0, "disconnecting deletes the token on this computer");
  assert.deepEqual(store.list(), []);
});
