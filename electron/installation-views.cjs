/**
 * Switching installations inside the main window (INV-1691, docs/95 §4: "both at once, in one
 * window").
 *
 * The personal page owns the window and draws the first level: a column at its left edge. An
 * organisation, once selected, is shown in a view laid over everything to the right of that column:
 * a WebContentsView of its own, in its own in-memory session (nothing of it reaches the disk), with
 * the session cookie from the keychain set in that session only, no preload (the organisation's
 * page gets no bridge to the shell), and every request to an origin other than the organisation's
 * cancelled. So the organisation's sidebar, boxes, agents, Tasks and Settings are the organisation's
 * own page, served by its server; the personal page underneath never receives a byte of it.
 * Selecting the personal installation hides the views; a view stays loaded while the window does,
 * so switching back is instant.
 *
 * The counts beside each organisation are read here, by the shell, with the token
 * (installations.cjs readCounts) and handed to the personal page as numbers.
 */
const { WebContentsView, session: electronSession } = require("electron");
const { randomBytes } = require("node:crypto");
const { windowOpenAction } = require("./external-links.cjs");
const { JoinRefused, SESSION_COOKIE } = require("./organisations.cjs");
const { PERSONAL, allowedRequest, installationList, readCounts } = require("./installations.cjs");

/** How often an organisation's counts are read while the app runs. */
const COUNT_EVERY_MS = 20_000;

function installationViews({ store, mainWindow, openOutside, log }) {
  /** connection id → { view, origin } for the window they were made in. */
  const views = new Map();
  const counts = new Map();
  let attachedTo = null;
  let selected = PERSONAL;
  /** The width of the page's first-level column, in CSS pixels, as the page measured it. */
  let railWidth = 0;

  function dropAll() {
    for (const { view } of views.values()) { try { view.webContents.close(); } catch {} }
    views.clear();
    selected = PERSONAL;
    attachedTo = null;
  }

  /** The window the views live in; a new main window (closed and reopened) starts with none. */
  function windowNow() {
    const win = mainWindow();
    if (!win || win.isDestroyed()) { if (attachedTo) dropAll(); return null; }
    if (win !== attachedTo) {
      if (attachedTo) dropAll();
      attachedTo = win;
      win.on("resize", layout);
      win.on("closed", () => { if (attachedTo === win) dropAll(); });
      win.webContents.on("zoom-changed", () => setImmediate(layout));
    }
    return win;
  }

  function layout() {
    const win = attachedTo;
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const x = Math.min(Math.round(railWidth * win.webContents.getZoomFactor()), width);
    for (const [id, entry] of views) {
      entry.view.setBounds({ x, y: 0, width: Math.max(0, width - x), height });
      entry.view.setVisible(id === selected);
    }
  }

  async function viewFor(win, record) {
    const existing = views.get(record.id);
    if (existing) return existing;
    const token = await store.token(record.id);
    if (!token) throw new JoinRefused("no-token");
    const ses = electronSession.fromPartition(`org-${randomBytes(8).toString("hex")}`, { cache: false });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = allowedRequest(details.url, record.origin);
      if (!ok) log(`installations: ${record.id} asked for another origin; cancelled`);
      callback({ cancel: !ok });
    });
    await ses.cookies.set({ url: record.origin, name: SESSION_COOKIE, value: token, path: "/", httpOnly: true, secure: record.origin.startsWith("https:"), sameSite: "lax" });
    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.webContents.setWindowOpenHandler(({ url }) => windowOpenAction(url, record.origin, openOutside));
    view.webContents.on("will-navigate", (event, url) => { if (windowOpenAction(url, record.origin, openOutside).action === "deny") event.preventDefault(); });
    view.webContents.on("destroyed", () => { ses.clearStorageData().catch(() => {}); });
    view.setVisible(false);
    win.contentView.addChildView(view);
    const entry = { view, origin: record.origin };
    views.set(record.id, entry);
    view.webContents.loadURL(`${record.origin}/`).catch(error => log(`installations: ${record.id} did not load: ${error.message}`));
    return entry;
  }

  /**
   * Shows one installation: `personal`, or a connection id. `rail` is the page's first-level
   * column width; the organisation's view covers the rest of the window.
   */
  async function select(id, rail) {
    const win = windowNow();
    if (!win) return { error: "failed" };
    if (Number.isFinite(rail)) railWidth = Math.max(0, Math.min(240, Number(rail)));
    if (id === PERSONAL) { selected = PERSONAL; layout(); win.webContents.focus(); return { selected }; }
    const record = store.get(String(id));
    if (!record) throw new JoinRefused("no-token");
    const entry = await viewFor(win, record);
    selected = record.id;
    layout();
    entry.view.webContents.focus();
    return { selected };
  }

  /** Forgets one organisation's view and counts (on disconnect). */
  function close(id) {
    const entry = views.get(id);
    if (entry) {
      try { attachedTo?.contentView.removeChildView(entry.view); } catch {}
      try { entry.view.webContents.close(); } catch {}
      views.delete(id);
    }
    counts.delete(id);
    if (selected === id) { selected = PERSONAL; layout(); }
  }

  /** Reads every organisation's counts, one connection at a time; a failed read leaves the count unknown. */
  async function refreshCounts() {
    for (const record of store.list()) {
      const token = await store.token(record.id).catch(() => undefined);
      counts.set(record.id, token ? await readCounts(record.origin, token) : { reachable: false });
    }
  }

  function list() {
    windowNow();
    return { installations: installationList(store.list(), counts, selected) };
  }

  let timer = null;
  function start() {
    refreshCounts().catch(() => {});
    timer = setInterval(() => refreshCounts().catch(() => {}), COUNT_EVERY_MS);
    timer.unref?.();
  }

  return { select, close, list, refreshCounts, start, views, get selected() { return selected; } };
}

module.exports = { installationViews };
