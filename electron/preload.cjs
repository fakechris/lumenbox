/**
 * What a page in the main window may ask of the shell. The personal page: its organisation
 * connections — list, join, open, leave (INV-1690) — the first level, the installations with
 * their counts and which one the window shows (INV-1691), and what this machine is for, read and
 * changed within personal ↔ personal + organisation (INV-1696). The first-run page: what this
 * machine is for, chosen once. Nothing else; the token never crosses this bridge, and the shell
 * answers each call only for the page it belongs to (organisation-windows.cjs, main.cjs). An
 * organisation's page is loaded without this preload.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumenboxShell", {
  organisations: {
    list: () => ipcRenderer.invoke("organisations:list"),
    join: (address, name) => ipcRenderer.invoke("organisations:join", String(address ?? ""), String(name ?? "")),
    open: id => ipcRenderer.invoke("organisations:open", String(id)),
    disconnect: id => ipcRenderer.invoke("organisations:disconnect", String(id)),
  },
  installations: {
    list: () => ipcRenderer.invoke("installations:list"),
    select: (id, rail) => ipcRenderer.invoke("installations:select", String(id), Number(rail) || 0),
  },
  machine: {
    get: () => ipcRenderer.invoke("machine:get"),
    // An organisation node also sends the organisation's address and the node's name (INV-1697).
    choose: (use, details) => ipcRenderer.invoke("machine:choose", String(use ?? ""), details && typeof details === "object" ? { address: String(details.address ?? ""), name: String(details.name ?? "") } : undefined),
    change: use => ipcRenderer.invoke("machine:change", String(use ?? "")),
  },
});
