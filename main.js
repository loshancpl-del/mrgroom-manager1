'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./src/store');
const paths = require('./src/paths');
const CFG = require('./src/config');
const { Drive, day: dayStr } = require('./src/gdrive');

if (!app.requestSingleInstanceLock()) { app.quit(); }   // two copies at once could corrupt the data
app.setAppUserModelId('app.mrgroom.manager');

const U = () => app.getPath('userData');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(U(), f), 'utf8')); } catch (e) { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(U(), { recursive: true }); fs.writeFileSync(path.join(U(), f), JSON.stringify(o, null, 1)); };
let win = null, store = null, drive = null, driveTimer = null;

const sealS = t => (safeStorage.isEncryptionAvailable() ? 'e:' + safeStorage.encryptString(t).toString('base64') : 'p:' + Buffer.from(t).toString('base64'));
const unsealS = t => (t.startsWith('e:') ? safeStorage.decryptString(Buffer.from(t.slice(2), 'base64')) : Buffer.from(t.slice(2), 'base64').toString());
// Google client values: built into the app, or (fallback) read from Desktop\\MrGroom\\google-client.json
function googleClient() {
  const ok = v => v && !/^__/.test(v);
  if (ok(CFG.googleClientId) && ok(CFG.googleClientSecret)) return { id: CFG.googleClientId, secret: CFG.googleClientSecret };
  try {
    const cfg = readJson('config.json', {}), root = cfg.root || path.join(app.getPath('desktop'), 'MrGroom');
    const j = JSON.parse(fs.readFileSync(path.join(root, 'google-client.json'), 'utf8'));
    if (ok(j.clientId) && ok(j.clientSecret)) return { id: j.clientId, secret: j.clientSecret };
  } catch (e) { /* none */ }
  return { id: '', secret: '' };
}
function initDrive() {
  const g = googleClient();
  drive = new Drive({ clientId: g.id, clientSecret: g.secret, seal: sealS, unseal: unsealS,
    read: () => readJson('drive.json', {}), write: o => writeJson('drive.json', o),
    openUrl: u => { if (/^https:\/\/accounts\.google\.com\//.test(u)) shell.openExternal(u); } });
}
const driveBody = () => JSON.stringify({ app: 'mrgroom', version: 1, kind: 'drive', saved: new Date().toISOString(), data: store.data });
async function driveBackup() {
  if (!drive || !drive.connected() || !store) return { ok: false, error: 'Google Drive is not linked yet.' };
  store.flush();
  return drive.upload('MrGroom-' + dayStr(new Date()) + '.json', driveBody());
}
function driveTick() { if (drive && drive.needsToday() && store) driveBackup().catch(() => {}); }

function lockDown(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/wa\.me\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
}

function openMain() {
  const cfg = readJson('config.json', {});
  store = new Store(cfg.root, { secondDir: cfg.secondDir });
  const res = store.load();
  if (res.status === 'missing-with-backups') {
    const c = dialog.showMessageBoxSync({ type: 'question', buttons: ['Restore the latest backup', 'Start empty'], defaultId: 0, cancelId: 1,
      title: CFG.productName, message: 'Your data file was not found.',
      detail: 'The data folder looks empty or was deleted, but automatic backups exist.\n\nLatest backup:\n' + res.latest.path + '\n\nRestore it now?' });
    if (c === 0) store.restore(res.latest.path);
    else { store.data = { ...require('./src/store').FIRST_RUN }; store.dirty = true; store.flush(); }
  } else if (res.status === 'recovered') {
    dialog.showMessageBoxSync({ type: 'info', message: 'Your data was recovered from the previous saved copy.', buttons: ['OK'] });
  }
  win = new BrowserWindow({ width: 1366, height: 860, show: false, icon: path.join(__dirname, 'build/icon.ico'), title: CFG.productName, backgroundColor: '#313332',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
  lockDown(win);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer/app.html'));
  win.on('closed', () => { win = null; });
  buildMenu();
  driveTick(); driveTimer = setInterval(driveTick, 30 * 60000);
}

function buildMenu() {
  const chooseLocal = async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose an extra local backup folder (another drive or USB stick)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return store.info();
    const s = store.setSecond(r.filePaths[0]);
    if (!s.ok) { dialog.showErrorBox('Backup folder', 'Could not write to that folder: ' + s.error); store.setSecond(null); return store.info(); }
    const cfg = readJson('config.json', {}); cfg.secondDir = r.filePaths[0]; writeJson('config.json', cfg);
    return store.info();
  };
  ipcMain.removeHandler('backup:chooseSecond'); ipcMain.handle('backup:chooseSecond', async e => { if (!fromApp(e)) return {}; return chooseLocal(); });
  const restoreFromFile = () => {
    const f = dialog.showOpenDialogSync(win, { title: 'Choose a backup file', defaultPath: store.backupDir, filters: [{ name: 'Mr GROOM backup', extensions: ['json'] }], properties: ['openFile'] });
    if (!f || !f[0]) return;
    if (!store.readBackup(f[0])) { dialog.showErrorBox('Restore', 'That file is not a valid Mr GROOM backup.'); return; }
    const c = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Replace my data', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Replace all current data with this backup?', detail: 'A safety copy of your current data is saved first.\n' + f[0] });
    if (c !== 0) return;
    const r = store.restore(f[0]);
    if (r.ok) win.webContents.reload(); else dialog.showErrorBox('Restore', r.error);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Back up now', accelerator: 'CmdOrCtrl+B', click: async () => { const r = store.backupNow(); const d = drive && drive.connected() ? await driveBackup() : null;
        dialog.showMessageBox(win, { type: r.ok ? 'info' : 'error', message: r.ok ? 'Backup saved' : 'Backup failed', detail: r.ok ? r.files.join('\n') + (r.errors.length ? '\n\nProblem: ' + r.errors.join('\n') : '') + (d ? '\n\nGoogle Drive: ' + (d.ok ? 'uploaded' : d.error) : '') : r.errors.join('\n') }); } },
      { label: 'Open data folder', click: () => shell.openPath(store.root) },
      { label: 'Choose extra local backup folder…', click: chooseLocal },
      { label: 'Restore from a backup file…', click: restoreFromFile },
      { type: 'separator' }, { role: 'quit', label: 'Exit' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [{ label: 'About', click: () => dialog.showMessageBox(win, { type: 'info', message: CFG.productName + ' ' + app.getVersion(),
      detail: 'Data folder: ' + store.root + '\nSupport: ' + [CFG.vendorName, CFG.supportPhone, CFG.supportEmail].filter(Boolean).join(' · ') }) }] }
  ]));
}

// ---- IPC: only the app window may talk to the store and Drive ----
const fromApp = e => win && e.sender === win.webContents;
ipcMain.on('store:loadAll', e => { e.returnValue = fromApp(e) && store ? store.data : {}; });
ipcMain.on('store:set', (e, k, v) => { if (fromApp(e) && store && /^crt_[a-z_]+$/.test(k)) store.set(k, v); });
ipcMain.on('backup:info', e => { e.returnValue = fromApp(e) && store ? { ...store.info(), drive: drive ? drive.status() : null } : {}; });
ipcMain.handle('backup:now', async e => {
  if (!fromApp(e) || !store) return { ok: false, error: 'Not ready' };
  try {
    const r = store.backupNow();
    if (drive && drive.connected()) { const d = await driveBackup(); r.drive = d.ok ? 'Uploaded to Google Drive' : 'Google Drive: ' + d.error; if (!d.ok) r.errors.push(r.drive); }
    return r;
  } catch (x) { return { ok: false, error: x.message }; }
});
ipcMain.handle('drive:status', e => (fromApp(e) ? drive.status() : {}));
ipcMain.handle('drive:connect', async (e, em) => (fromApp(e) ? drive.connect(em) : { ok: false, error: 'Not allowed' }));
ipcMain.handle('drive:disconnect', e => (fromApp(e) ? drive.disconnect() : { ok: false }));
ipcMain.handle('drive:backup', async e => (fromApp(e) ? driveBackup() : { ok: false, error: 'Not allowed' }));
ipcMain.handle('drive:list', async e => { if (!fromApp(e)) return { ok: false, error: 'Not allowed' }; try { return { ok: true, files: await drive.list() }; } catch (x) { return { ok: false, error: x.message }; } });
ipcMain.handle('drive:restore', async (e, id) => {
  if (!fromApp(e) || !store) return { ok: false, error: 'Not allowed' };
  try {
    const text = await drive.download(id), tmp = path.join(store.backupDir, 'from-drive.tmp.json');
    fs.mkdirSync(store.backupDir, { recursive: true }); fs.writeFileSync(tmp, text);
    if (!store.readBackup(tmp)) { fs.unlinkSync(tmp); return { ok: false, error: 'That file is not a valid Mr GROOM backup.' }; }
    const c = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Replace my data', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Replace all current data with this Google Drive backup?', detail: 'A safety copy of your current data is saved first.' });
    if (c !== 0) { fs.unlinkSync(tmp); return { ok: false, error: '' }; }
    const r = store.restore(tmp); try { fs.unlinkSync(tmp); } catch (x) {}
    if (r.ok) win.webContents.reload(); return r;
  } catch (x) { return { ok: false, error: x.message }; }
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { try { if (store) store.flush(); if (driveTimer) clearInterval(driveTimer); } catch (e) {} });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  let cfg = readJson('config.json', {});
  if (!cfg.root) { const d = paths.detect(process.env, { desktop: app.getPath('desktop'), home: app.getPath('home') }); cfg = { root: d.root, secondDir: d.second || null }; writeJson('config.json', cfg); }
  initDrive(); openMain();
});
