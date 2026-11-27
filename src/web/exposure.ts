/**
 * Where an installation is reachable, and what that requires of it (docs/106 §5, INV-2204).
 *
 * Three levels: **local** — only this machine reaches the port, which is every personal
 * installation and the desktop app; **private** — a tailnet or a company network; **public** — the
 * Internet. The level is read once, at start, and a configuration weaker than its level requires
 * does not start: a weak deployment that starts is the failure, one that refuses and says what is
 * missing is the product.
 *
 * **Derived before declared.** A loopback bind is local. Any other bind is private, because other
 * machines can reach it, and is never local by silence. `AGENTBOX_EXPOSURE` (the environment, or
 * `env` in config.json) says otherwise: `local` on a wider bind is an operator's statement that
 * only this machine reaches the port (a container published on loopback, a port-forward), repeated
 * in the log on every start because nothing here can check it; `private` on a loopback bind is a
 * server behind a proxy on its own machine.
 *
 * What private and public require here (R1, R2; the rest of §5 is enforced where it is built):
 * - HTTPS, said by an `https://` public address — the terminator in front is the declared proxy —
 *   or, for the one hop that is not a person's, by standing behind the control plane's gateway
 *   (`AGENTBOX_TRUST_GATEWAY_IDENTITY=1`), where the gateway is the door and holds this check.
 * - `Secure` cookies and HSTS, unconditionally once the address is https. `X-Forwarded-Proto` is
 *   believed from nobody for this: a forged one could loosen nothing, and a misreported one (a
 *   second proxy in the chain) cannot lock anyone out.
 * - The installation token is a machine's credential, never a person's way in (`authorize`,
 *   auth.ts): refused in an address and as a cookie, accepted as a bearer header only from this
 *   machine itself or through the gateway.
 *
 * Shared by the installation's web server and the control plane's gateway, so the two doors a
 * person can reach are held to one rule. It reads no environment: the caller passes what it read.
 */
import type { IncomingMessage } from "node:http";
import { isLoopback } from "./auth.ts";

export type ExposureLevel = "local" | "private" | "public";

/** One year, this host only: an operator's other names are not ours to pin. */
export const HSTS = "max-age=31536000";

export interface ExposureInput {
  host: string;
  port: number;
  /** `AGENTBOX_EXPOSURE`, as written. */
  declared?: string | undefined;
  /** Where people open this server (`AGENTBOX_PUBLIC_URL`, `--public-url`). */
  publicUrl?: string | undefined;
  /** The gateway's older way of saying TLS terminates in front (`AGENTBOX_SECURE_COOKIES=1`). */
  tlsInFront?: boolean;
  /** This server is a box's, reached only through the control plane's gateway. */
  behindGateway?: boolean;
  /** `AGENTBOX_INSECURE=1`: what used to start a plain-HTTP server on a wide bind. */
  insecure?: boolean;
  /** `AGENTBOX_NO_TOKEN=1`: serve with no check at all. */
  noToken?: boolean;
}

export interface Exposure {
  level: ExposureLevel;
  /** Whether the operator said it or the bind address did. */
  source: "declared" | "derived";
  /** People reach this over HTTPS, so cookies say `Secure`. At local this is today's rule: an https public address. */
  secureCookies: boolean;
  /** Responses carry HSTS: private and public, over https. */
  hsts: boolean;
  /** The gateway stands in front; the installation token arrives from it on every request. */
  behindGateway: boolean;
  /** What to say in the log on every start. */
  notes: string[];
}

const LEVELS: readonly ExposureLevel[] = ["local", "private", "public"];

/** The level and what follows from it, or an error naming everything the level requires that is missing. */
export function resolveExposure(input: ExposureInput): Exposure {
  const declared = input.declared?.trim().toLowerCase() ?? "";
  if (declared !== "" && !LEVELS.includes(declared as ExposureLevel)) {
    throw new Error(`AGENTBOX_EXPOSURE is "${input.declared}"; it is one of local, private, public. Refusing to start on a level nobody can name.`);
  }
  const wide = !isLoopback(input.host);
  const level: ExposureLevel = declared !== "" ? (declared as ExposureLevel) : wide ? "private" : "local";
  const source = declared !== "" ? "declared" : "derived";
  const publicUrl = input.publicUrl?.trim() ?? "";
  const https = publicUrl.startsWith("https://") || input.tlsInFront === true;
  const behindGateway = input.behindGateway === true;
  const at = `${input.host}:${input.port}`;

  if (level === "local") {
    const claim =
      `exposure local, declared, on ${at}: this says only this machine reaches the port (a loopback publish, a port-forward). ` +
      "Nothing here checks that; a machine that can reach it has somebody's session over plain HTTP, and the installation token opens everything.";
    const notes = wide ? [claim] : [];
    return { level, source, secureCookies: https, hsts: false, behindGateway, notes };
  }

  const missing: string[] = [];
  if (input.noToken === true) missing.push("AGENTBOX_NO_TOKEN=1 serves everyone with no check: unset it");
  if (!https && !behindGateway) {
    const terminator = "put a TLS terminator in front (an Ingress with a certificate, Caddy, nginx, a tunnel)";
    missing.push(
      publicUrl !== ""
        ? `HTTPS: AGENTBOX_PUBLIC_URL is ${publicUrl}; ${terminator} and set it to the https:// address people open`
        : `HTTPS: ${terminator} and set AGENTBOX_PUBLIC_URL=https://… to the address people open`
    );
    if (input.insecure === true) missing.push("AGENTBOX_INSECURE=1 no longer starts a server other machines can reach");
  }
  if (missing.length > 0) {
    const why = source === "declared"
      ? `AGENTBOX_EXPOSURE=${level}`
      : `it binds ${input.host}, which other machines can reach, so its exposure level is private`;
    throw new Error(
      `Refusing to serve ${at} without TLS: ${why}, and that level requires what is missing here — ${missing.join("; ")}. ` +
        "If only this machine can reach the port (a container published on loopback, a port-forward), say so with AGENTBOX_EXPOSURE=local."
    );
  }

  const where = `exposure ${level} (${source}) on ${at}`;
  const notes = [
    behindGateway
      ? `${where}, behind the control plane's gateway: the gateway signs people in, and the installation token is accepted only as a bearer header.`
      : `${where}: cookies are Secure, responses carry HSTS, and people sign in as themselves. ` +
        "The installation token is not a way in: it is accepted only as a bearer header from this machine itself.",
  ];
  if (level === "public") {
    notes.push("exposure public: this version enforces HTTPS, Secure cookies and the token rule. The rest of what public requires (docs/106 §5, R4–R10) is not enforced yet.");
  }
  return { level, source, secureCookies: https, hsts: https, behindGateway, notes };
}

const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "via"];

/**
 * Whether a request came from this machine itself, with no proxy in between: a loopback peer and
 * none of the headers a proxy adds. That is the CLI, the watchdog's installer, a script in the pod
 * — a machine caller. A proxy on the same machine also connects from loopback, which is why the
 * headers count: the terminator in front has to set `X-Forwarded-For` (ingress-nginx, Caddy,
 * Traefik and the tunnels do), and one that sets none makes its visitors look local.
 */
export function isDirectLocal(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } }): boolean {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (peer !== "127.0.0.1" && peer !== "::1") return false;
  return FORWARDING_HEADERS.every(name => req.headers[name] === undefined);
}
