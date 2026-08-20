/**
 * Tests for the gateway, against a real socket and a real box stand-in.
 *
 * The claims worth testing are the ones a mistake makes silently false: that a session cannot be
 * forged, that a box's UI token never reaches the browser, that a cookie a client sets cannot be
 * forwarded as a credential, and that one tenant's session cannot open another tenant's box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SqliteControlStore } from "./store.ts";
import { StaticAllocator, type BoxAllocator, type BoxHandle, type BoxSpec } from "./allocator.ts";
import {
  forwardableCookies,
  Gateway,
  PasswordListIdentity,
  routeOf,
  SESSION_COOKIE,
  SessionSigner,
  stripIdentityHeaders,
} from "./gateway.ts";

/** A stand-in box UI: reports back exactly what it was sent, so leaks are visible. */
async function fakeBoxUi(expectedToken: string): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((req, res) => {
    const authorization = req.headers.authorization ?? "";
    if (authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("box: unauthorized");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      // A box setting a cookie must not reach the gateway's origin.
      "set-cookie": "agentbox_ui=box-side-cookie; Path=/",
    });
    res.end(
      JSON.stringify({
        saw: {
          path: req.url,
          cookie: req.headers.cookie ?? null,
          authorization,
          user: req.headers["x-agentbox-user"] ?? null,
          role: req.headers["x-agentbox-role"] ?? null,
        },
      })
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function serve(gateway: Gateway): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    void gateway.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-gateway-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a session cookie cannot be forged, edited or outlived", () => {
  const signer = new SessionSigner(Buffer.from("a".repeat(32)));
  const session = { userId: "u1", tenantId: "tenant-1", role: "member" as const };
  const issued = signer.issue(session);
  assert.deepEqual(signer.verify(issued), session);

  // The whole reason the cookie is signed: otherwise each of these is a way to become someone else.
  const [, , , expires, signature] = issued.split(".");
  assert.equal(
    signer.verify(`u1.tenant-2.member.${expires}.${signature}`),
    undefined,
    "swapped tenant"
  );
  assert.equal(
    signer.verify(`u2.tenant-1.member.${expires}.${signature}`),
    undefined,
    "swapped user"
  );
  assert.equal(
    signer.verify(`u1.tenant-1.owner.${expires}.${signature}`),
    undefined,
    "promoted role — the reason the role can travel in the cookie at all"
  );
  assert.equal(signer.verify(`${issued}x`), undefined, "edited signature");
  assert.equal(signer.verify("u1.tenant-1.member"), undefined, "no signature at all");
  assert.equal(signer.verify(undefined), undefined);
  assert.equal(signer.verify(""), undefined);

  // Another gateway's secret does not open this one's sessions.
  assert.equal(new SessionSigner(randomBytes(32)).verify(issued), undefined);

  // Expiry is checked, so a stolen cookie stops working.
  const old = signer.issue(session, Date.now() - 13 * 60 * 60 * 1000);
  assert.equal(signer.verify(old), undefined, "a session past its expiry is not a session");

  // A signed cookie carrying a role nobody defined means the signing key is not what we think it
  // is, so the whole cookie is refused rather than the role being guessed at.
  const forgedRole = new SessionSigner(Buffer.from("a".repeat(32)));
  const body = `u1.tenant-1.superuser.${Date.now() + 60_000}`;
  const validSignature = (forgedRole as unknown as { sign(body: string): string }).sign(body);
  assert.equal(forgedRole.verify(`${body}.${validSignature}`), undefined);
});

test("only the box's own paths are forwarded; the gateway keeps three", () => {
  assert.deepEqual(routeOf("/gateway/login", "GET"), { kind: "login-page" });
  assert.deepEqual(routeOf("/gateway/login", "POST"), { kind: "login-submit" });
  assert.deepEqual(routeOf("/gateway/logout", "GET"), { kind: "logout" });
  // Everything else, including the root, belongs to the box.
  assert.deepEqual(routeOf("/", "GET"), { kind: "proxy", path: "/" });
  assert.deepEqual(routeOf("/api/agents", "GET"), { kind: "proxy", path: "/api/agents" });
  assert.deepEqual(routeOf("/desktop/1/", "GET"), { kind: "proxy", path: "/desktop/1/" });
});

test("a client cannot smuggle a box credential through the cookie header", () => {
  // agentbox_ui is the box UI's own auth cookie. Forwarding one a client set would let someone
  // present another box's token and have the gateway pass it on faithfully.
  assert.equal(forwardableCookies("agentbox_ui=stolen-token"), undefined);
  assert.equal(forwardableCookies(`${SESSION_COOKIE}=mine`), undefined);
  assert.equal(
    forwardableCookies(`${SESSION_COOKIE}=mine; agentbox_ui=stolen; theme=dark`),
    "theme=dark",
    "unrelated cookies still work, so the UI keeps its preferences"
  );
  assert.equal(forwardableCookies(undefined), undefined);
});

test("the password list refuses a wrong password and an unknown user alike", async () => {
  const identity = PasswordListIdentity.parse("alice:secret:acme, bob:hunter2:beta");
  assert.equal(await identity.authenticate("alice", "secret"), "acme");
  assert.equal(await identity.authenticate("bob", "hunter2"), "beta");
  assert.equal(await identity.authenticate("alice", "Secret"), undefined);
  assert.equal(await identity.authenticate("nobody", "secret"), undefined);
  assert.equal(await identity.authenticate("", ""), undefined);
  // A malformed entry is skipped rather than becoming a user with an empty password.
  assert.equal(await PasswordListIdentity.parse("broken").authenticate("broken", ""), undefined);
});

test("signing in reaches the box, and the box's token never reaches the browser", async () => {
  const { store, cleanup } = fixture();
  const box = await fakeBoxUi("the-ui-token");
  const gateway = new Gateway({
    store,
    allocator: new StaticAllocator(store, {
      boxdUrl: "http://127.0.0.1:1",
      uiUrl: box.url,
      tokens: { box: "the-box-token", ui: "the-ui-token" },
    }),
    identity: PasswordListIdentity.parse("alice:secret:acme"),
    sessionSecret: Buffer.from("b".repeat(32)),
    image: "agentbox/box:test",
  });
  const server = await serve(gateway);
  try {
    // Not signed in: a page navigation is sent to the form, an API call gets a status.
    const anonymous = await fetch(`${server.url}/`, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get("location"), "/gateway/login");
    const anonymousApi = await fetch(`${server.url}/api/agents`, { redirect: "manual" });
    assert.equal(anonymousApi.status, 401, "an API call is not redirected to HTML");

    // A wrong password does not create a session.
    const refused = await fetch(`${server.url}/gateway/login`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "wrong" }),
      redirect: "manual",
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("set-cookie"), null, "no cookie on a failed sign-in");

    const signIn = await fetch(`${server.url}/gateway/login`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "secret" }),
      redirect: "manual",
    });
    assert.equal(signIn.status, 302);
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/, "a script must not be able to read the session");
    assert.match(setCookie, /SameSite=Lax/);
    // The session names a tenant. It must not carry the box's credential.
    assert.ok(!setCookie.includes("the-ui-token"), "the box's token is not in the cookie");
    assert.ok(!setCookie.includes("the-box-token"));

    const session = setCookie.split(";")[0]!;
    const proxied = await fetch(`${server.url}/api/agents?x=1`, {
      headers: { cookie: `${session}; agentbox_ui=smuggled; theme=dark` },
    });
    assert.equal(proxied.status, 200, "the box accepted the injected token");
    const body = (await proxied.json()) as { saw: Record<string, string | null> };
    assert.equal(body.saw.path, "/api/agents?x=1", "the query survives the hop");
    assert.equal(body.saw.authorization, "Bearer the-ui-token");
    assert.equal(body.saw.cookie, "theme=dark", "the smuggled and session cookies were stripped");

    // Nothing about the box's credential comes back to the browser, including its Set-Cookie.
    const returned = JSON.stringify([...proxied.headers.entries()]);
    assert.ok(!returned.includes("box-side-cookie"), "the box's Set-Cookie is not forwarded");
    assert.equal(proxied.headers.get("set-cookie"), null);

    // Signing out invalidates the browser's copy.
    const out = await fetch(`${server.url}/gateway/logout`, {
      headers: { cookie: session },
      redirect: "manual",
    });
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally {
    server.close();
    box.close();
    cleanup();
  }
});

test("one tenant's session cannot open another tenant's box", async () => {
  const { store, cleanup } = fixture();
  const acmeBox = await fakeBoxUi("acme-ui-token");
  const betaBox = await fakeBoxUi("beta-ui-token");
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const beta = store.upsertTenant({ name: "beta" });
    const boxes = new Map<string, BoxHandle>([
      [
        acme.id,
        {
          tenantId: acme.id,
          id: "box-acme",
          externalId: "agentbox-acme",
          boxdUrl: "http://127.0.0.1:1",
          uiUrl: acmeBox.url,
          tokens: { box: "acme-box-token", ui: "acme-ui-token" },
          createdAt: new Date().toISOString(),
          state: "ready",
        },
      ],
      [
        beta.id,
        {
          tenantId: beta.id,
          id: "box-beta",
          externalId: "agentbox-beta",
          boxdUrl: "http://127.0.0.1:1",
          uiUrl: betaBox.url,
          tokens: { box: "beta-box-token", ui: "beta-ui-token" },
          createdAt: new Date().toISOString(),
          state: "ready",
        },
      ],
    ]);
    // A two-tenant allocator, so routing is what is under test rather than allocation.
    const allocator: BoxAllocator = {
      kind: "compose",
      async allocate(tenantId: string, _spec: BoxSpec) {
        return boxes.get(tenantId)!;
      },
      async find(tenantId: string) {
        return boxes.get(tenantId);
      },
      async stop() {},
      async destroy() {},
      async list() {
        return [...boxes.values()];
      },
      async reconcile(handle) {
        return handle;
      },
    };

    const signer = new SessionSigner(Buffer.from("c".repeat(32)));
    const gateway = new Gateway({
      store,
      allocator,
      identity: PasswordListIdentity.parse("alice:secret:acme,bob:secret:beta"),
      sessionSecret: Buffer.from("c".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const asAcme = `${SESSION_COOKIE}=${signer.issue({ userId: "u-acme", tenantId: acme.id, role: "owner" })}`;
      const asBeta = `${SESSION_COOKIE}=${signer.issue({ userId: "u-beta", tenantId: beta.id, role: "owner" })}`;

      const one = await fetch(`${server.url}/api/agents`, { headers: { cookie: asAcme } });
      const two = await fetch(`${server.url}/api/agents`, { headers: { cookie: asBeta } });
      const oneBody = (await one.json()) as { saw: { authorization: string } };
      const twoBody = (await two.json()) as { saw: { authorization: string } };

      // The session decides which box and which credential. Nothing the request carries can move it.
      assert.equal(oneBody.saw.authorization, "Bearer acme-ui-token");
      assert.equal(twoBody.saw.authorization, "Bearer beta-ui-token");

      // Presenting the other tenant's box token by hand changes nothing: the gateway overwrites it.
      const attempt = await fetch(`${server.url}/api/agents`, {
        headers: { cookie: asAcme, authorization: "Bearer beta-ui-token" },
      });
      const attemptBody = (await attempt.json()) as { saw: { authorization: string } };
      assert.equal(
        attemptBody.saw.authorization,
        "Bearer acme-ui-token",
        "a client-supplied Authorization header is replaced, not merged"
      );
    } finally {
      server.close();
    }
  } finally {
    acmeBox.close();
    betaBox.close();
    cleanup();
  }
});

test("a suspended tenant is refused, and a box that is starting says so", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const signer = new SessionSigner(Buffer.from("d".repeat(32)));
    const starting: BoxAllocator = {
      kind: "compose",
      async allocate() {
        throw new Error("still pulling the image");
      },
      async find() {
        return undefined;
      },
      async stop() {},
      async destroy() {},
      async list() {
        return [];
      },
      async reconcile() {
        return undefined;
      },
    };
    const gateway = new Gateway({
      store,
      allocator: starting,
      identity: PasswordListIdentity.parse("alice:secret:acme"),
      sessionSecret: Buffer.from("d".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const session = `${SESSION_COOKIE}=${signer.issue({ userId: "u-tenant", tenantId: tenant.id, role: "owner" })}`;

      // Allocation is slow and can fail. The person gets a page that retries, not a hung request.
      const waiting = await fetch(`${server.url}/`, { headers: { cookie: session } });
      assert.equal(waiting.status, 503);
      assert.equal(waiting.headers.get("retry-after"), "5");
      assert.match(await waiting.text(), /Starting your box/);

      store.setTenantState(tenant.id, "suspended");
      const suspended = await fetch(`${server.url}/`, { headers: { cookie: session } });
      assert.equal(suspended.status, 403, "a suspended tenant is stopped before their box is");
      assert.match(await suspended.text(), /suspended/);

      // A session naming a tenant that no longer exists is not a way in.
      const ghost = `${SESSION_COOKIE}=${signer.issue({ userId: "u1", tenantId: "00000000-0000-0000-0000-000000000000", role: "owner" })}`;
      const gone = await fetch(`${server.url}/`, { headers: { cookie: ghost } });
      assert.equal(gone.status, 403);
    } finally {
      server.close();
    }
  } finally {
    cleanup();
  }
});

test("a box that stops answering is marked unreachable by the request that noticed", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const dead = await fakeBoxUi("token");
    dead.close(); // nothing is listening on that port any more

    const handle: BoxHandle = {
      tenantId: tenant.id,
      id: "box-acme",
      externalId: "agentbox-acme",
      boxdUrl: "http://127.0.0.1:1",
      uiUrl: dead.url,
      tokens: { box: "b", ui: "token" },
      createdAt: new Date().toISOString(),
      state: "ready",
    };
    store.createBox({
      id: handle.id,
      tenantId: tenant.id,
      allocatorKind: "compose",
      externalId: handle.externalId,
      boxdUrl: handle.boxdUrl,
      uiUrl: handle.uiUrl,
      state: "ready",
      image: "agentbox/box:test",
      createdAt: handle.createdAt,
    });

    const signer = new SessionSigner(Buffer.from("e".repeat(32)));
    const gateway = new Gateway({
      store,
      allocator: {
        kind: "compose",
        async allocate() {
          return handle;
        },
        async find() {
          return handle;
        },
        async stop() {},
        async destroy() {},
        async list() {
          return [handle];
        },
        async reconcile() {
          return handle;
        },
      },
      identity: PasswordListIdentity.parse("alice:secret:acme"),
      sessionSecret: Buffer.from("e".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const response = await fetch(`${server.url}/`, {
        headers: { cookie: `${SESSION_COOKIE}=${signer.issue({ userId: "u-tenant", tenantId: tenant.id, role: "owner" })}` },
      });
      assert.equal(response.status, 502);
      // A failed proxy is usually the first thing that notices a dead box, so it is what tells the
      // store — the reaper and the collector both read that state.
      assert.equal(store.getBox("box-acme")?.state, "unreachable");
    } finally {
      server.close();
    }
  } finally {
    cleanup();
  }
});

test("a client cannot assert its own identity", async () => {
  // The rule that fails silently if forgotten: a client sending `X-Agentbox-Role: owner` must have
  // it removed, not forwarded to a box that trusts it. Same rule as Authorization and agentbox_ui.
  const stripped = stripIdentityHeaders({
    "x-agentbox-user": "somebody-else",
    "X-Agentbox-Role": "owner",
    "content-type": "application/json",
  });
  assert.deepEqual(stripped, { "content-type": "application/json" });
  // Case-insensitively, because a comparison that assumes Node's lower-casing breaks the moment
  // this is reused somewhere that does not.
  assert.deepEqual(stripIdentityHeaders({ "X-AGENTBOX-USER": "x" }), {});
});

test("the box is told who is asking, and cannot be lied to about it", async () => {
  const { store, cleanup } = fixture();
  const box = await fakeBoxUi("the-ui-token");
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const user = store.upsertUser({ username: "alice" });
    store.putMembership(user.id, tenant.id, "viewer");
    const signer = new SessionSigner(Buffer.from("f".repeat(32)));
    const gateway = new Gateway({
      store,
      allocator: new StaticAllocator(store, {
        boxdUrl: "http://127.0.0.1:1",
        uiUrl: box.url,
        tokens: { box: "b", ui: "the-ui-token" },
      }),
      identity: PasswordListIdentity.parse("alice:secret:acme"),
      sessionSecret: Buffer.from("f".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const session = `${SESSION_COOKIE}=${signer.issue({
        userId: user.id,
        tenantId: tenant.id,
        role: "viewer",
      })}`;

      const response = await fetch(`${server.url}/api/state`, {
        headers: {
          cookie: session,
          // Both attempts at asserting an identity, which must reach the box as neither.
          "x-agentbox-user": "somebody-else",
          "x-agentbox-role": "owner",
        },
      });
      const body = (await response.json()) as { saw: { user: string; role: string } };
      assert.equal(body.saw.user, user.id, "the session decides who, not the request");
      assert.equal(body.saw.role, "viewer", "and what — the claimed owner did not survive");
    } finally {
      server.close();
    }
  } finally {
    box.close();
    cleanup();
  }
});

test("signing in creates the person, and the first one owns the tenant", async () => {
  const { store, cleanup } = fixture();
  const box = await fakeBoxUi("t");
  try {
    const gateway = new Gateway({
      store,
      allocator: new StaticAllocator(store, {
        boxdUrl: "http://127.0.0.1:1",
        uiUrl: box.url,
        tokens: { box: "b", ui: "t" },
      }),
      identity: PasswordListIdentity.parse("alice:secret:acme,bob:secret:acme"),
      sessionSecret: Buffer.from("g".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const signIn = async (username: string) =>
        fetch(`${server.url}/gateway/login`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "secret" }),
          redirect: "manual",
        });

      await signIn("alice");
      const tenant = store.listTenants()[0]!;
      // Somebody has to be able to invite the second person, and a tenant whose only member cannot
      // manage it is a dead end.
      assert.deepEqual(
        store.membersOf(tenant.id).map(entry => [entry.username, entry.role]),
        [["alice", "owner"]]
      );

      await signIn("bob");
      assert.deepEqual(
        store.membersOf(tenant.id).map(entry => [entry.username, entry.role]).sort(),
        [["alice", "owner"], ["bob", "member"]]
      );

      // Signing in again never changes a role: an owner demoting themselves by reconnecting would be
      // a locked-out tenant.
      store.putMembership(store.findUserByName("bob")!.id, tenant.id, "owner");
      await signIn("bob");
      assert.equal(store.membership(store.findUserByName("bob")!.id, tenant.id)?.role, "owner");
    } finally {
      server.close();
    }
  } finally {
    box.close();
    cleanup();
  }
});

test("a suspended person is refused even with a valid cookie", async () => {
  const { store, cleanup } = fixture();
  const box = await fakeBoxUi("t");
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const user = store.upsertUser({ username: "alice" });
    store.putMembership(user.id, tenant.id, "member");
    const signer = new SessionSigner(Buffer.from("h".repeat(32)));
    const gateway = new Gateway({
      store,
      allocator: new StaticAllocator(store, {
        boxdUrl: "http://127.0.0.1:1",
        uiUrl: box.url,
        tokens: { box: "b", ui: "t" },
      }),
      identity: PasswordListIdentity.parse("alice:secret:acme"),
      sessionSecret: Buffer.from("h".repeat(32)),
      image: "agentbox/box:test",
    });
    const server = await serve(gateway);
    try {
      const session = `${SESSION_COOKIE}=${signer.issue({
        userId: user.id,
        tenantId: tenant.id,
        role: "member",
      })}`;
      assert.equal((await fetch(`${server.url}/api/state`, { headers: { cookie: session } })).status, 200);

      // Checked on every request, which is what makes suspending someone take effect now rather
      // than when their cookie expires — and is why the role can safely travel in the cookie.
      store.setUserState(user.id, "suspended");
      const refused = await fetch(`${server.url}/api/state`, { headers: { cookie: session } });
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /suspended/);
    } finally {
      server.close();
    }
  } finally {
    box.close();
    cleanup();
  }
});
