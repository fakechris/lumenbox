/**
 * The sidebar's first level (INV-1691, docs/95 §4): the installations this app is a client of —
 * the personal one first, then each organisation by name — with the person's role there and that
 * installation's own counts.
 *
 * Electron-free, like organisations.cjs, so it is tested without a window. Three rules live here:
 *
 * - An organisation's counts are read by the shell, from the organisation, with the token in the
 *   keychain; the personal page is handed two numbers, never the token or what they were counted
 *   from. The personal installation's counts are the personal page's own (it reads its server).
 * - The list the page gets is ids, names, roles and numbers. Nothing in it reaches another
 *   installation.
 * - An organisation's page talks to that organisation only: a request to any other origin from
 *   its view — the personal server on 127.0.0.1 included — is cancelled.
 */
const { badgeCount } = require("./attention-signals.cjs");
const { SESSION_COOKIE } = require("./organisations.cjs");

/** The personal installation's id in the list: not a connection id (those are `org-…`). */
const PERSONAL = "personal";

/** Unread (every unread message across the agents the person sees) and needs-you (what is owed by the person). */
function countsFrom(state, attention) {
  const agents = Array.isArray(state && state.agents) ? state.agents : [];
  const mine = Array.isArray(attention && attention.mine) ? attention.mine : [];
  return { unread: badgeCount(agents), needsYou: mine.length };
}

/**
 * One organisation's counts, asked of the organisation with the token it issued:
 * `GET /api/state` and `GET /api/attention`, the same two reads the page itself makes. Answers
 * `{ reachable: false }` rather than throwing: a count that cannot be read is shown as unknown,
 * never as zero.
 */
async function readCounts(origin, token, fetchImpl = fetch) {
  const headers = { cookie: `${SESSION_COOKIE}=${token}`, accept: "application/json" };
  const ask = async route => {
    const response = await fetchImpl(`${origin}${route}`, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} on ${route}`);
    return response.json();
  };
  try {
    const [state, attention] = await Promise.all([ask("/api/state"), ask("/api/attention")]);
    return { reachable: true, ...countsFrom(state, attention) };
  } catch {
    return { reachable: false };
  }
}

/**
 * The first level as the personal page draws it: personal first, organisations by name. `counts`
 * maps a connection id to what `readCounts` answered; the personal entry carries none, because the
 * page counts its own installation.
 */
function installationList(connections, counts, selected) {
  const orgs = [...connections].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const chosen = selected && orgs.some(c => c.id === selected) ? selected : PERSONAL;
  return [
    { id: PERSONAL, kind: "personal", role: "owner", selected: chosen === PERSONAL },
    ...orgs.map(c => {
      const known = counts.get(c.id);
      return {
        id: c.id, kind: "organisation", name: c.name, role: c.role, selected: chosen === c.id,
        ...(known && known.reachable ? { unread: known.unread, needsYou: known.needsYou } : { unknown: true }),
      };
    }),
  ];
}

/**
 * Whether an organisation's view may make a request: to its own origin (WebSockets included), or
 * to the page's own data and blob URLs. Anything else — another organisation, the personal server,
 * a third party — is cancelled, so the organisation's page is served by the organisation alone.
 */
function allowedRequest(url, origin) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "devtools:") return true;
  const asHttp = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
  return `${asHttp}//${parsed.host}` === origin;
}

module.exports = { PERSONAL, allowedRequest, countsFrom, installationList, readCounts };
