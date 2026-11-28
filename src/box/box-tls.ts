/**
 * How the host knows the box it is talking to is that box (docs/106 §5 R7, INV-2204).
 *
 * The box daemon speaks plain HTTP. Where the host reaches it over HTTP — its own Docker box on
 * loopback, a tenant's pod on a ClusterIP, an attached box over a tailnet or an SSH forward — the
 * network is what identifies the box (loopback; the NetworkPolicy that admits only the control
 * plane; WireGuard's peer keys; SSH's host key), and the box token on top proves the host to the
 * box. Adding TLS there would add a certificate nobody checks.
 *
 * Where an attached box is reached over HTTPS — somebody put a terminator in front of it — the
 * certificate is checked, in one place, for every connection: the box client's calls, the desktop
 * page and the desktop's socket.
 *
 * - A certificate a public authority vouches for, for the name in the address, is verified: it
 *   renews without anybody being asked (a tailnet's `*.ts.net` certificate, a company's own CA in
 *   the system store).
 * - Any other — self-signed, the usual case for a terminator on a machine of one's own — is
 *   pinned the first time it is seen: the SHA-256 of its public key goes into `box-pins.json` in
 *   the installation's home, keyed by the box's address, and the log says so. Every later
 *   connection must present the same key, or it is refused with a sentence that says what to do.
 *
 * Before this the desktop proxy accepted any certificate at all, while the box client accepted
 * only publicly-vouched ones — so a self-signed box could not be attached, and the screen of a
 * box that could was taken from whoever answered.
 */
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, join } from "node:path";
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from "node:tls";
import { agentboxHome } from "../config.ts";

export const BOX_PINS_FILENAME = "box-pins.json";

interface Pin { key: string; pinnedAt: string }

/** The address a pin belongs to: scheme, host and port. */
export function originKey(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

/** `sha256/<base64>` of a certificate's public key: what survives a renewal that keeps the key. */
export function keyFingerprint(cert: PeerCertificate | X509Certificate): string {
  // Always the SubjectPublicKeyInfo, read from the certificate itself: one encoding whichever object Node handed over.
  const x509 = "raw" in cert && Buffer.isBuffer((cert as PeerCertificate).raw) ? new X509Certificate((cert as PeerCertificate).raw) : (cert as X509Certificate);
  return `sha256/${createHash("sha256").update(x509.publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;
}

/** A box whose certificate is not the one pinned for its address. */
export class BoxCertificateRefused extends Error {
  readonly code = "box-certificate-changed";
}

/** The pins, read and written whole. In the installation's home, beside the box tokens. */
export class BoxPins {
  constructor(private readonly path: string = join(agentboxHome(), BOX_PINS_FILENAME), private readonly log: (line: string) => void = line => console.error(`[box] ${line}`)) {}

  private read(): Record<string, Pin> {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Pin>; }
    catch { throw new BoxCertificateRefused(`${this.path} is not valid JSON. Not connecting to a box over HTTPS until it is repaired or removed: it is what says which certificate each box has.`); }
  }

  private write(pins: Record<string, Pin>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  get(origin: string): Pin | undefined { return this.read()[origin]; }

  /** Forgets the pin for an address: `box attach --replace` does, because the box there is being replaced on purpose. */
  forget(baseUrl: string): boolean {
    const pins = this.read(), key = originKey(baseUrl);
    if (pins[key] === undefined) return false;
    delete pins[key];
    this.write(pins);
    return true;
  }

  /**
   * Whether the box at `baseUrl` may be talked to over this connection: yes when an authority
   * vouched for the certificate; otherwise the key must be the pinned one, and the first key seen
   * for an address is pinned. Throws `BoxCertificateRefused` with the sentence a person reads.
   */
  check(baseUrl: string, socket: Pick<TLSSocket, "authorized" | "getPeerCertificate">, label?: string): "verified" | "pinned" | "matched" {
    if (socket.authorized) return "verified";
    const presented = keyFingerprint(socket.getPeerCertificate());
    const origin = originKey(baseUrl), pins = this.read(), pinned = pins[origin];
    if (pinned === undefined) {
      pins[origin] = { key: presented, pinnedAt: new Date().toISOString() };
      this.write(pins);
      this.log(`${label ?? origin}: its certificate is not one an authority vouches for; pinned its key ${presented} on first use. A different key at ${origin} will be refused.`);
      return "pinned";
    }
    if (pinned.key === presented) return "matched";
    throw new BoxCertificateRefused(
      `${label ?? `The box at ${origin}`} presented a different certificate (key ${presented}; the one pinned on ${pinned.pinnedAt.slice(0, 10)} is ${pinned.key}). ` +
        "Not connecting: something other than that box may be answering at its address. If its certificate was replaced on purpose, re-attach it: " +
        `agentbox box attach ${label ?? "<name>"} ${baseUrl} --token-file <file> --replace`
    );
  }
}

let shared: BoxPins | undefined;
/** The installation's pins. One per process, so a test's temporary home is read when the first box connects. */
export function boxPins(): BoxPins { shared ??= new BoxPins(); return shared; }
/** For a test that changes homes inside one process. */
export function resetBoxPins(): void { shared = undefined; }

/**
 * A TLS connection to a box, refused unless `check` says yes. Node is told not to reject the
 * certificate itself only so that a self-signed one can be pinned; the decision is `check`'s, on
 * every connection, and nothing is written until it is made: `onReady` is the only place a caller
 * may start writing, and it is not called for a refused box.
 */
export function connectToBox(baseUrl: string, options: ConnectionOptions, onReady?: () => void, label?: string, pins: BoxPins = boxPins(), onRefused?: (error: Error) => void): TLSSocket {
  const url = new URL(baseUrl);
  const socket = tlsConnect({ ...options, host: options.host ?? url.hostname, port: options.port ?? Number(url.port || 443), servername: url.hostname, rejectUnauthorized: false });
  socket.once("secureConnect", () => {
    try { pins.check(baseUrl, socket, label); }
    catch (error) { onRefused?.(error as Error); socket.destroy(error as Error); return; }
    onReady?.();
  });
  return socket;
}

/**
 * Options for `https.request` to a box. The socket is handed to the request only once its
 * certificate has been checked (`createConnection`'s asynchronous form), so the request — and the
 * box token in its header — is never written to a connection that is then refused.
 */
export function boxRequestOptions(baseUrl: string, label?: string): Pick<RequestOptions, "createConnection"> {
  const create = (options: ConnectionOptions, ready: (error: Error | null, socket?: TLSSocket) => void): undefined => {
    let settled = false;
    const done = (error: Error | null, socket?: TLSSocket) => { if (settled) return; settled = true; ready(error, socket); };
    const socket = connectToBox(baseUrl, options, () => done(null, socket), label, boxPins(), error => done(error));
    socket.once("error", error => done(error));
    return undefined;
  };
  // No `agent`: given one (even `false`), Node opens its own connection and never asks this one.
  return { createConnection: create as unknown as RequestOptions["createConnection"] };
}

/**
 * `fetch` for a box: the global one over HTTP, and over HTTPS a request whose certificate is
 * checked by `connectToBox`. Takes what the box client sends — a method, headers, a string body,
 * a signal — and gives back a `Response`.
 */
export async function boxFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}, label?: string): Promise<Response> {
  if (!url.startsWith("https:")) return fetch(url, init);
  const target = new URL(url);
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({
      method: init.method ?? "GET", hostname: target.hostname, port: target.port || 443, path: `${target.pathname}${target.search}`,
      headers: { ...(init.headers ?? {}), ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}) },
      ...boxRequestOptions(url, label),
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers }));
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (init.signal !== undefined) {
      if (init.signal.aborted) { request.destroy(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
      init.signal.addEventListener("abort", () => { request.destroy(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    }
    request.end(init.body);
  });
}
