/**
 * The desktop shell.
 *
 * Thin on purpose: every feature lives in the web UI the orchestrator serves, so this
 * process does exactly three jobs — supervise that server as a child process, wrap the
 * page in a window whose top bar is the title bar, and keep a tray presence so "is
 * anything working" is answerable without opening the window.
 *
 * The supervisor is what makes the settings dialog's "Save & restart" seamless: the
 * server exits with code 75 (EX_TEMPFAIL, mirrored from src/web/server.ts) to mean
 * "start me again with the new config", and any other non-zero exit is a crash —
 * restarted a bounded number of times, then reported, because a crash loop that
 * restarts itself forever is worse than a window that says what broke.
 *
 * Quitting the shell kills the server child; the Docker box keeps running — it is a
 * separate daemon and always was. The tray's quit item says so.
 */

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  nativeImage,
  nativeTheme,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.LUMENBOX_PORT || 7777);
const PAGE = `http://127.0.0.1:${PORT}/`;
/** Mirrors RESTART_EXIT_CODE in src/web/server.ts. */
const RESTART_EXIT_CODE = 75;
const REPO = path.join(__dirname, "..");

let serverChild = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let crashRestarts = 0;
/** The last lines the server wrote, for the dialog when it will not stay up. */
let recentLog = [];

function log(line) {
  console.log(`[shell] ${line}`);
}

function configFilePath() {
  const home = process.env.AGENTBOX_HOME || path.join(os.homedir(), ".agentbox");
  return process.env.AGENTBOX_CONFIG || path.join(home, "config.json");
}

function applyStartupItemSettings() {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  try {
    const file = configFilePath();
    if (!fs.existsSync(file)) return;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof cfg.startupItem === "boolean") {
      app.setLoginItemSettings({
        openAtLogin: cfg.startupItem,
        path: process.execPath.includes("/Applications/LumenBox.app")
          ? "/Applications/LumenBox.app"
          : process.execPath,
      });
      log(`applied startup item setting: openAtLogin = ${cfg.startupItem}`);
    }
  } catch (err) {
    log(`could not apply startup item: ${err.message}`);
  }
}

/**
 * Starts the orchestrator's web server as a child.
 *
 * Run through Electron's own binary in Node mode (ELECTRON_RUN_AS_NODE), so the shell
 * does not depend on a system Node being installed or being the right version. Provider
 * and key come from ~/.agentbox/config.json — the settings dialog writes it, the CLI
 * reads it — so the shell passes no flags of its own.
 */
function startServer() {
  const cli = path.join(REPO, "src", "cli.ts");
  serverChild = spawn(
    process.execPath,
    ["--experimental-transform-types", cli, "web", "--port", String(PORT)],
    {
      cwd: REPO,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const remember = chunk => {
    const text = String(chunk);
    process.stdout.write(text);
    recentLog = recentLog.concat(text.split("\n").filter(l => l.trim() !== "")).slice(-30);
  };
  serverChild.stdout.on("data", remember);
  serverChild.stderr.on("data", remember);

  serverChild.on("exit", (code, signal) => {
    serverChild = null;
    if (quitting) return;

    if (code === RESTART_EXIT_CODE) {
      // The settings dialog asked for this. Not a crash; the counter resets.
      log("server asked to be restarted (new config)");
      applyStartupItemSettings();
      updateTrayMenu();
      crashRestarts = 0;
      startServer();
      whenServerReady(() => mainWindow?.reload());
      return;
    }

    log(`server exited (code ${code}, signal ${signal})`);
    crashRestarts += 1;
    if (crashRestarts <= 3) {
      setTimeout(() => {
        startServer();
        whenServerReady(() => mainWindow?.reload());
      }, 1000 * crashRestarts);
      return;
    }
    // A server that dies every time it starts will not be fixed by a fourth start.
    dialog.showErrorBox(
      "The LumenBox server will not stay up",
      `It exited ${crashRestarts} times in a row. Last output:\n\n${recentLog.join("\n")}`
    );
  });
}

/**
 * System notifications, from the server's own event stream.
 *
 * Exactly three kinds of event leave the page and reach the OS: an agent waiting on
 * consent (the turn is paused until a person answers), a turn finishing while nobody
 * is looking at the window (the unattended-run case), and the box or server going
 * away. Everything else stays in the activity feed, because a notification channel
 * that carries everything carries nothing.
 */
let eventsRequest = null;

function windowIsVisible() {
  return mainWindow !== null && mainWindow.isVisible() && mainWindow.isFocused();
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body: body.slice(0, 240) });
  notification.on("click", () => createWindow());
  notification.show();
}

function watchEvents() {
  eventsRequest?.destroy();
  const request = http.get(`${PAGE}api/events`, response => {
    let buffer = "";
    response.on("data", chunk => {
      buffer += String(chunk);
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            handleServerEvent(JSON.parse(line.slice(5)));
          } catch {
            // A torn frame; the next one is whole.
          }
        }
      }
    });
    response.on("end", () => setTimeout(watchEvents, 3000));
  });
  request.on("error", () => setTimeout(watchEvents, 3000));
  eventsRequest = request;
}

function handleServerEvent(event) {
  if (event.type === "approval_pending") {
    notify(`${event.agentName || "An agent"} needs your consent`, `${event.description} — the turn is paused until you answer`);
    return;
  }
  if (event.type === "turn_finished" && !windowIsVisible()) {
    notify("A turn finished", "Open LumenBox to read what the agent said.");
    return;
  }
  if (event.type === "error" && /box stopped answering/i.test(String(event.message ?? ""))) {
    notify("The box stopped answering", String(event.message));
  }
}

/** Polls the page until the server answers, then calls back. */
function whenServerReady(callback, deadline = Date.now() + 60_000) {
  const request = http.get(PAGE, response => {
    response.resume();
    if (response.statusCode && response.statusCode < 500) {
      callback();
      return;
    }
    retry();
  });
  request.on("error", retry);
  function retry() {
    if (Date.now() > deadline) {
      log("server did not come up within a minute");
      return;
    }
    setTimeout(() => whenServerReady(callback, deadline), 500);
  }
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1120,
    minHeight: 720,
    // The page's own top bar is the title bar; the traffic lights inset into it.
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    // No flash of the wrong theme while the page loads.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0e16" : "#f7f6f2",
    icon: path.join(REPO, "assets", "app-icon", "png", "lumenbox-256.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  whenServerReady(() => mainWindow?.loadURL(PAGE));
}

function buildTrayMenu() {
  const loginSettings = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: "Open LumenBox", click: () => createWindow() },
    // Launch-at-login is set in Settings and applied here from config.json: one writer for
    // the file (the server), one applier for the OS (this process).
    {
      label: `Launch at login: ${loginSettings.openAtLogin ? "on" : "off"} (change in Settings)`,
      enabled: false,
    },
    {
      label: "Restart server",
      click: () => {
        // Kill and let the exit handler bring it back; the reload rides on ready.
        crashRestarts = -1; // the deliberate kill is not a crash
        serverChild?.kill();
      },
    },
    { type: "separator" },
    { label: "Quit — keeps the box running", click: () => app.quit() },
  ]);
}

function updateTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray() {
  const image = nativeImage.createFromPath(
    path.join(REPO, "assets", "app-icon", "tray", "trayTemplate.png")
  );
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("LumenBox");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => createWindow());
}

// One shell, one server: a second launch focuses the first window instead of racing
// for the same port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createWindow();
    mainWindow?.focus();
  });

  app.setName("LumenBox");

  app.whenReady().then(() => {
    // The BrowserWindow icon option is Windows/Linux only; on macOS the Dock icon
    // comes from the app bundle — which, unpackaged, is Electron's own. Set it at
    // runtime so the mark from the brand sheet shows in every mode. (The name beside
    // the menus still says Electron until the app is packaged; that is a bundle
    // property no runtime call can change.)
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(
        nativeImage.createFromPath(
          path.join(REPO, "assets", "app-icon", "png", "lumenbox-512.png")
        )
      );
    }
    applyStartupItemSettings();
    startServer();
    createTray();
    createWindow();
    whenServerReady(() => watchEvents());
  });

  // The window closing is not the app ending: the tray keeps the agents reachable,
  // which is the point of a shell over a page.
  app.on("window-all-closed", () => {});
  app.on("activate", () => createWindow());
  app.on("before-quit", () => {
    quitting = true;
    serverChild?.kill();
  });
}
