const { app, BrowserWindow, shell, Menu, nativeTheme, globalShortcut, desktopCapturer, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

nativeTheme.themeSource = 'dark';
let mainWindow = null;
const screenshotWatchers = [];
const seenScreenshotFiles = new Map();

function mimeForFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function looksLikeScreenshotFile(file) {
  const name = path.basename(file).toLowerCase();
  return /screenshot|screen shot|screen_shot|screencapture|capture/.test(name) && /\.(png|jpe?g|webp)$/i.test(name);
}

async function dispatchScreenshotFile(file) {
  if (!mainWindow || !looksLikeScreenshotFile(file)) return;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || Date.now() - stat.mtimeMs > 30000) return;
    const prior = seenScreenshotFiles.get(file);
    if (prior && Math.abs(prior - stat.mtimeMs) < 1) return;
    seenScreenshotFiles.set(file, stat.mtimeMs);
    const bytes = fs.readFileSync(file);
    if (bytes.length > 14_000_000) return;
    const dataUrl = `data:${mimeForFile(file)};base64,${bytes.toString('base64')}`;
    await mainWindow.webContents.executeJavaScript(
      `window.innerGameReceiveScreenshot && window.innerGameReceiveScreenshot(${JSON.stringify(dataUrl)}, 'desktop_auto')`
    );
  } catch (error) {
    console.error('Screenshot watcher failed', error);
  }
}

function watchScreenshotFolder(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const file = path.join(dir, String(filename));
      setTimeout(() => dispatchScreenshotFile(file), 450);
    });
    screenshotWatchers.push(watcher);
  } catch (error) {
    console.error('Could not watch screenshot folder', dir, error);
  }
}

function startScreenshotWatchers() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures', 'Screenshots'),
    path.join(home, 'Pictures')
  ];
  [...new Set(candidates)].forEach(watchScreenshotFolder);
}

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
  startScreenshotWatchers();
  ipcMain.handle('innergame:capture-hand', capturePrimaryScreen);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); screenshotWatchers.forEach(w=>{try{w.close();}catch{}}); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
