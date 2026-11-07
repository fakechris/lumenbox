/**
 * What the personal page in the main window may ask of the shell: its organisation connections —
 * list, join, open, leave (INV-1690) — and the first level, the installations with their counts
 * and which one the window shows (INV-1691). Six calls and nothing else; the token never crosses
 * this bridge, and the shell answers only the personal page (organisation-windows.cjs). An
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
});
