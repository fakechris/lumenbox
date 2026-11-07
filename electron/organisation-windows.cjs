/**
 * The Electron half of organisation connections (INV-1690): the sign-in window, and the calls the
 * personal page makes through the preload bridge. An organisation opens inside the main window
 * (installation-views.cjs, INV-1691).
 *
 * The sign-in window, like an organisation's view, runs in its own in-memory session partition (no `persist:` prefix),
 * so the organisation's cookies, cache and storage live only while the window does and nothing of
 * the organisation is written to this computer's disk. The one thing kept is the session token,
 * read from the sign-in window's cookie jar once the organisation sets it and handed to the
 * connection store, which files it in the keychain.
 */
const { BrowserWindow, ipcMain, session: electronSession } = require("electron");
const { randomBytes } = require("node:crypto");
const { windowOpenAction } = require("./external-links.cjs");
const { JoinRefused, SESSION_COOKIE, parseOrganisationAddress, readOrganisation, sessionTokenIn, signInUrl } = require("./organisations.cjs");

/** A fresh in-memory session: an organisation's browsing state never touches the disk. */
function ephemeralSession() {
  return electronSession.fromPartition(`org-${randomBytes(8).toString("hex")}`, { cache: false });
}

/**
 * The organisation's sign-in page in a window of the app, in a fresh in-memory session, until the
 * organisation sets the session cookie. Resolves with the session token, or undefined when the
 * person closes the window first. Joining (below) and enrolling a node (organisation-node.cjs,
 * INV-1697) both sign in this way; the window's storage is cleared either way.
 */
async function signInWindow(address, { parent, openOutside, show = true }) {
  const ses = ephemeralSession();
  const win = new BrowserWindow({ width: 520, height: 680, ...(parent ? { parent } : {}), modal: false, show, title: address.origin, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.setMenuBarVisibility(false);
  // A vendor's authorize page may open a window; the person's own browser takes it, not a bare child.
  win.webContents.setWindowOpenHandler(({ url }) => windowOpenAction(url, address.origin, openOutside));
  const token = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; ses.cookies.removeListener("changed", onCookie); resolve(value); };
    const onCookie = (_event, cookie, _cause, removed) => {
      if (removed || cookie.name !== SESSION_COOKIE || !cookie.value) return;
      ses.cookies.get({ url: address.origin, name: SESSION_COOKIE }).then(found => { const value = sessionTokenIn(found); if (value) finish(value); }).catch(() => {});
    };
    ses.cookies.on("changed", onCookie);
    win.on("closed", () => finish(undefined));
    win.loadURL(signInUrl(address)).catch(error => { if (!settled) { settled = true; reject(new JoinRefused("unreachable", error.message)); } });
  });
  if (!win.isDestroyed()) win.destroy();
  await ses.clearStorageData().catch(() => {});
  return token;
}

function organisationWindows({ store, views, personalOrigin, parentWindow, openOutside, log, show = true, onConnectionsChanged = () => {} }) {

  /**
   * Signs in to an organisation in a window of the app: its own sign-in page (an invite code, or
   * the Feishu / DingTalk sign-in it offers), until it sets the session cookie. Resolves with the
   * new connection, or `{ cancelled: true }` when the person closes the window first.
   */
  async function join(addressInput, name) {
    const address = parseOrganisationAddress(addressInput);
    if (address.origin === personalOrigin) throw new JoinRefused("personal-installation");
    const token = await signInWindow(address, { parent: parentWindow(), openOutside, show });
    if (token === undefined) return { cancelled: true };
    const who = await readOrganisation(address.origin, token);
    const record = await store.add({ origin: address.origin, name: typeof name === "string" && name.trim() ? name.trim() : new URL(address.origin).host, identity: who.identity, person: who.name, role: who.role }, token);
    log(`organisations: joined ${record.origin} as ${record.role} (${record.id})`);
    views.refreshCounts().catch(() => {});
    return { connection: record };
  }

  /**
   * Opens an organisation: since INV-1691 that is selecting it in the main window's first level
   * (installation-views.cjs), not a window of its own.
   */
  async function openConnection(id) {
    await views.select(id);
    return { opened: true };
  }

  /** Leaves an organisation on this computer: its window closed, its token and record deleted. */
  async function disconnect(id) {
    views.close(id);
    const removed = await store.remove(id);
    if (removed) log(`organisations: left ${id}`);
    return { removed };
  }

  /**
   * The bridge's calls — four for connections, two for the first level (INV-1691) — answered only for the personal page in the main window: an
   * organisation's page, or anything a link navigated the main window to, gets nothing.
   */
  function handle(sender) {
    const fromPersonalPage = event => {
      const url = event.senderFrame?.url ?? event.sender.getURL();
      let origin = "";
      try { origin = new URL(url).origin; } catch {}
      return event.sender === sender() && origin === personalOrigin;
    };
    const reply = fn => async (event, ...args) => {
      if (!fromPersonalPage(event)) return { error: "refused" };
      try { return await fn(...args); }
      catch (error) {
        if (error instanceof JoinRefused) return { error: error.code };
        log(`organisations: ${error.message}`);
        return { error: "failed" };
      }
    };
    ipcMain.handle("organisations:list", reply(async () => ({ connections: store.list() })));
    // A join or a disconnect moves this machine between personal and personal + organisation (INV-1696).
    const thenChanged = fn => async (...args) => { const answer = await fn(...args); onConnectionsChanged(); return answer; };
    ipcMain.handle("organisations:join", reply(thenChanged((address, name) => join(address, name))));
    ipcMain.handle("organisations:open", reply(id => openConnection(String(id))));
    ipcMain.handle("organisations:disconnect", reply(thenChanged(id => disconnect(String(id)))));
    ipcMain.handle("installations:list", reply(async () => views.list()));
    ipcMain.handle("installations:select", reply((id, rail) => views.select(String(id), Number(rail))));
  }

  return { join, openConnection, disconnect, handle };
}

module.exports = { organisationWindows, signInWindow };
