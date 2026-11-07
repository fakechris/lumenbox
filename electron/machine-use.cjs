/**
 * What this machine is for (INV-1696, docs/96 §3): a personal machine (个人的机器), personal +
 * organisation (个人 + 组织), or an organisation node (组织的节点). The one place the three uses,
 * the first-run decision and the allowed changes are defined.
 *
 * The answer is the machine's, not an installation's: it is kept in the shell's own data
 * directory (Electron's userData, `machine.json`), never under `~/.agentbox`, because an
 * organisation node has no personal installation and so no `~/.agentbox` to keep it in.
 *
 * - A first run with nothing recorded and no personal installation asks (the wizard).
 * - An upgrade — no record, but a personal installation already in AGENTBOX_HOME — never asks:
 *   it is recorded as a personal machine, or personal + organisation when the app already holds
 *   an organisation connection (INV-1690).
 * - Personal machine ↔ personal + organisation is adding or removing a connection, and allowed.
 *   A personal installation and an organisation node never turn into each other (docs/96 §3,
 *   docs/95 §0): what was put on the machine for one person must not change owners by a setting.
 *
 * Electron-free on purpose, like organisations.cjs: the shell passes in the paths, so the whole
 * of it is tested with temporary directories.
 */
const fs = require("node:fs");
const path = require("node:path");

const PERSONAL = "personal";
const PERSONAL_ORGANISATION = "personal-organisation";
const ORGANISATION_NODE = "organisation-node";
const USES = [PERSONAL, PERSONAL_ORGANISATION, ORGANISATION_NODE];
/** How the use was set: asked on the first run, read off an upgraded machine, or changed in Settings. */
const HOWS = ["first-run", "upgrade", "settings"];

/** Whether a use runs the personal installation on this machine (`agentbox web --desktop`). */
function runsPersonalInstallation(use) {
  return use === PERSONAL || use === PERSONAL_ORGANISATION;
}

/** A refused change or choice, as a code the page turns into words (`ui.machine.why-<code>`). */
class MachineUseRefused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Whether AGENTBOX_HOME already holds a personal installation: the roster the desktop's first
 * start writes (principals.json, with the Owner) or the settings it saves (config.json). Either
 * means somebody has used LumenBox on this machine as a personal installation.
 */
function personalInstallationExists(agentboxHome) {
  return ["principals.json", "config.json"].some(name => fs.existsSync(path.join(agentboxHome, name)));
}

/** The record in `file` (mode 0600, written whole and renamed into place). */
function machineUseStore({ file, now = () => new Date() }) {
  const read = () => {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw new Error(`machine use: ${file} cannot be read`); }
    if (!parsed || !USES.includes(parsed.use)) throw new Error(`machine use: ${file} names no use this version knows`);
    return { use: parsed.use, how: HOWS.includes(parsed.how) ? parsed.how : "first-run", at: String(parsed.at || "") };
  };
  const write = (use, how) => {
    if (!USES.includes(use)) throw new Error(`machine use: ${use} is not a use`);
    if (!HOWS.includes(how)) throw new Error(`machine use: ${how} is not how a use is set`);
    const record = { use, how, at: now().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return record;
  };
  return { read, write };
}

/**
 * What the shell does at start: `{ wizard: true }` on a true first run, otherwise the use, with
 * an upgrade recorded on the way (and never asked).
 */
function startupUse({ store, agentboxHome, connections }) {
  const recorded = store.read();
  if (recorded) return { use: recorded.use, record: recorded };
  if (!personalInstallationExists(agentboxHome)) return { wizard: true };
  const record = store.write(connections > 0 ? PERSONAL_ORGANISATION : PERSONAL, "upgrade");
  return { use: record.use, record };
}

/** Whether the use may change from `from` to `to` in Settings; throws `reinstall` when it may not. */
function checkChange(from, to) {
  if (!USES.includes(to)) throw new MachineUseRefused("unknown");
  if (from === to) return;
  if (runsPersonalInstallation(from) && runsPersonalInstallation(to)) return;
  throw new MachineUseRefused("reinstall");
}

/**
 * The use after the connections changed: joining an organisation from a personal machine makes it
 * personal + organisation, and leaving the last one makes it a personal machine again.
 */
function useAfterConnections(use, connections) {
  if (use === PERSONAL && connections > 0) return PERSONAL_ORGANISATION;
  if (use === PERSONAL_ORGANISATION && connections === 0) return PERSONAL;
  return use;
}

/**
 * The calls the shell answers through the preload bridge (`lumenboxShell.machine`): `get` and
 * `change` for Settings → This machine, `choose` for the first-run page. `organisations` is the
 * connection store's count and a way to disconnect one (organisation-windows.cjs); `node` is
 * organisation-node.cjs; `started(use)` is the shell starting what the chosen use runs.
 */
function machineUseCalls({ store, organisations, node, started, log = () => {} }) {
  let joinNext = false;
  const current = () => {
    const record = store.read();
    if (!record) throw new MachineUseRefused("unknown");
    return record;
  };
  return {
    get() {
      const record = current();
      const answer = { use: record.use, how: record.how, at: record.at, connections: organisations.count(), joinNext };
      joinNext = false; // once: the page opens Settings → Organisations after a first run that chose personal + organisation
      return answer;
    },
    /** The first run's answer. Refused once a use is recorded: the first run happens once. */
    async choose(use) {
      if (store.read()) throw new MachineUseRefused("refused");
      if (!USES.includes(use)) throw new MachineUseRefused("unknown");
      if (use === ORGANISATION_NODE) {
        // Nothing is recorded until the organisation has registered the node (INV-1697).
        if (!node.available) return { step: "node" };
        const registered = await node.register({});
        store.write(ORGANISATION_NODE, "first-run");
        started(ORGANISATION_NODE);
        return { use, organisation: registered.organisation };
      }
      store.write(use, "first-run");
      joinNext = use === PERSONAL_ORGANISATION;
      log(`machine use: ${use} (first run)`);
      started(use);
      return { use };
    },
    /** A change in Settings: personal ↔ personal + organisation only; back to personal disconnects every organisation. */
    async change(to) {
      const from = current().use;
      checkChange(from, to);
      if (from === to) return { use: to };
      if (to === PERSONAL) for (const id of organisations.ids()) await organisations.disconnect(id);
      store.write(to, "settings");
      log(`machine use: ${from} -> ${to} (settings)`);
      return { use: to };
    },
    /** After a join or a disconnect in Settings → Organisations: keep the use in step with the connections. */
    connectionsChanged() {
      const record = store.read();
      if (!record) return;
      const next = useAfterConnections(record.use, organisations.count());
      if (next !== record.use) { store.write(next, "settings"); log(`machine use: ${record.use} -> ${next} (connections)`); }
    },
  };
}

module.exports = { MachineUseRefused, HOWS, machineUseCalls, ORGANISATION_NODE, PERSONAL, PERSONAL_ORGANISATION, USES, checkChange, machineUseStore, personalInstallationExists, runsPersonalInstallation, startupUse, useAfterConnections };
