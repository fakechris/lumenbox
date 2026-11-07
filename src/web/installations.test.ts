import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLATIONS_JS } from "./installations-ui.ts";
import { localizeScript } from "./page-locale.ts";

type Counts = { reachable: true; unread: number; needsYou: number } | { reachable: false };
type Entry = { id: string; kind: string; name?: string; role: string; selected: boolean; unread?: number; needsYou?: number; unknown?: boolean };
const load = createRequire(import.meta.url);
const inst = load("../../electron/installations.cjs") as {
  PERSONAL: string;
  allowedRequest(url: string, origin: string): boolean;
  countsFrom(state: unknown, attention: unknown): { unread: number; needsYou: number };
  installationList(connections: { id: string; name: string; role: string }[], counts: Map<string, Counts>, selected?: string): Entry[];
  readCounts(origin: string, token: string, f?: typeof fetch): Promise<Counts>;
};

test("the first level: personal first as its Owner, organisations by name with their role, each with its own counts (INV-1691)", () => {
  const connections = [{ id: "org-b", name: "Zeta", role: "viewer" }, { id: "org-a", name: "Acme", role: "admin" }, { id: "org-c", name: "Beta", role: "driver" }];
  const counts = new Map<string, Counts>([["org-a", { reachable: true, unread: 4, needsYou: 2 }], ["org-b", { reachable: true, unread: 0, needsYou: 7 }], ["org-c", { reachable: false }]]);
  const list = inst.installationList(connections, counts, "org-b");
  assert.deepEqual(list.map(e => [e.id, e.role]), [["personal", "owner"], ["org-a", "admin"], ["org-c", "driver"], ["org-b", "viewer"]]);
  assert.deepEqual(list.map(e => e.selected), [false, false, false, true]);
  assert.deepEqual([list[1]!.unread, list[1]!.needsYou, list[3]!.needsYou], [4, 2, 7], "one organisation's counts are its own, not another's");
  assert.equal(list[2]!.unknown, true, "a count that could not be read is unknown, not zero");
  assert.equal(list[2]!.unread, undefined);
  assert.equal(list[0]!.unread, undefined, "the personal entry carries no count from the shell: the page counts its own installation");
  assert.equal(inst.installationList(connections, counts, "org-gone")[0]!.selected, true, "a selection that was disconnected falls back to personal");
  assert.ok(!JSON.stringify(list).includes("origin") && !JSON.stringify(list).includes("token"), "ids, names, roles and numbers: no address, no token");
  assert.deepEqual(inst.countsFrom({ agents: [{ facts: { unreadCount: 2 } }, { facts: { unreadCount: 3 } }, {}] }, { mine: [{}, {}], theirs: [{}] }), { unread: 5, needsYou: 2 });
});

test("an organisation's counts are asked of that organisation, with its token, and nothing else (INV-1691)", async () => {
  const asked: { url: string; cookie: string }[] = [];
  const answers: Record<string, unknown> = {
    "https://acme.example/api/state": { agents: [{ facts: { unreadCount: 3 } }] },
    "https://acme.example/api/attention": { mine: [{ kind: "approval" }], theirs: [{}, {}] },
  };
  const fake = (async (url: string, init: { headers: Record<string, string> }) => {
    asked.push({ url, cookie: init.headers.cookie! });
    return url in answers ? new Response(JSON.stringify(answers[url])) : new Response("no", { status: 401 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await inst.readCounts("https://acme.example", "tok-a", fake), { reachable: true, unread: 3, needsYou: 1 });
  assert.deepEqual(asked.map(a => a.url).sort(), ["https://acme.example/api/attention", "https://acme.example/api/state"]);
  assert.ok(asked.every(a => a.cookie === "agentbox_who=tok-a"));
  assert.deepEqual(await inst.readCounts("https://other.example", "tok-b", fake), { reachable: false }, "a refused read is unknown");
});

test("an organisation's view may reach its own origin and nothing else, the personal server included (INV-1691)", () => {
  const origin = "https://acme.example";
  for (const url of ["https://acme.example/", "https://acme.example/api/state?x=1", "wss://acme.example/desk/websockify", "data:image/png;base64,AA", "blob:https://acme.example/1"]) assert.equal(inst.allowedRequest(url, origin), true, url);
  for (const url of ["http://127.0.0.1:7777/api/state", "https://other.example/api/state", "http://acme.example/", "https://acme.example:8443/", "https://cdn.example/x.js", "not a url"]) assert.equal(inst.allowedRequest(url, origin), false, url);
  assert.equal(inst.allowedRequest("ws://127.0.0.1:9000/x", "http://127.0.0.1:9000"), true, "a loopback rehearsal organisation");
});

/** Just enough of a document for the first-level script: elements, attributes, children, a class list. */
function fakeDom() {
  type Node = { tag: string; attrs: Record<string, string>; children: Node[]; text: string; onclick?: () => void; offsetWidth: number; classes: Set<string> };
  const make = (tag: string): Node => ({ tag, attrs: {}, children: [], text: "", offsetWidth: 76, classes: new Set() });
  const api = (node: Node): unknown => ({
    get textContent() { return node.text; }, set textContent(v: string) { node.text = v; node.children = []; },
    setAttribute: (k: string, v: string) => { node.attrs[k] = v; }, appendChild: (child: { __node: Node }) => { node.children.push(child.__node); return child; },
    set onclick(f: () => void) { node.onclick = f; }, get offsetWidth() { return node.offsetWidth; }, set title(v: string) { node.attrs.title = v; },
    querySelector: () => null, __node: node,
  });
  const head = make("head"); const body = make("body");
  const wrapped = new Map<Node, unknown>();
  const wrap = (node: Node) => { if (!wrapped.has(node)) wrapped.set(node, api(node)); return wrapped.get(node); };
  const document = {
    createElement: (tag: string) => wrap(make(tag)),
    head: wrap(head),
    body: Object.assign(wrap(body) as object, { classList: { toggle: (c: string, on: boolean) => { if (on) body.classes.add(c); else body.classes.delete(c); } } }),
  };
  const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
  return { document, body, all };
}

async function runRail(shellList: Entry[], personal: { state: unknown; attention: unknown }) {
  const dom = fakeDom();
  const fetched: string[] = [];
  const selected: [string, number][] = [];
  const window: Record<string, unknown> = {
    lumenboxShell: { installations: { list: async () => ({ installations: shellList }), select: async (id: string, rail: number) => { selected.push([id, rail]); return { selected: id }; } } },
  };
  const fetchDouble = async (route: string) => { fetched.push(route); return new Response(JSON.stringify(route === "/api/state" ? personal.state : personal.attention)); };
  new Function("window", "document", "fetch", "setInterval", localizeScript(INSTALLATIONS_JS, "en"))(window, dom.document, fetchDouble, () => 0);
  await (window.installRail as { refresh(): Promise<void> }).refresh();
  const rail = dom.all(dom.body).find(n => n.attrs.id === "installrail")!;
  return { dom, rail, fetched, selected, window };
}

test("the rail draws each installation with its role and its own counts; the personal counts come from this page's own server (INV-1691)", async () => {
  const list: Entry[] = [
    { id: "personal", kind: "personal", role: "owner", selected: true },
    { id: "org-a", kind: "organisation", name: "Acme", role: "admin", selected: false, unread: 4, needsYou: 2 },
    { id: "org-b", kind: "organisation", name: "Beta", role: "viewer", selected: false, unknown: true },
  ];
  const { dom, rail, fetched, selected } = await runRail(list, { state: { agents: [{ facts: { unreadCount: 1 } }] }, attention: { mine: [], theirs: [] } });
  assert.ok(dom.body.classes.has("has-rail"), "shown once an organisation is joined");
  assert.deepEqual([...new Set(fetched)].sort(), ["/api/attention", "/api/state"], "relative routes: the personal page asks only its own server");
  const buttons = rail.children;
  assert.deepEqual(buttons.map(b => b.attrs["data-install"]), ["personal", "org-a", "org-b"]);
  const text = (b: (typeof buttons)[number]) => dom.all(b).map(n => n.text).filter(Boolean);
  assert.deepEqual(text(buttons[0]!), ["P", "Personal", "Owner", "1 unread"]);
  assert.deepEqual(text(buttons[1]!), ["A", "2", "Acme", "admin", "4 unread"], "the badge is what needs you there");
  assert.deepEqual(text(buttons[2]!), ["B", "Beta", "viewer", "—"]);
  assert.equal(buttons[1]!.attrs.title, "Acme · admin · 2 need you · 4 unread");
  assert.equal(buttons[0]!.attrs["aria-current"], "true");
  buttons[1]!.onclick!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(selected, [["org-a", 76]], "selecting asks the shell, with the column's width");
});

test("with no organisation the first level is not drawn: a column of one says nothing (INV-1691)", async () => {
  const { dom } = await runRail([{ id: "personal", kind: "personal", role: "owner", selected: true }], { state: { agents: [] }, attention: { mine: [] } });
  assert.equal(dom.body.classes.has("has-rail"), false);
  assert.ok(localizeScript(INSTALLATIONS_JS, "zh").includes("个人") && localizeScript(INSTALLATIONS_JS, "zh").includes("机主"), "the words come from the bundle in both languages");
});

/** One `agentbox web` in its own process and its own AGENTBOX_HOME. */
async function startInstallation(t: { after(fn: () => void): void }, label: string, args: string[]): Promise<{ base: string; child: ChildProcess }> {
  const root = mkdtempSync(join(tmpdir(), `inst-${label}-`));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-transform-types", cli, "web", "--port", "0", "--no-box", ...args], {
    env: { ...process.env, HOME: root, AGENTBOX_HOME: join(root, ".agentbox"), AGENTBOX_SCHEDULER: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { child.kill(); rmSync(root, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`${label} did not start:\n${out}`)), 60_000);
    const onData = (chunk: Buffer) => { out += String(chunk); const found = / on (http:\/\/127\.0\.0\.1:\d+)\b/.exec(out); if (found) { clearTimeout(timer); resolve(found[1]!); } };
    child.stdout!.on("data", onData); child.stderr!.on("data", onData);
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`${label} exited ${code}:\n${out}`)); });
  });
  return { base, child };
}

test("a throwaway organisation's counts are read from it with the person's session, and every request goes to it alone (INV-1691)", { timeout: 150_000 }, async t => {
  const orgToken = "org-fixture-ui-token";
  const [personal, org] = await Promise.all([startInstallation(t, "personal", ["--desktop"]), startInstallation(t, "server", ["--token", orgToken])]);
  const invite = await (await fetch(`${org.base}/api/channels/invite`, { method: "POST", headers: { authorization: `Bearer ${orgToken}`, "content-type": "application/json" }, body: JSON.stringify({ role: "driver" }) })).json() as { code: string };
  const signedIn = await fetch(`${org.base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: invite.code, name: "Ana" }) });
  const cookie = signedIn.headers.getSetCookie().map(line => line.split(";")[0]!).find(pair => pair.startsWith("agentbox_who="))!;
  const token = cookie.slice("agentbox_who=".length);
  const asked: string[] = [];
  const recording = ((url: string, init: RequestInit) => { asked.push(new URL(url).origin); return fetch(url, init); }) as typeof fetch;
  const counts = await inst.readCounts(org.base, token, recording);
  assert.equal(counts.reachable, true);
  assert.ok(counts.reachable && Number.isInteger(counts.unread) && Number.isInteger(counts.needsYou));
  assert.deepEqual([...new Set(asked)], [org.base], "the organisation's counts are asked of the organisation only");
  assert.deepEqual(await inst.readCounts(org.base, "web%3Anobody%7C0.forged", recording), { reachable: false }, "a token the organisation does not know counts nothing");
  assert.equal(inst.allowedRequest(`${personal.base}/api/state`, org.base), false, "and the organisation's view may not ask the personal server");
});
