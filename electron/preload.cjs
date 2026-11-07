/**
 * What the personal page in the main window may ask of the shell (INV-1690): its organisation
 * connections — list, join, open, leave. Four calls and nothing else; the token never crosses
 * this bridge, and the shell answers only the personal page (organisation-windows.cjs).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lumenboxShell", {
  organisations: {
    list: () => ipcRenderer.invoke("organisations:list"),
    join: (address, name) => ipcRenderer.invoke("organisations:join", String(address ?? ""), String(name ?? "")),
    open: id => ipcRenderer.invoke("organisations:open", String(id)),
    disconnect: id => ipcRenderer.invoke("organisations:disconnect", String(id)),
  },
});
