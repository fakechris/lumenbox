/**
 * The app's connections to organisation installations (INV-1690, docs/95 §4).
 *
 * The personal installation is a process the shell starts; an organisation is a connection: its
 * name, its address and who the person is there. That record is kept in the shell's own data
 * directory (Electron's userData), never under `~/.agentbox`, which belongs to the personal
 * installation. The session token the organisation issued is kept in the keychain
 * (keychain.cjs), filed under the connection's id, and never in the record, in page storage or
 * in a log. Leaving deletes both; the organisation's Admins revoke the session on theirs.
 *
 * Electron-free on purpose, like external-links.cjs: the shell passes in the file, the keychain
 * and `fetch`, so the whole of it is tested with doubles and a throwaway organisation server.
 */
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The cookie an organisation's sign-in sets (src/web/session.ts SESSION_COOKIE): the session token. */
const SESSION_COOKIE = "agentbox_who";

/**
 * Why a join was refused, as a code the page turns into words in the person's language
 * (`ui.organisations.why-<code>`), so the shell writes no sentence of its own.
 */
class JoinRefused extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/**
 * An organisation address as typed or pasted: `org.example.com`, `https://org.example.com/`, or
 * an invite link `https://org.example.com/login?code=4F7KQZ`. Answers the origin and the invite
 * code if there was one. HTTPS only, except on this computer's loopback (a rehearsal), because
 * the session token crosses the network on every request.
 */
function parseOrganisationAddress(input) {
  const text = String(input ?? "").trim();
  if (text === "") throw new JoinRefused("no-address");
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new JoinRefused("bad-address"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) throw new JoinRefused("not-https");
  if (url.username || url.password) throw new JoinRefused("bad-address");
  const code = url.searchParams.get("code");
  return { origin: url.origin, ...(code && /^[A-Za-z0-9]{4,16}$/.test(code) ? { code: code.toUpperCase() } : {}) };
}

/** Where the sign-in window starts: the organisation's own sign-in page, with the invite code filled in. */
function signInUrl(address) {
  return `${address.origin}/login${address.code ? `?code=${encodeURIComponent(address.code)}` : ""}`;
}

/** The session token in a cookie list (Electron's `session.cookies.get`), or undefined. */
function sessionTokenIn(cookies) {
  const found = (cookies || []).find(cookie => cookie.name === SESSION_COOKIE && cookie.value);
  return found ? found.value : undefined;
}

/**
 * Who the person is in the organisation, asked of the organisation with the token it issued:
 * `GET /api/me` and `GET /api/installation`. Refuses an address that is a personal installation
 * (docs/95 §2: it never takes a second person, so there is nothing there to join) and a token the
 * organisation does not recognise as a person.
 */
async function readOrganisation(origin, token, fetchImpl = fetch) {
  const headers = { cookie: `${SESSION_COOKIE}=${token}`, accept: "application/json" };
  const ask = async route => {
    let response;
    try { response = await fetchImpl(`${origin}${route}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new JoinRefused("unreachable"); }
    if (response.status === 401 || response.status === 403) throw new JoinRefused("not-signed-in");
    if (!response.ok) throw new JoinRefused("not-lumenbox", `HTTP ${response.status} on ${route}`);
    try { return await response.json(); } catch { throw new JoinRefused("not-lumenbox", `${route} is not JSON`); }
  };
  const installation = (await ask("/api/installation")).installation;
  if (!installation || typeof installation.mode !== "string") throw new JoinRefused("not-lumenbox", "no installation");
  if (installation.mode !== "organisation") throw new JoinRefused("personal-installation");
  const me = await ask("/api/me");
  if (typeof me.identity !== "string" || me.identity === "") throw new JoinRefused("not-signed-in");
  return { identity: me.identity, name: typeof me.name === "string" ? me.name : "", role: typeof me.role === "string" ? me.role : "viewer" };
}

/** A connection as the page sees it: no token, ever. */
function publicView(record) {
  return { id: record.id, name: record.name, origin: record.origin, identity: record.identity, person: record.person, role: record.role, joinedAt: record.joinedAt };
}

/**
 * The list of connections, in `file`, with each token in `keychain`. The file holds the records
 * only (mode 0600, written whole and renamed into place); a record with a `token` field is a bug,
 * and `list` refuses to read one back rather than carry it on.
 */
function connectionStore({ file, keychain }) {
  const read = () => {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw new Error(`organisations: ${file} cannot be read`); }
    const records = Array.isArray(parsed && parsed.connections) ? parsed.connections : [];
    if (records.some(record => record && "token" in record)) throw new Error(`organisations: ${file} holds a token; tokens live in the keychain only`);
    return records;
  };
  const write = records => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ connections: records.map(publicView) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    list: () => read().map(publicView),
    get: id => { const record = read().find(entry => entry.id === id); return record ? publicView(record) : undefined; },
    /** The token for one connection, from the keychain; for the shell's own window only. */
    token: async id => (read().some(entry => entry.id === id) ? keychain.get(id) : undefined),
    /**
     * Adds a connection, or renews the one for the same organisation and the same person. The
     * token goes into the keychain first: a record without a token would be a connection that
     * cannot open.
     */
    async add({ origin, name, identity, person, role }, token) {
      if (!token) throw new Error("organisations: no session token to keep");
      const records = read();
      const existing = records.find(entry => entry.origin === origin && entry.identity === identity);
      const id = existing ? existing.id : `org-${randomBytes(6).toString("hex")}`;
      await keychain.set(id, token);
      const record = { id, origin, name: String(name || new URL(origin).host).slice(0, 80), identity, person: String(person || "").slice(0, 80), role, joinedAt: existing ? existing.joinedAt : new Date().toISOString() };
      write([...records.filter(entry => entry.id !== id), record]);
      return publicView(record);
    },
    /** Leaves: the token out of the keychain, then the record out of the list. */
    async remove(id) {
      const records = read();
      if (!records.some(entry => entry.id === id)) return false;
      await keychain.remove(id);
      write(records.filter(entry => entry.id !== id));
      return true;
    },
  };
}

module.exports = { JoinRefused, SESSION_COOKIE, connectionStore, parseOrganisationAddress, publicView, readOrganisation, sessionTokenIn, signInUrl };
