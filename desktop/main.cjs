const { app, BrowserWindow, shell, Menu, nativeTheme, globalShortcut, desktopCapturer, screen, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHandJobRunner } = require('./hand-jobs.cjs');

nativeTheme.themeSource = 'dark';
let mainWindow = null;
const screenshotWatchers = [];
const seenScreenshotFiles = new Map();
const screenshotTimers = new Set();
let screenshotSession = null;
let handJobRunner = null;

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

async function dispatchScreenshotFile(file, session = screenshotSession) {
  if (!session || screenshotSession !== session || !mainWindow || !looksLikeScreenshotFile(file)) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.mtimeMs < session.watchStartedAt || Date.now() - stat.mtimeMs > 30000) return false;
    const prior = seenScreenshotFiles.get(file);
    if (prior && Math.abs(prior - stat.mtimeMs) < 1) return;
    seenScreenshotFiles.set(file, stat.mtimeMs);
    const bytes = fs.readFileSync(file);
    if (bytes.length > 14_000_000) return;
    const dataUrl = `data:${mimeForFile(file)};base64,${bytes.toString('base64')}`;
    await mainWindow.webContents.executeJavaScript(
      `window.innerGameReceiveScreenshot && window.innerGameReceiveScreenshot(${JSON.stringify(dataUrl)}, 'desktop_auto', ${JSON.stringify(session.id)})`
    );
  } catch (error) {
    console.error('Screenshot watcher failed', error);
  }
}

function watchScreenshotFolder(dir) {
  const session = screenshotSession;
  if (!session) return;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename || screenshotSession !== session) return;
      const file = path.join(dir, String(filename));
      const timer = setTimeout(() => {
        screenshotTimers.delete(timer);
        dispatchScreenshotFile(file, session);
      }, 450);
      screenshotTimers.add(timer);
    });
    screenshotWatchers.push(watcher);
  } catch (error) {
    console.error('Could not watch screenshot folder', dir, error);
  }
}

function startScreenshotWatchers() {
  if (!screenshotSession || screenshotWatchers.length) return;
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'Pictures', 'Screenshots'),
    path.join(home, 'Pictures')
  ];
  [...new Set(candidates)].forEach(watchScreenshotFolder);
}

function stopScreenshotWatchers() {
  screenshotWatchers.splice(0).forEach(watcher => { try { watcher.close(); } catch {} });
  screenshotTimers.forEach(timer => clearTimeout(timer));
  screenshotTimers.clear();
  seenScreenshotFiles.clear();
}

function setAutoScreenshotEnabled(payload = {}) {
  const enabled = payload?.enabled === true && typeof payload.sessionId === 'string' && payload.sessionId.length > 0
    && Number.isFinite(Number(payload.startedAt)) && Number(payload.startedAt) > 0;
  if (enabled && screenshotSession?.id === payload.sessionId) return true;
  screenshotSession = null;
  stopScreenshotWatchers();
  if (enabled) {
    screenshotSession = { id: payload.sessionId, watchStartedAt: Date.now() };
    startScreenshotWatchers();
  }
  return enabled;
}

async function capturePrimaryScreen() {
  const session = screenshotSession, win = mainWindow;
  if (!win || !session) return false;
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
    if (screenshotSession !== session || mainWindow !== win) return false;
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('No screen source');
    const dataUrl = source.thumbnail.toDataURL();
    await mainWindow.webContents.executeJavaScript(
      `window.innerGameReceiveScreenshot && window.innerGameReceiveScreenshot(${JSON.stringify(dataUrl)}, 'desktop_hotkey', ${JSON.stringify(session.id)})`
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
    backgroundColor: '#0b1320',
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
  win.webContents.on('did-start-loading', () => setAutoScreenshotEnabled({ enabled: false }));
  win.webContents.on('did-finish-load', () => { if (handJobRunner) handJobRunner.deliver(); });
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
    if (mainWindow === win) {
      setAutoScreenshotEnabled({ enabled: false });
      mainWindow = null;
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  handJobRunner = createHandJobRunner({directory:path.join(app.getPath('userData'),'hand-jobs'),onComplete:async(job,notify)=>{
    const view=job.kind==='solve'?'solverResult':job.kind==='reconstruction'?'solverReview':'handDetail';
    if(notify&&Notification.isSupported()){
      const label=job.kind==='solve'?'GTO solution':job.kind==='reconstruction'?'Hand reconstruction':'Hand analysis';
      const needsReview=job.kind==='reconstruction'&&job.result?.ready===false||job.kind==='analysis'&&job.result?.isPokerHand===false;
      const notification=new Notification({title:label+(job.status==='failed'||needsReview?' needs attention':' ready'),body:job.error?.message||(needsReview?'Tap to review the hand details.':'Tap to open your hand.')});
      notification.on('click',async()=>{
        if(!mainWindow){createWindow();mainWindow.webContents.once('did-finish-load',()=>mainWindow.webContents.executeJavaScript(`window.innerGameOpenHand(${JSON.stringify(job.handId)},${JSON.stringify(view)})`));return;}
        if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();
        await handJobRunner.deliver();
        await mainWindow.webContents.executeJavaScript(`window.innerGameOpenHand(${JSON.stringify(job.handId)},${JSON.stringify(view)})`);
      });
      notification.show();
    }
    if(mainWindow&&!mainWindow.webContents.isLoading()){
      await mainWindow.webContents.executeJavaScript(`window.innerGameReceiveHandJob && window.innerGameReceiveHandJob(${JSON.stringify(job)})`);
    }
  }});
  handJobRunner.restore();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+H', capturePrimaryScreen);
  ipcMain.handle('innergame:capture-hand', capturePrimaryScreen);
  ipcMain.handle('innergame:set-auto-screenshot-enabled', (event, payload) => {
    if (event.sender !== mainWindow?.webContents) return false;
    return setAutoScreenshotEnabled(payload);
  });
  ipcMain.handle('innergame:enqueue-hand-job', (event,payload) => {
    if(event.sender!==mainWindow?.webContents)return {accepted:false,error:'Unknown app window.'};
    try{return handJobRunner.enqueue(payload);}catch(error){return {accepted:false,error:String(error.message||error)};}
  });
  ipcMain.handle('innergame:ack-hand-job', (_event,payload) => handJobRunner.ack(payload));
  ipcMain.handle('innergame:cancel-hand-jobs', (_event,payload) => handJobRunner.cancel(payload));
  ipcMain.handle('innergame:notify-hand', (_event, payload={}) => {
    try {
      if (!Notification.isSupported()) return false;
      const notification = new Notification({
        title: payload.title || 'Inner Game',
        body: payload.body || '',
        silent: false
      });
      notification.on('click', async () => {
        try {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          if (payload.handId) {
            await mainWindow.webContents.executeJavaScript(
              `window.innerGameOpenHand && window.innerGameOpenHand(${JSON.stringify(payload.handId)},${JSON.stringify(payload.view||'handDetail')})`
            );
          }
        } catch (error) {
          console.error('Could not open hand from notification', error);
        }
      });
      notification.show();
      return true;
    } catch (error) {
      console.error('Hand notification failed', error);
      return false;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); setAutoScreenshotEnabled({ enabled: false }); });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
