/**
 * The way a person reaches their box.
 *
 * ```
 * person → gateway ── session cookie ──► which tenant is this?
 *                  ── allocate/find ──► that tenant's box
 *                  ── proxy /* ───────► the box's UI, with its UI token injected
 * ```
 *
 * The decisions, and why each one is the way it is:
 *
 *   - **The box's UI token never reaches the browser.** The gateway holds it and injects it, the way
 *     the existing web server already injects the box token when proxying a desktop. A token in a
 *     browser is a token in history, in a bookmark, and in a screenshot; and here it would be
 *     *another tenant's* box credential, not just the user's own.
 *   - **The session cookie carries a tenant id and a signature, and nothing else.** No server-side
 *     session table, so the gateway restarts without logging everyone out — and no trust in the
 *     cookie's contents, because it is signed. An unsigned cookie holding a tenant id is an
 *     invitation to type someone else's.
 *   - **Identity is a seam, not a decision.** The design deliberately leaves authentication
 *     unspecified: OIDC, a password list, or an existing provider all fit behind
 *     `IdentityProvider`. What matters is that it yields a tenant before anything else runs. The
 *     implementation here is a password list, and its shortcomings are written down rather than
 *     hidden ([`PasswordListIdentity`]).
 *   - **A person's request never waits on a box being created.** Allocation is slow — seconds at
 *     best, minutes when an image has to be pulled — so a request that arrives before the box is
 *     ready gets a page saying so, not a hung connection.
 *   - **The gateway is not in the path of a turn.** It proxies a UI. Agents keep working while it is
 *     down; nobody can watch them, which is recoverable, and a restart costs nothing.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { parseCookies } from "../web/auth.ts";
import type { BoxAllocator, BoxHandle } from "./allocator.ts";
import type { ControlStore } from "./store.ts";

export const SESSION_COOKIE = "agentbox_session";

/** How long a session lasts. Short enough that a stolen cookie expires, long enough to work a day. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface IdentityProvider {
  /**
   * Who is this, if anyone.
   *
   * Returns a tenant *name*, not an id: an identity provider knows about people and organisations,
   * not about this system's primary keys.
   */
  authenticate(username: string, password: string): Promise<string | undefined>;
}

/**
 * A password list, as the placeholder.
 *
 * Honest about what it is not: passwords are compared, not hashed with a slow KDF, and there is no
 * lockout, no rotation and no second factor. It is a stand-in that makes the rest of the gateway
 * real, and it should be replaced by an identity provider before anyone who is not the operator uses
 * it. The comparison is at least timing-safe, because that costs one function call.
 */
export class PasswordListIdentity implements IdentityProvider {
  constructor(private readonly users: ReadonlyMap<string, { password: string; tenant: string }>) {}

  /** `alice:secret:acme,bob:hunter2:beta` — for a config file or an environment variable. */
  static parse(spec: string): PasswordListIdentity {
    const users = new Map<string, { password: string; tenant: string }>();
    for (const entry of spec.split(",")) {
      const [username, password, tenant] = entry.trim().split(":");
      if (!username || !password || !tenant) continue;
      users.set(username, { password, tenant });
    }
    return new PasswordListIdentity(users);
  }

  async authenticate(username: string, password: string): Promise<string | undefined> {
    const found = this.users.get(username);
    // Compared even when the user does not exist, so the answer takes the same time either way.
    const expected = found?.password ?? randomBytes(16).toString("hex");
    const a = Buffer.from(password);
    const b = Buffer.from(expected);
    const matches = a.length === b.length && timingSafeEqual(a, b);
    return matches && found !== undefined ? found.tenant : undefined;
  }
}

/** Signs and checks a session, so no session table is needed and no cookie is believed. */
export class SessionSigner {
  constructor(private readonly secret: Buffer) {}

  issue(tenantId: string, now = Date.now()): string {
    const expires = now + SESSION_TTL_MS;
    const body = `${tenantId}.${expires}`;
    return `${body}.${this.sign(body)}`;
  }

  /** The tenant id, or undefined if the cookie is forged, corrupt or expired. */
  verify(value: string | undefined, now = Date.now()): string | undefined {
    if (value === undefined) return undefined;
    const at = value.lastIndexOf(".");
    if (at <= 0) return undefined;
    const body = value.slice(0, at);
    const signature = value.slice(at + 1);
    const expected = this.sign(body);
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return undefined;
    }
    const [tenantId, expires] = body.split(".");
    if (tenantId === undefined || expires === undefined) return undefined;
    if (Number(expires) <= now) return undefined;
    return tenantId;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}

export interface GatewayOptions {
  store: ControlStore;
  allocator: BoxAllocator;
  identity: IdentityProvider;
  /** Signs sessions. Minted if absent, which logs everyone out on restart — fine for development. */
  sessionSecret?: Buffer;
  /** The image a new box is created from. */
  image: string;
  /** Environment handed to a new box: provider configuration, and later the relay address. */
  boxEnv?: Record<string, string>;
  /** True behind TLS: sets `Secure` on the cookie. */
  secureCookies?: boolean;
  log?: (line: string) => void;
}

export type GatewayRoute =
  | { kind: "login-page" }
  | { kind: "login-submit" }
  | { kind: "logout" }
  | { kind: "proxy"; path: string };

/**
 * Routing, separated from the server so it can be tested without a socket.
 *
 * Everything that is not the gateway's own three paths is the box's, including `/`. The gateway owns
 * as little of the URL space as it can, because every path it claims is a path the box's UI cannot
 * use.
 */
export function routeOf(pathname: string, method: string): GatewayRoute {
  if (pathname === "/gateway/login") {
    return method === "POST" ? { kind: "login-submit" } : { kind: "login-page" };
  }
  if (pathname === "/gateway/logout") return { kind: "logout" };
  return { kind: "proxy", path: pathname };
}

/**
 * The cookie header to forward to a box.
 *
 * Two cookies must not travel: the gateway's own session, which the box has no business seeing, and
 * `agentbox_ui`, which a client could otherwise set to *another* box's UI token and have the gateway
 * forward it faithfully. The gateway's injected `Authorization` header is the only credential the box
 * should be offered.
 */
export function forwardableCookies(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const kept = [...parseCookies(header).entries()].filter(
    ([name]) => name !== SESSION_COOKIE && name !== "agentbox_ui"
  );
  if (kept.length === 0) return undefined;
  return kept.map(([name, value]) => `${name}=${value}`).join("; ");
}

export class Gateway {
  private readonly signer: SessionSigner;
  private readonly log: (line: string) => void;

  constructor(private readonly options: GatewayOptions) {
    this.signer = new SessionSigner(options.sessionSecret ?? randomBytes(32));
    this.log = options.log ?? (() => {});
  }

  /** The tenant this request belongs to, from its signed cookie. */
  tenantOf(req: IncomingMessage): string | undefined {
    const cookies = parseCookies(req.headers.cookie);
    return this.signer.verify(cookies.get(SESSION_COOKIE));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway");
    const route = routeOf(url.pathname, req.method ?? "GET");

    if (route.kind === "login-page") return this.sendLoginPage(res);
    if (route.kind === "login-submit") return this.handleLogin(req, res);
    if (route.kind === "logout") {
      res.writeHead(302, {
        location: "/gateway/login",
        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      });
      res.end();
      return;
    }

    const tenantId = this.tenantOf(req);
    if (tenantId === undefined) {
      // A page navigation gets the login form; anything else gets a status, because redirecting an
      // API call or an image to HTML produces a confusing parse error instead of a clear 401.
      if ((req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(302, { location: "/gateway/login" });
        res.end();
        return;
      }
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("Not signed in.\n");
      return;
    }

    const tenant = this.options.store.getTenant(tenantId);
    if (tenant === undefined || tenant.state !== "active") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(
        tenant === undefined
          ? "This account no longer exists.\n"
          : `This account is ${tenant.state}.\n`
      );
      return;
    }

    const box = await this.boxFor(tenantId);
    if (box === undefined) {
      // Starting, not broken. Said plainly and with a retry, because the alternative — a hung
      // request while an image pulls — looks identical to a system that is down.
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "5" });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">` +
          `<title>Starting your box</title>` +
          `<body style="font:14px system-ui;padding:3rem;max-width:34rem">` +
          `<h1>Starting your box</h1>` +
          `<p>This takes a few seconds the first time, or a few minutes if the image has to be ` +
          `downloaded. This page will retry on its own.</p></body>`
      );
      return;
    }

    this.proxy(req, res, box, url);
  }

  /**
   * The tenant's box, allocated if they have none.
   *
   * Returns undefined while a box exists but is not ready, which the caller turns into a page rather
   * than a wait. Allocation errors are logged and reported the same way: a person seeing "starting"
   * and a retry is better served than one watching a spinner.
   */
  private async boxFor(tenantId: string): Promise<BoxHandle | undefined> {
    const existing = await this.options.allocator.find(tenantId);
    if (existing !== undefined) {
      return existing.state === "ready" ? existing : undefined;
    }
    try {
      const created = await this.options.allocator.allocate(tenantId, {
        image: this.options.image,
        env: this.options.boxEnv,
      });
      return created.state === "ready" ? created : undefined;
    } catch (error) {
      this.log(
        `could not allocate a box for ${tenantId}: ` +
          (error instanceof Error ? error.message : String(error))
      );
      return undefined;
    }
  }

  private sendLoginPage(res: ServerResponse, message?: string): void {
    const body =
      `<!doctype html><meta charset="utf-8"><title>Sign in</title>` +
      `<body style="font:14px system-ui;padding:3rem;max-width:22rem">` +
      `<h1>Sign in</h1>` +
      (message === undefined
        ? ""
        : `<p style="color:#b00">${message.replace(/[<&]/g, character => (character === "<" ? "&lt;" : "&amp;"))}</p>`) +
      `<form method="post" action="/gateway/login">` +
      `<p><label>User<br><input name="username" autocomplete="username" autofocus></label></p>` +
      `<p><label>Password<br><input name="password" type="password" ` +
      `autocomplete="current-password"></label></p>` +
      `<p><button>Sign in</button></p></form></body>`;
    res.writeHead(message === undefined ? 200 : 401, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const username = form.get("username") ?? "";
    const password = form.get("password") ?? "";

    const tenantName = await this.options.identity.authenticate(username, password);
    if (tenantName === undefined) {
      // One message for both failures: which of the two was wrong is not the visitor's business.
      this.log(`failed sign-in for ${JSON.stringify(username)}`);
      this.sendLoginPage(res, "That user and password did not match.");
      return;
    }

    const tenant = this.options.store.upsertTenant({ name: tenantName });
    this.options.store.audit({
      tenantId: tenant.id,
      actor: username,
      action: "signin",
      target: tenant.name,
    });
    res.writeHead(302, {
      location: "/",
      "set-cookie":
        `${SESSION_COOKIE}=${this.signer.issue(tenant.id)}; Path=/; HttpOnly; SameSite=Lax` +
        (this.options.secureCookies === true ? "; Secure" : ""),
    });
    res.end();
  }

  /** Forwards a request to the tenant's box UI, holding the credential back. */
  private proxy(
    req: IncomingMessage,
    res: ServerResponse,
    box: BoxHandle,
    url: URL
  ): void {
    const target = new URL(box.uiUrl);
    const headers: Record<string, string | string[]> = {
      ...req.headers,
      host: target.host,
      // The box's own credential, added here and never sent to the browser.
      authorization: `Bearer ${box.tokens.ui}`,
    };
    const cookie = forwardableCookies(req.headers.cookie);
    if (cookie === undefined) delete headers.cookie;
    else headers.cookie = cookie;

    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      response => {
        // A box's own Set-Cookie would land on the gateway's origin, where it would collide with
        // the session cookie and be sent to every other tenant's box on the next request.
        const { "set-cookie": _dropped, ...rest } = response.headers;
        res.writeHead(response.statusCode ?? 502, rest);
        response.pipe(res);
      }
    );

    upstream.on("error", error => {
      this.log(`proxy to ${box.externalId} failed: ${error.message}`);
      // The store is told, so the collector and the reaper both see it — this is often the first
      // thing that notices a box has died.
      this.options.store.setBoxState(box.id, "unreachable");
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Your box is not answering. It is being restarted.\n");
      } else {
        res.end();
      }
    });

    req.pipe(upstream);
  }

  /**
   * The WebSocket upgrade that carries the desktop.
   *
   * Node will not proxy an upgrade, so the handshake is replayed verbatim and the sockets joined —
   * the same shape as the box's own desktop proxy, and for the same reason: everything after the
   * handshake is framed RFB, not HTTP.
   *
   * The session is checked here too. A browser sends cookies on an upgrade but cannot set headers,
   * which is exactly why the session is a cookie; without this check the screen would be reachable
   * without signing in.
   */
  async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const tenantId = this.tenantOf(req);
    if (tenantId === undefined) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const box = await this.options.allocator.find(tenantId);
    if (box === undefined || box.state !== "ready") {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }

    const target = new URL(box.uiUrl);
    const upstream = netConnect(Number(target.port), target.hostname, () => {
      const forwarded: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (key === "cookie" || key === "authorization" || key === "host") continue;
        forwarded[key] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      }
      forwarded.host = target.host;
      forwarded.authorization = `Bearer ${box.tokens.ui}`;
      const cookie = forwardableCookies(req.headers.cookie);
      if (cookie !== undefined) forwarded.cookie = cookie;

      const lines = Object.entries(forwarded)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      upstream.write(`GET ${req.url ?? "/"} HTTP/1.1\r\n${lines}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    const drop = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", drop);
    socket.on("error", drop);
  }
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A login form is a few hundred bytes. Anything larger is a mistake or an attempt.
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
