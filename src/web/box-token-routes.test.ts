/**
 * An Admin rotates a box's token from the page or the CLI, and nothing is re-attached
 * (docs/106 §5 R7, INV-2204). A real server, and behind it an attached box whose stand-in daemon
 * runs the daemon's own token store, so the two steps are the real ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxdTokens } from "../boxd/token-store.ts";

test("a rotation gives the box a new token while it runs: the old one works through the overlap and not after, the host uses the new one, and it is on the record", async t => {
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { attachedBox } = await import("../box/boxes.ts");
  const { AttachedBoxProvisioner } = await import("../box/provisioner.ts");
  const { BOXD_PROTOCOL } = await import("../protocol/index.ts");
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "box-rotate-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;

  const BOOT = "attached-box-boot-token-0001";
  let now = Date.now();
  const tokens = new BoxdTokens(BOOT, join(home, "box-side", "boxd-token.json"), () => now);
  const presented = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer /, "");
  /** What the daemon was asked, and with which token. */
  const asked: { route: string; token: string; accepted: boolean }[] = [];
  const daemon = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const route = `${req.method} ${(req.url ?? "").split("?")[0]}`, token = presented(req);
    res.setHeader("content-type", "application/json");
    if (route === "GET /health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    const accepted = tokens.accepts(token);
    asked.push({ route, token, accepted });
    if (!accepted) { res.statusCode = 401; res.end(JSON.stringify({ error: "Unauthorized" })); return; }
    if (route === "POST /token/rotate" || route === "POST /token/confirm") {
      const answer = tokens.answer(route, token, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      res.statusCode = answer.status; res.end(JSON.stringify(answer.body)); return;
    }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
  const daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
  // The installation's own box is a second stand-in that knows nothing of rotation: it only has to be there.
  const own = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url === "/health" ? { ok: true, protocol: BOXD_PROTOCOL } : {})); });
  await new Promise<void>(resolve => own.listen(0, "127.0.0.1", resolve));
  let stop: (() => void) | undefined;
  t.after(() => { stop?.(); daemon.closeAllConnections(); daemon.close(); own.closeAllConnections(); own.close(); if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous; rmSync(home, { recursive: true, force: true }); });

  const tokenFile = join(home, "grok.token");
  writeFileSync(tokenFile, `${BOOT}\n`, { mode: 0o600 });
  const registry = new AgentRegistry();
  const grok = registry.attachBox(attachedBox({ name: "grok", baseUrl: daemonUrl, tokenFile, displayFloor: 10 }));
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", onLog: () => {},
    boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${(own.address() as { port: number }).port}`, token: "own-box-token-000000" }),
    onReady: url => { base = url; } });
  const rotate = (box: string, headers: Record<string, string> = { authorization: "Bearer t0k" }) =>
    fetch(`${base}/api/boxes/rotate-token`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ box }) });

  // The box is connected at start; wait for it as the page would.
  for (let n = 0; n < 100 && !(await (await fetch(`${base}/api/boxes`, { headers: { authorization: "Bearer t0k" } })).text()).includes('"connected":true'); n += 1) await new Promise(resolve => setTimeout(resolve, 20));

  const answer = await rotate("grok");
  const body = await answer.json() as { confirmed: boolean; overlapUntil: string; note: string };
  assert.equal(answer.status, 200, JSON.stringify(body));
  assert.equal(body.confirmed, true);
  assert.match(body.note, /grok has a new token\. The old one keeps working until/);
  const next = readFileSync(tokenFile, "utf8").trim();
  assert.match(next, /^[0-9a-f]{64}$/);
  assert.notEqual(next, BOOT);
  assert.equal(existsSync(`${tokenFile}.next`), false, "the pending file is gone once the token file holds the new one");
  assert.deepEqual(asked.filter(line => line.route.startsWith("POST /token")).map(line => [line.route, line.token === BOOT ? "old" : line.token === next ? "new" : "?"]),
    [["POST /token/rotate", "old"], ["POST /token/confirm", "new"]], "named with the old token, confirmed with the new one");

  // During the overlap both open the box; the host's own calls already carry the new one.
  assert.equal(tokens.accepts(BOOT), true);
  assert.equal(tokens.accepts(next), true);
  await fetch(`${base}/desktop/b/${grok.id}/10/app/ui.js`, { headers: { authorization: "Bearer t0k" } });
  // After it, only the new one.
  now += 5 * 60_000;
  assert.equal(tokens.accepts(BOOT), false);
  assert.equal(tokens.accepts(next), true);
  assert.ok(asked.slice(asked.findIndex(line => line.route === "POST /token/confirm") + 1).every(line => line.token === next), "nothing the host sent after the switch carried the old token");

  // A second rotation works from the new token, and a box restart in between changes nothing.
  const restarted = new BoxdTokens(BOOT, join(home, "box-side", "boxd-token.json"), () => now);
  assert.equal(restarted.accepts(next), true, "the box came back with the rotated token");

  // A side-door token minted and revoked goes on the same record (R8).
  const { Principals } = await import("../host/principals.ts");
  new Principals().save([{ id: "ann", name: "Ann", role: "admin", identities: [] }]);
  const minted = await (await fetch(`${base}/api/mcp/tokens`, { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json" }, body: JSON.stringify({ principalId: "ann", label: "watchdog" }) })).json() as { token: string; createdAt: string };
  assert.equal((await fetch(`${base}/api/mcp/tokens/revoke`, { method: "POST", headers: { authorization: "Bearer t0k", "content-type": "application/json" }, body: JSON.stringify({ createdAt: minted.createdAt }) })).status, 200);

  // A box this installation keeps no token file for is refused with why; all of it on the record.
  assert.equal((await rotate("nope")).status, 404);
  const ownRefused = await rotate(registry.box.id);
  assert.equal(ownRefused.status, 409);
  const record = readFileSync(join(home, "tokens.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(record.filter(line => line.event === "rotated").map(line => [line.kind, line.boxName, line.by, line.confirmed]), [["box", "grok", "operator", true]]);
  assert.ok(record.some(line => line.event === "rotation-refused"));
  assert.deepEqual(record.filter(line => line.kind === "side-door").map(line => [line.event, line.for, line.label, line.by]), [["minted", "ann", "watchdog", "operator"], ["revoked", "ann", "watchdog", "operator"]]);
  const written = readFileSync(join(home, "tokens.jsonl"), "utf8");
  assert.ok(!written.includes(next) && !written.includes(BOOT) && !written.includes(minted.token), "never a token");
});
