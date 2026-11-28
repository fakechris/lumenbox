/**
 * The host checks the box it talks to over HTTPS (docs/106 §5 R7, INV-2204): a certificate an
 * authority vouches for is verified, any other is pinned on first use, and a different one is
 * refused before anything — the box token above all — is written to the connection.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxCertificateRefused, BoxPins, boxFetch, connectToBox, originKey, resetBoxPins } from "./box-tls.ts";
import { BoxClient } from "./client.ts";

function certificate(dir: string, name: string): { key: Buffer; cert: Buffer } {
  const key = join(dir, `${name}.key`), cert = join(dir, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/** A box behind a self-signed terminator: it counts what reaches it, so a leak is visible. */
async function box(t: TestContext, credentials: { key: Buffer; cert: Buffer }, port = 0) {
  const seen: { path: string; authorization: string }[] = [];
  const server = createServer(credentials, (req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization ?? "" });
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/health" ? JSON.stringify({ ok: true }) : JSON.stringify({ stdout: "hi", stderr: "", exit_code: 0 }));
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `https://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a self-signed box is pinned on first use, matched after, and a different key is refused before the token is sent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "box-tls-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = dir; resetBoxPins();
  t.after(() => { if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous; resetBoxPins(); rmSync(dir, { recursive: true, force: true }); });
  const first = certificate(dir, "first"), other = certificate(dir, "other");

  const real = await box(t, first);
  const client = new BoxClient({ baseUrl: real.url, token: "the-box-token" });
  assert.deepEqual(await client.health(), { ok: true }, "the box client reaches a self-signed box: before, it could not");
  const pins = JSON.parse(readFileSync(join(dir, "box-pins.json"), "utf8")) as Record<string, { key: string }>;
  assert.match(pins[originKey(real.url)]!.key, /^sha256\/[A-Za-z0-9+/]+=*$/, "pinned on first use, by its public key");
  const answer = await (client as unknown as { post(path: string, body: unknown): Promise<{ stdout: string }> }).post("/exec", { command: "true" });
  assert.equal(answer.stdout, "hi", "and matched on the next connection");
  assert.equal(real.seen.at(-1)!.authorization, "Bearer the-box-token");

  // Something else answers at the box's address with another key.
  const port = Number(new URL(real.url).port);
  await real.close();
  const impostor = await box(t, other, port);
  await assert.rejects(() => new BoxClient({ baseUrl: real.url, token: "the-box-token" }).health(), (error: Error) =>
    /presented a different certificate/.test(error.message) && /--replace/.test(error.message));
  await assert.rejects(() => boxFetch(`${real.url}/exec`, { method: "POST", headers: { authorization: "Bearer the-box-token" }, body: "{}" }), BoxCertificateRefused);
  assert.deepEqual(impostor.seen, [], "nothing reached it: not the request, not the token");

  // The desktop's socket is checked the same way: its writer is never called for a refused box.
  let wrote = false;
  const refused = await new Promise<string>(resolve => {
    const socket = connectToBox(real.url, {}, () => { wrote = true; resolve("connected"); }, "Grok");
    socket.once("error", error => resolve(error.message));
  });
  assert.match(refused, /^Grok presented a different certificate/);
  assert.equal(wrote, false);

  // Re-attached on purpose: the pin is forgotten, and the box now at that address is pinned afresh.
  assert.equal(new BoxPins(join(dir, "box-pins.json"), () => {}).forget(real.url), true);
  resetBoxPins();
  assert.deepEqual(await new BoxClient({ baseUrl: real.url, token: "t" }).health(), { ok: true });
});

test("plain HTTP to a box is not touched: the network is what identifies it there", async () => {
  // boxFetch hands http:// to the global fetch, unchanged; nothing is pinned for it.
  const dir = mkdtempSync(join(tmpdir(), "box-tls-http-"));
  try {
    const pins = new BoxPins(join(dir, "box-pins.json"), () => {});
    assert.equal(pins.check("http://127.0.0.1:1337", { authorized: true, getPeerCertificate: () => { throw new Error("not asked"); } } as never), "verified");
    assert.equal(originKey("HTTPS://Box.Example.test/x"), "https://box.example.test:443");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
