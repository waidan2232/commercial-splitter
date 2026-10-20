'use strict';
// The desktop app (Windows, macOS, Linux): runs the same engine and interface as the web version, in its own
// window. The interface talks to the engine over 127.0.0.1 with a secret only this window knows.

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'ts', 'm2ts', 'mts', 'avi', 'wmv', 'webm', 'flv', 'mpg', 'mpeg', 'vob', '3gp'];
const smokeTest = process.argv.includes('--smoke-test');

// Command-line mode: "Commercial Splitter" --cli video.mp4 … (same options as cli.js).
const cliAt = process.argv.indexOf('--cli');
if (cliAt >= 0) {
  require('../cli').main(process.argv.slice(cliAt + 1)).then((code) => app.exit(code), (e) => {
    console.error('Error: ' + e.message);
    app.exit(1);
  });
} else if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function videoFilesIn(argv) {
  return argv.slice(1).filter((a) => {
    if (a.startsWith('-')) return false;
    try {
      return fs.statSync(a).isFile() && VIDEO_EXTENSIONS.includes(path.extname(a).slice(1).toLowerCase());
    } catch (e) {
      return false;
    }
  });
}

function start() {
  let win = null, engine = null;
  const pending = videoFilesIn(process.argv);

  // macOS: videos dropped on the Dock icon or opened with the app.
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (win) win.webContents.send('open-files', [file]);
    else pending.push(file);
  });
  app.on('second-instance', (e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const files = videoFilesIn(argv);
    if (files.length) win.webContents.send('open-files', files);
  });

  ipcMain.handle('open-files', async (e, defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open commercial compilation',
      defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video files', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('choose-folder', async (e, defaultPath) => {
    let start = defaultPath || undefined;
    while (start && !fs.existsSync(start) && path.dirname(start) !== start) start = path.dirname(start);
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a folder',
      defaultPath: start,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('show-item', (e, file) => shell.showItemInFolder(String(file)));
  ipcMain.handle('initial-files', () => pending.splice(0));

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    setMenu();
    const { createApp } = require('../server/app');
    const token = crypto.randomBytes(24).toString('hex');
    const ffmpegDir = app.isPackaged
      ? path.join(process.resourcesPath, 'ffmpeg')
      : path.join(__dirname, '..', 'vendor', 'ffmpeg', process.platform + '-' + process.arch);
    engine = createApp({ mode: 'desktop', token, dataDir: app.getPath('userData'), ffmpegDir });
    await new Promise((resolve) => engine.server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + engine.server.address().port;

    const mac = process.platform === 'darwin';
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      backgroundColor: '#18181b',
      title: 'Commercial Splitter',
      icon: mac ? undefined : path.join(__dirname, '..', 'build', 'icon.png'),
      // The app draws its own header; the window buttons sit on top of it.
      titleBarStyle: 'hidden',
      titleBarOverlay: mac ? undefined : { color: '#18181b', symbolColor: '#f0f0f3', height: 40 },
      trafficLightPosition: mac ? { x: 18, y: 26 } : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => { if (!smokeTest) win.show(); });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !url.startsWith(origin)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin + '/')) e.preventDefault(); });
    win.webContents.on('will-prevent-unload', (e) => {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Stop and exit', 'Keep working'], defaultId: 1, cancelId: 1,
        title: 'Commercial Splitter', message: 'Work is still in progress. Stop and exit?',
      });
      if (choice === 0) e.preventDefault();
    });
    win.on('closed', () => { win = null; });
    if (smokeTest) runSmokeTest(win);
    await win.loadURL(origin + '/auth?token=' + token);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (engine) engine.close(); });
}

function setMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs a menu for the app name, copy/paste in text fields and the window commands. (Undo is left to the
  // app itself: ⌘Z undoes clip edits.)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { role: 'windowMenu' },
  ]));
}

/** For the builds: start, check that the interface and the engine (with FFmpeg) work, quit. */
function runSmokeTest(win) {
  const fail = (why) => {
    console.error('SMOKE TEST FAILED: ' + why);
    app.exit(1);
  };
  const timer = setTimeout(() => fail('timed out'), 60000);
  win.webContents.on('did-fail-load', (e, code, desc) => fail('load failed: ' + desc));
  win.webContents.on('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && !window.CommercialSplitter; i++) await new Promise((r) => setTimeout(r, 100));
        const info = await (await fetch('api/info')).json();
        return { ui: !!window.CommercialSplitter, desktop: !!window.desktop, ffmpeg: info.ffmpeg, mode: info.mode };
      })()`);
      clearTimeout(timer);
      console.log('SMOKE TEST: ' + JSON.stringify(result));
      if (!result.ui || !result.desktop || result.mode !== 'desktop' || !result.ffmpeg.found) return fail('unexpected result');
      app.exit(0);
    } catch (e) {
      fail(e.message);
    }
  });
}
