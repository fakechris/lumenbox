/**
 * The tailmsg v1 envelope (Yobiru SPEC §3), read strictly (INV-1288, docs/81's sibling door).
 *
 * The field set is closed: an unknown field is a 400, so no two ends drift into private
 * dialects. Names are checked the way the spec says — id `[A-Za-z0-9_-]{8,64}`, ts in UTC to
 * the second, agent names 1–64 characters with no `/`, no control characters, no leading or
 * trailing space, NFC-normalised — and a fetch entry's url must point at the sender itself:
 * a letter that says "fetch this from somewhere else" is refused whole, so a peer cannot use
 * this host to reach a third address.
 */

export interface TailmsgFetch {
  name?: string;
  url: string;
  sha256: string;
  size: number;
  mime?: string;
  expires?: string;
}

export type TailmsgWake = "now" | "batch" | "none";

export interface TailmsgEnvelope {
  v: 1;
  id: string;
  from: string;
  to: string;
  ts: string;
  kind: string;
  text?: string;
  reply_to?: string;
  wake: TailmsgWake;
  agent?: string;
  from_agent?: string;
  fetch?: TailmsgFetch[];
}

export const ENVELOPE_MAX_BYTES = 256 * 1024;
const KNOWN = new Set(["v", "id", "from", "to", "ts", "kind", "text", "reply_to", "wake", "agent", "from_agent", "fetch", "request", "response"]);
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SHA = /^[0-9a-f]{64}$/;

/** A tailnet name without its trailing dot, lower-cased: how two names are compared. */
export function canonicalHost(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** Whether `named` (full or short) is `fqdn`: `dev-server` is `dev-server.example.ts.net`. */
export function sameHost(named: string, fqdn: string): boolean {
  const a = canonicalHost(named);
  const b = canonicalHost(fqdn);
  return a === b || b.startsWith(`${a}.`);
}

export function validAgentName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (name !== name.trim()) return false;
  if (name.includes("/")) return false;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** The envelope, or the one line a 400 carries. `self` is this host's tailnet name, for `to`. */
export function parseEnvelope(raw: unknown, self: string): { envelope: TailmsgEnvelope } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "the body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter(key => !KNOWN.has(key));
  if (unknown.length > 0) return { error: `unknown field(s): ${unknown.join(", ")}` };
  if (body.request !== undefined || body.response !== undefined) return { error: "request-lifecycle-v1 is not negotiated with this receiver" };
  if (body.v !== 1) return { error: "v must be 1" };
  const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  const id = str("id");
  if (id === undefined || !ID.test(id)) return { error: "id must match [A-Za-z0-9_-]{8,64}" };
  const from = str("from");
  if (from === undefined || from.trim() === "") return { error: "from is required" };
  const to = str("to");
  if (to === undefined || to.trim() === "") return { error: "to is required" };
  if (!sameHost(to, self)) return { error: `to is not this host (${canonicalHost(self)})` };
  const ts = str("ts");
  if (ts === undefined || !TS.test(ts)) return { error: "ts must be UTC like 2026-10-08T14:00:00Z" };
  const kind = body.kind === undefined ? "text" : str("kind");
  if (kind === undefined || kind.length > 32 || kind === "") return { error: "kind must be a short string (at most 32 characters)" };
  if (body.text !== undefined && typeof body.text !== "string") return { error: "text must be a string" };
  if (body.reply_to !== undefined && (typeof body.reply_to !== "string" || !ID.test(body.reply_to))) return { error: "reply_to must be a message id" };
  const wake = body.wake === undefined ? "batch" : body.wake;
  if (wake !== "now" && wake !== "batch" && wake !== "none") return { error: "wake must be now, batch or none" };
  for (const key of ["agent", "from_agent"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string" || !validAgentName((body[key] as string).normalize("NFC"))) return { error: `${key} is not a valid agent name` };
  }
  let fetch: TailmsgFetch[] | undefined;
  if (body.fetch !== undefined) {
    if (!Array.isArray(body.fetch)) return { error: "fetch must be an array" };
    fetch = [];
    for (const [i, entry] of body.fetch.entries()) {
      const record = (entry !== null && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      if (typeof record.url !== "string" || typeof record.sha256 !== "string" || typeof record.size !== "number") return { error: `fetch[${i}] needs url, sha256 and size` };
      if (!SHA.test(record.sha256)) return { error: `fetch[${i}].sha256 must be 64 lowercase hex characters` };
      if (!Number.isInteger(record.size) || record.size < 0) return { error: `fetch[${i}].size must be a non-negative integer` };
      let host: string;
      try {
        const url = new URL(record.url);
        if (url.protocol !== "http:") return { error: `fetch[${i}].url must be http:// on the sender's tailmsg port` };
        host = url.hostname;
      } catch {
        return { error: `fetch[${i}].url is not a URL` };
      }
      if (!sameHost(host, from) && !sameHost(from, host)) return { error: `fetch[${i}].url is not on the sender (${canonicalHost(from)}): refused whole` };
      fetch.push({
        url: record.url,
        sha256: record.sha256,
        size: record.size,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.mime === "string" ? { mime: record.mime } : {}),
        ...(typeof record.expires === "string" ? { expires: record.expires } : {}),
      });
    }
  }
  return {
    envelope: {
      v: 1,
      id,
      from: from.trim(),
      to: to.trim(),
      ts,
      kind,
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.reply_to === "string" ? { reply_to: body.reply_to } : {}),
      wake,
      ...(typeof body.agent === "string" ? { agent: (body.agent as string).normalize("NFC") } : {}),
      ...(typeof body.from_agent === "string" ? { from_agent: (body.from_agent as string).normalize("NFC") } : {}),
      ...(fetch !== undefined ? { fetch } : {}),
    },
  };
}

/** Whether an address is a tailnet address: CGNAT 100.64.0.0/10 or the ULA block fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4 !== null) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(ip);
}

/** A safe file name for a fetched attachment: the sender's name, reduced to what a path may hold. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const base = (name ?? fallback).split(/[\\/]/).pop() ?? fallback;
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned === "" ? fallback : cleaned;
}
