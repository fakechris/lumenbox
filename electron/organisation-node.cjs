/**
 * Registering this machine as an organisation's node (INV-1697, docs/96 §4), and running it.
 *
 * The first run (INV-1696) calls `register({ address, name })` when the person chooses
 * "organisation node". Nobody types a code: the person signs in to the organisation as one of its
 * Admins, in the organisation's own sign-in page (Feishu or DingTalk, as joining does,
 * organisation-windows.cjs), and the session that sign-in gives is what asks the organisation to
 * enrol the node (`POST /api/nodes/enrol`). The organisation refuses anybody but an Admin and
 * answers with the node credential, once. Then:
 *
 *   - the credential goes into the keychain (keychain.cjs, its own service name), never into a file;
 *   - the Admin's session is not kept: it was the proof, held in memory for the enrolment only (the
 *     sign-in window's in-memory storage is cleared), and a node keeps no person's sign-in;
 *   - `node.json` in the shell's data directory says which organisation and which node, nothing
 *     else; there is no `~/.agentbox` and no personal installation on a node;
 *   - the node process starts (`agentbox node run`, src/box/node-cli.ts) and registers the
 *     machine's Docker box and native environment with the organisation.
 *
 * At every later start `resume()` runs the node again from the record and the keychain. When the
 * organisation revokes the node, the process stops its boxes and exits with `NODE_REVOKED_EXIT`;
 * the record then says revoked, and the node is not started again.
 *
 * Electron-free on purpose, like organisations.cjs: the shell passes in the sign-in window, the
 * keychain, the process starter and `fetch`, so the whole of it is tested with doubles and a
 * throwaway organisation server.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JoinRefused, SESSION_COOKIE, parseOrganisationAddress, readOrganisation } = require("./organisations.cjs");

/** The keychain service a node credential is filed under, one item per node id. */
const NODE_KEYCHAIN_SERVICE = "LumenBox node";
/** What `agentbox node run` exits with once the organisation revoked the node (src/box/node-cli.ts). */
const NODE_REVOKED_EXIT = 3;
/** A node's name, as the organisation checks it (src/web/node-routes.ts NODE_NAME). */
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** Why registering was refused, as a code the first-run page turns into words (`ui.machine.why-<code>`). */
class NodeRefused extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/** This machine's name, fit to be a node's: the host name, its first label, letters, digits and - only. */
function defaultNodeName(hostname = os.hostname()) {
  const cleaned = String(hostname).split(".")[0].replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return NODE_NAME.test(cleaned) ? cleaned : "node";
}

/** Asks the organisation to enrol this machine, with the session of the Admin who just signed in. */
async function enrolNode(origin, sessionToken, name, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${origin}/api/nodes/enrol`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ name }), redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new NodeRefused("unreachable");
  }
  const reply = await response.json().catch(() => ({}));
  if (response.ok && typeof reply.credential === "string" && reply.node && typeof reply.node.id === "string") return { node: reply.node, credential: reply.credential };
  if (reply.code === "role-needed" || reply.code === "node-enrol-person-needed") throw new NodeRefused("not-admin");
  if (reply.code === "nodes-personal") throw new NodeRefused("personal-installation");
  throw new NodeRefused("enrol-refused", `HTTP ${response.status} ${reply.code ?? ""}`.trim());
}

/** The record in `file`: which organisation, which node; never a credential (mode 0600, written whole). */
function nodeRecordStore(file) {
  const read = () => {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw new Error(`organisation node: ${file} cannot be read`); }
    if (!parsed || typeof parsed.nodeId !== "string" || typeof parsed.origin !== "string") throw new Error(`organisation node: ${file} names no node`);
    if ("credential" in parsed) throw new Error(`organisation node: ${file} holds a credential; it lives in the keychain only`);
    return parsed;
  };
  const write = record => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    const { origin, organisation, name, nodeId, enrolledAt, revokedAt } = record;
    fs.writeFileSync(temporary, `${JSON.stringify({ origin, organisation, name, nodeId, enrolledAt, ...(revokedAt ? { revokedAt } : {}) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return { read, write };
}

/**
 * The node for the shell. `signIn(address)` opens the organisation's sign-in page and resolves with
 * the session token once the organisation sets it, or undefined when the person closed the window.
 * `startNode({ origin, name, credential, onExit })` starts `agentbox node run`.
 */
function organisationNode({ file, keychain, signIn, startNode, fetchImpl = fetch, hostname, log = () => {} }) {
  const records = nodeRecordStore(file);
  const run = (record, credential) => {
    startNode({
      origin: record.origin,
      name: record.name,
      credential,
      onExit: code => {
        if (code !== NODE_REVOKED_EXIT) return;
        records.write({ ...record, revokedAt: new Date().toISOString() });
        log(`organisation node: ${record.name} was revoked by ${record.origin}`);
      },
    });
  };
  return {
    available: true,
    /** Signs in as an Admin, enrols this machine, keeps the credential, starts the node. */
    async register({ address, name } = {}) {
      if (records.read()) throw new NodeRefused("refused");
      const where = parseOrganisationAddress(address);
      const nodeName = typeof name === "string" && name.trim() !== "" ? name.trim() : defaultNodeName(hostname);
      if (!NODE_NAME.test(nodeName)) throw new NodeRefused("bad-name");
      const session = await signIn(where);
      if (session === undefined) throw new NodeRefused("cancelled");
      // Who signed in, asked of the organisation; the organisation checks again when it enrols.
      const who = await readOrganisation(where.origin, session, fetchImpl);
      if (who.role !== "admin") throw new NodeRefused("not-admin");
      const enrolled = await enrolNode(where.origin, session, nodeName, fetchImpl);
      await keychain.set(enrolled.node.id, enrolled.credential);
      const record = { origin: where.origin, organisation: new URL(where.origin).host, name: enrolled.node.name, nodeId: enrolled.node.id, enrolledAt: new Date().toISOString() };
      records.write(record);
      log(`organisation node: ${record.name} (${record.nodeId}) enrolled with ${record.origin} by ${who.identity}`);
      run(record, enrolled.credential);
      return { organisation: { name: record.organisation, origin: record.origin } };
    },
    /** At a later start: run the node again, unless it was revoked or its credential is gone. */
    async resume() {
      const record = records.read();
      if (!record || record.revokedAt) return { running: false, ...(record ? { revoked: true } : {}) };
      const credential = await keychain.get(record.nodeId);
      if (!credential) { log(`organisation node: no credential for ${record.nodeId} in the keychain`); return { running: false }; }
      run(record, credential);
      return { running: true };
    },
    /** What the node page shows: which organisation, which node, whether it was revoked. */
    status() {
      const record = records.read();
      return record ? { organisation: record.organisation, origin: record.origin, name: record.name, revoked: Boolean(record.revokedAt) } : undefined;
    },
  };
}

module.exports = { JoinRefused, NODE_KEYCHAIN_SERVICE, NODE_REVOKED_EXIT, NodeRefused, defaultNodeName, enrolNode, nodeRecordStore, organisationNode };
