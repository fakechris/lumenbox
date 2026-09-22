const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-renderer-accessibility');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 640, height: 480, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  window.loadURL('http://127.0.0.1:17880/?client=electron');
});
app.on('window-all-closed', () => app.quit());
