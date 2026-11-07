/**
 * What this machine is for (INV-1696, docs/96 §3): what each first-run answer leaves on the
 * machine, which later changes are allowed, and that an upgrade is never asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstRunPage, MACHINE_JS } from "./machine-use-ui.ts";
import { localizeScript } from "./page-locale.ts";

type Use = "personal" | "personal-organisation" | "organisation-node";
type Record_ = { use: Use; how: string; at: string };
type Store = { read(): Record_ | undefined; write(use: Use, how: string): Record_ };
type Calls = {
  get(): { use: Use; how: string; connections: number; joinNext: boolean };
  choose(use: string): Promise<{ use?: Use; step?: string }>;
  change(to: string): Promise<{ use: Use }>;
  connectionsChanged(): void;
};
const load = createRequire(import.meta.url);
const machine = load("../../electron/machine-use.cjs") as {
  machineUseStore(o: { file: string }): Store;
  startupUse(o: { store: Store; agentboxHome: string; connections: number }): { wizard?: true; use?: Use; record?: Record_ };
  checkChange(from: Use, to: string): void;
  machineUseCalls(o: { store: Store; organisations: { count(): number; ids(): string[]; disconnect(id: string): Promise<unknown> }; node: { available: boolean; register(o: object): Promise<{ organisation: object }> }; started(use: Use): void }): Calls;
};
const { organisationNode } = load("../../electron/organisation-node.cjs") as { organisationNode(): { available: boolean; register(o: object): Promise<{ organisation: object }> } };

/** A machine on its first start: the shell's userData and an AGENTBOX_HOME, both empty, and the app's connections. */
function freshMachine(t: { after(fn: () => void): void }, connections: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "machine-use-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userData = join(root, "userData");
  const home = join(root, ".agentbox");
  const store = machine.machineUseStore({ file: join(userData, "machine.json") });
  const started: Use[] = [];
  const left: string[] = [];
  const organisations = { count: () => connections.length, ids: () => [...connections], disconnect: async (id: string) => { left.push(id); connections.splice(connections.indexOf(id), 1); } };
  const calls = machine.machineUseCalls({ store, organisations, node: organisationNode(), started: use => started.push(use) });
  return { root, userData, home, store, calls, started, left, connections };
}

test("each first-run answer leaves its own state on the machine, kept in the shell's data and not under ~/.agentbox (INV-1696)", async t => {
  for (const use of ["personal", "personal-organisation"] as const) {
    const m = freshMachine(t);
    assert.deepEqual(machine.startupUse({ store: m.store, agentboxHome: m.home, connections: 0 }), { wizard: true }, "a first run asks");
    assert.deepEqual(await m.calls.choose(use), { use });
    assert.deepEqual(m.started, [use], "the shell starts the personal installation");
    assert.equal(m.store.read()?.use, use);
    assert.equal(m.store.read()?.how, "first-run");
    assert.equal(statSync(join(m.userData, "machine.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(m.home), false, "the choice is the machine's: nothing of it under AGENTBOX_HOME");
    assert.equal(m.calls.get().joinNext, use === "personal-organisation", "personal + organisation goes on to join an organisation");
    assert.equal(m.calls.get().joinNext, false, "once");
    await assert.rejects(m.calls.choose("personal"), (error: { code?: string }) => error.code === "refused", "the first run happens once");
  }
  // The organisation node stops at its own step until INV-1697 registers nodes: nothing is recorded or started.
  const node = freshMachine(t);
  assert.deepEqual(await node.calls.choose("organisation-node"), { step: "node" });
  assert.deepEqual(node.started, []);
  assert.equal(node.store.read(), undefined, "no use recorded, so the person can go back and choose again");
  assert.deepEqual(readdirSync(node.root), [], "nothing created: no personal installation, no shell record");
  assert.deepEqual(await node.calls.choose("personal"), { use: "personal" }, "going back works");
  await assert.rejects(freshMachine(t).calls.choose("organisation"), (error: { code?: string }) => error.code === "unknown");
  // When INV-1697 fills the interface, a registered node is recorded and started as a node.
  const registered = freshMachine(t);
  const filled = machine.machineUseCalls({ store: registered.store, organisations: { count: () => 0, ids: () => [], disconnect: async () => {} }, node: { available: true, register: async () => ({ organisation: { name: "Acme", origin: "https://acme.example" } }) }, started: use => registered.started.push(use) });
  assert.equal((await filled.choose("organisation-node")).use, "organisation-node");
  assert.deepEqual(registered.started, ["organisation-node"]);
});

test("only personal machine and personal + organisation turn into each other; going back disconnects every organisation (INV-1696)", async t => {
  const allowed: [Use, Use][] = [["personal", "personal-organisation"], ["personal-organisation", "personal"], ["personal", "personal"], ["organisation-node", "organisation-node"]];
  for (const [from, to] of allowed) assert.doesNotThrow(() => machine.checkChange(from, to), `${from} -> ${to}`);
  for (const [from, to] of [["personal", "organisation-node"], ["personal-organisation", "organisation-node"], ["organisation-node", "personal"], ["organisation-node", "personal-organisation"]] as [Use, Use][]) {
    assert.throws(() => machine.checkChange(from, to), (error: { code?: string }) => error.code === "reinstall", `${from} -> ${to}`);
  }
  const m = freshMachine(t);
  await m.calls.choose("personal");
  assert.deepEqual(await m.calls.change("personal-organisation"), { use: "personal-organisation" });
  assert.equal(m.store.read()?.how, "settings");
  m.connections.push("org-a", "org-b");
  assert.deepEqual(await m.calls.change("personal"), { use: "personal" });
  assert.deepEqual(m.left, ["org-a", "org-b"], "a personal machine holds no organisation connection");
  await assert.rejects(m.calls.change("organisation-node"), (error: { code?: string }) => error.code === "reinstall");
  assert.equal(m.store.read()?.use, "personal", "a refused change changes nothing");
  // Joining from Settings → Organisations makes it personal + organisation; leaving the last one, personal again.
  m.connections.push("org-c");
  m.calls.connectionsChanged();
  assert.equal(m.calls.get().use, "personal-organisation");
  m.connections.splice(0);
  m.calls.connectionsChanged();
  assert.equal(m.calls.get().use, "personal");
});

test("an upgrade is never asked: a machine with a personal installation is recorded from what is there (INV-1696)", t => {
  const plain = freshMachine(t);
  mkdirSync(plain.home, { recursive: true });
  writeFileSync(join(plain.home, "principals.json"), "{}");
  const started = machine.startupUse({ store: plain.store, agentboxHome: plain.home, connections: 0 });
  assert.equal(started.wizard, undefined);
  assert.deepEqual([started.use, started.record?.how], ["personal", "upgrade"]);
  assert.equal(machine.startupUse({ store: plain.store, agentboxHome: plain.home, connections: 3 }).use, "personal", "recorded once, then read");
  const joined = freshMachine(t);
  mkdirSync(joined.home, { recursive: true });
  writeFileSync(join(joined.home, "config.json"), "{}");
  assert.equal(machine.startupUse({ store: joined.store, agentboxHome: joined.home, connections: 1 }).use, "personal-organisation", "an app that already joined an organisation");
  writeFileSync(join(joined.userData, "machine.json"), JSON.stringify({ use: "mainframe" }));
  assert.throws(() => joined.store.read(), /names no use this version knows/, "an unreadable record is not guessed at");
});

test("the first-run page and the Settings pane are in the bundle's words, in both languages (INV-1696)", () => {
  const zh = firstRunPage("zh-CN,en");
  const en = firstRunPage("en-US");
  assert.match(zh, /<html lang="zh-CN">/);
  assert.match(en, /<html lang="en">/);
  for (const [page, words] of [[zh, ["个人的机器", "个人 + 组织", "组织的节点"]], [en, ["Personal machine", "Personal + organisation", "Organisation node"]]] as const) {
    for (const word of words) assert.ok(page.includes(word), word);
    for (const value of ["personal", "personal-organisation", "organisation-node"]) assert.ok(page.includes(`value="${value}"`), value);
    assert.doesNotMatch(page, /\{\{/, "every word filled");
  }
  assert.ok(localizeScript(MACHINE_JS, "zh").includes("改回 个人的机器"));
});
