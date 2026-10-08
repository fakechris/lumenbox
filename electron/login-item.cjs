const fs = require("node:fs");

/**
 * Brings the OS login item in line with `startupItem` in config.json.
 *
 * Registers only when the OS disagrees. On macOS each registration of an app whose bundle has
 * been replaced in place can be recorded against that build's cdhash rather than its signing
 * identity, so registering on every launch left one Login Items row per update — 26 of them on
 * one machine. No `path` is passed: it is a Windows-only option, and the default there is the
 * running executable anyway.
 *
 * An absent setting means the user never chose here, so a login item they added in System
 * Settings is left alone. Takes `app` as an argument so the decision is testable without Electron.
 */
function syncLoginItem(app, configFile) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return "unmanaged";
    throw err;
  }
  if (typeof cfg.startupItem !== "boolean") return "unmanaged";
  if (app.getLoginItemSettings().openAtLogin === cfg.startupItem) return "unchanged";
  app.setLoginItemSettings({ openAtLogin: cfg.startupItem });
  return cfg.startupItem ? "on" : "off";
}

module.exports = { syncLoginItem };
