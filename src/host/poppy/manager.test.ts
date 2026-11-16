import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PoppyManager } from "./manager.ts";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "poppy-mgr-"));
}

describe("PoppyManager", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("initializes and creates an identity", async () => {
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    assert.ok(!mgr.ready);
    await mgr.init();
    assert.ok(mgr.ready);
    assert.equal(mgr.getIdentity().clientId, "https://agent.test/poppy/agent.json");
  });

  it("serves client metadata and JWKS", async () => {
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr.init();

    const meta = mgr.clientMetadata();
    assert.equal(meta.client_id, "https://agent.test/poppy/agent.json");
    assert.equal(meta.jwks_uri, "https://agent.test/poppy/jwks.json");
    assert.equal(meta.token_endpoint_auth_method, "private_key_jwt");

    const jwks = mgr.jwks();
    assert.equal(jwks.keys.length, 1);
    assert.equal(jwks.keys[0]!.kty, "EC");
    assert.equal(jwks.keys[0]!.use, "sig");
  });

  it("shouldInjectHeaders skips poppy.json itself", async () => {
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr.init();
    assert.ok(!mgr.shouldInjectHeaders("https://example.com/.well-known/poppy.json"));
    assert.ok(!mgr.shouldInjectHeaders("https://example.com/.well-known/oauth-protected-resource"));
  });

  it("shouldInjectHeaders returns true for unknown domains", async () => {
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr.init();
    assert.ok(mgr.shouldInjectHeaders("https://example.com/api/orders"));
  });

  it("persists the agent key across restarts", async () => {
    const home = tmpHome();
    dirs.push(home);

    const mgr1 = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr1.init();
    const kid1 = mgr1.getIdentity().kid;

    const mgr2 = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr2.init();
    const kid2 = mgr2.getIdentity().kid;

    assert.equal(kid1, kid2, "same key after restart");
  });

  it("headersFor returns empty for a domain that fails discovery", async t => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr.init();
    const headers = await mgr.headersFor("GET", "https://definitely-no-poppy.invalid/api");
    assert.deepEqual(headers, {});
  });

  it("status() reports the current state", async () => {
    const home = tmpHome();
    dirs.push(home);
    const mgr = new PoppyManager({ home, origin: "https://agent.test" });
    await mgr.init();

    const s = mgr.status();
    assert.ok(s.ready);
    assert.equal(s.clientId, "https://agent.test/poppy/agent.json");
    assert.deepEqual(s.activeSessions, []);
  });
});
