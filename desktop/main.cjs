const { app, BrowserWindow, shell, Menu, nativeTheme, globalShortcut, desktopCapturer, screen, ipcMain } = require('electron');
const path = require('path');

nativeTheme.themeSource = 'dark';
let mainWindow = null;

async function capturePrimaryScreen() {
  if (!mainWindow) return;
  try {
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const width = Math.max(1280, Math.round(display.bounds.width * scale));
    const height = Math.max(720, Math.round(display.bounds.height * scale));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source');
    const dataUrl = source.thumbnail.toDataURL();
    await mainWindow.webContents.executeJavaScript(
      `window.innerGameReceiveScreenshot && window.innerGameReceiveScreenshot(${JSON.stringify(dataUrl)}, 'desktop_hotkey')`
    );
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  } catch (error) {
    console.error('Capture failed', error);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#050607',
    title: 'Inner Game',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow = win;
  win.loadFile(path.join(__dirname, 'www', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+H', capturePrimaryScreen);
  ipcMain.handle('innergame:capture-hand', capturePrimaryScreen);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
