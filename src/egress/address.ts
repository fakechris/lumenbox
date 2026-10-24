/**
 * What an IP address *is*, shared by the host's own fetches (src/host/web.ts) and the egress
 * relay (relay.ts, INV-1343). One classification, two policies on top of it: the host's web
 * reader refuses everything inside, the relay refuses only what INV-1224 names (cloud metadata
 * and the host itself) because a box reaching the user's LAN is the relay's reason to exist.
 */

export type AddressClass =
  | "loopback"
  | "unspecified"
  | "private"
  | "link-local"
  | "carrier"
  | "multicast"
  | "malformed"
  | "public";

/** The address without an IPv4-mapped prefix, so `::ffff:127.0.0.1` reads as loopback. */
export function plainAddress(ip: string): string {
  const lower = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return lower.startsWith("::ffff:") ? lower.slice(7) : lower;
}

export function classifyAddress(ip: string): AddressClass {
  const plain = plainAddress(ip);
  if (plain.includes(".")) {
    const parts = plain.split(".").map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return "malformed";
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return "loopback";
    if (a === 0) return "unspecified";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 169 && b === 254) return "link-local";
    if (a === 100 && b >= 64 && b <= 127) return "carrier";
    // 198.18/15 is left public on purpose: transparent proxies (Clash, Surge, WARP) hand it
    // back for *public* names, and it fronts no private network and no metadata service.
    if (a >= 224) return "multicast";
    return "public";
  }
  if (plain === "::1") return "loopback";
  if (plain === "::") return "unspecified";
  const head = Number.parseInt(plain.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((head & 0xff00) === 0xff00) return "multicast";
  return "public";
}

/**
 * Whether an IP is one the host's web reader must not reach, and why.
 *
 * Deny-listed rather than allow-listed because the public internet is not enumerable.
 * The list is the addresses that mean "somewhere inside", in both families.
 */
export function forbiddenAddress(ip: string): string | undefined {
  switch (classifyAddress(ip)) {
    case "malformed":
      return "is not an address this understands";
    case "loopback":
      return "is this machine";
    case "private":
      return "is a private network";
    // Where cloud instances keep their credentials. The single most valuable address an
    // injected instruction can name, and the reason this check exists at all.
    case "link-local":
      return plainAddress(ip).includes(".") ? "is link-local, where cloud instances keep their credentials" : "is link-local";
    case "unspecified":
      return "is unspecified";
    case "carrier":
      return "is carrier-internal";
    case "multicast":
      return plainAddress(ip).includes(".") ? "is multicast or reserved" : "is multicast";
    default:
      return undefined;
  }
}
