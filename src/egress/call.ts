/**
 * Who made an outbound connection (INV-784): the agent, the turn, the tool call.
 *
 * The relay could already say which box asked for a host. It could not say which agent,
 * which turn, or which tool call, so a suspicious connection led to a box and stopped
 * there. This carries the identity the rest of the way without eBPF or a per-process
 * socket trace: the host mints one opaque token per invocation, boxd places it in the
 * process environment as `AGENTBOX_CALL` and as the credential of the per-call proxy URL,
 * the box's proxy checks the credential against the calls it was told about and forwards
 * the token to the relay in the stream preamble, and the relay decodes it onto the event.
 *
 * Why the model cannot forge it: the proxy only forwards a token boxd registered, and boxd
 * only registers what arrived on its own authenticated API. A shell that invents a token,
 * or reuses one whose call has ended, lands on `unattributed`, never on somebody else's
 * call. The token is not a secret and not signed — the trust boundary is boxd, which the
 * model cannot reach (its token is scrubbed from every shell), not the token's bytes.
 *
 * Why the credential rides in the proxy URL and not an HTTP header: curl, pip, npm, git and
 * Node honour `HTTP_PROXY` and send `Proxy-Authorization` for the credential in it without
 * being told; nothing sends a custom header from an environment variable. The relay's own
 * wire is a text preamble, so on that side the token is one more line, which a relay that
 * predates it ignores.
 */

/** What one token says. `toolUseId` for a tool call, `jobId` as well when it started a job. */
export interface CallIdentity {
  agentId: string;
  turnId: string;
  toolUseId?: string;
  jobId?: string;
}

/** The environment variable the running command finds itself under. */
export const CALL_ENV = "AGENTBOX_CALL";

/** The username in the proxy URL; the token is the password. */
export const PROXY_USER = "call";

/** A token is base64url, so it is safe in a URL, a header line and a shell. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/;

export function isCallToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function encodeCall(identity: CallIdentity): string {
  const body: CallIdentity = {
    agentId: identity.agentId,
    turnId: identity.turnId,
    ...(identity.toolUseId !== undefined ? { toolUseId: identity.toolUseId } : {}),
    ...(identity.jobId !== undefined ? { jobId: identity.jobId } : {}),
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** Undefined for anything that is not a token this minted: the relay records, it never throws. */
export function decodeCall(token: string | undefined): CallIdentity | undefined {
  if (token === undefined || !isCallToken(token)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.agentId !== "string" || typeof record.turnId !== "string") return undefined;
  return {
    agentId: record.agentId,
    turnId: record.turnId,
    ...(typeof record.toolUseId === "string" ? { toolUseId: record.toolUseId } : {}),
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
  };
}

/**
 * The environment a command runs under so its traffic carries the call: the token by name,
 * and the box's proxy as its HTTP proxy with the token as the credential. Loopback is left
 * direct — the relay is for the outside, and a proxy in front of boxd's own port would be
 * a loop.
 */
export function callEnvironment(token: string, proxyPort: number): Record<string, string> {
  const proxy = `http://${PROXY_USER}:${token}@127.0.0.1:${proxyPort}`;
  return {
    [CALL_ENV]: token,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}

/** The names `callEnvironment` sets, for whoever has to keep them from leaking into a later call. */
export const CALL_ENV_NAMES = Object.keys(callEnvironment("x", 1));

/** The token out of a `Proxy-Authorization: Basic …` value, when it is one of ours. */
export function tokenFromProxyAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(value);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const at = decoded.indexOf(":");
  if (at === -1 || decoded.slice(0, at) !== PROXY_USER) return undefined;
  const token = decoded.slice(at + 1);
  return isCallToken(token) ? token : undefined;
}

/**
 * The calls boxd currently vouches for.
 *
 * A credentialed connection is attributed only while its call is registered. The browser
 * is different: Chromium is started once with the proxy and sends no credential, so its
 * connections are attributed to the one browser action in flight — and to nothing when
 * two are, because a guess recorded as a fact is worse than an honest blank.
 */
export class CallRegistry {
  private readonly active = new Map<string, number>();
  private readonly ambientCalls: string[] = [];

  /** Vouches for a token until the returned function is called. Nested begins are counted. */
  begin(token: string): () => void {
    this.active.set(token, (this.active.get(token) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.active.get(token) ?? 1) - 1;
      if (count <= 0) this.active.delete(token);
      else this.active.set(token, count);
    };
  }

  has(token: string): boolean {
    return this.active.has(token);
  }

  /** A browser action: its connections carry no credential and are attributed by being the only one running. */
  beginAmbient(token: string): () => void {
    const release = this.begin(token);
    this.ambientCalls.push(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const at = this.ambientCalls.indexOf(token);
      if (at !== -1) this.ambientCalls.splice(at, 1);
      release();
    };
  }

  /** The call an uncredentialed connection belongs to, when that is knowable. */
  ambient(): string | undefined {
    return this.ambientCalls.length === 1 ? this.ambientCalls[0] : undefined;
  }

  /** What the proxy asks: the token to forward for a connection, or nothing. */
  resolve(credential: string | undefined): string | undefined {
    if (credential !== undefined) return this.has(credential) ? credential : undefined;
    return this.ambient();
  }
}
