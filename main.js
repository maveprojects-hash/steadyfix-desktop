const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Gateway } = require('./gateway');

const SITE = 'https://maveprojects-hash.github.io/steadyfix/';
const START = SITE + 'maintdesk_login.html';
const ORIGIN = new URL(SITE).origin;
const ICON = path.join(__dirname, 'icon.png');
const startHidden = process.argv.includes('--hidden');

let win = null, tray = null, quitting = false, asked = false;
let status = 'Network scan is not set up yet';
let cfg = {};

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const loadCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const saveCfg = () => fs.writeFileSync(cfgFile(), JSON.stringify(cfg));

const gw = new Gateway(() => cfg.agentKey, (s) => { status = s; buildTray(); });

function isPaypal(u) { return /(^|\.)paypal(objects)?\.com$/.test(u.hostname); }

function createWin() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 600,
    title: 'STEADYFIX CMMS', backgroundColor: '#1b2831', autoHideMenuBar: true,
    icon: ICON, show: !startHidden,
    webPreferences: { partition: 'persist:steadyfix', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' STEADYFIXDesktop/' + app.getVersion());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url || url === 'about:blank') return { action: 'allow' };
    let u;
    try { u = new URL(url); } catch { return { action: 'deny' }; }
    if (isPaypal(u)) return { action: 'allow' };
    if (u.origin === ORIGIN) { win.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^(mailto:|tel:)/.test(url)) { e.preventDefault(); shell.openExternal(url); return; }
    let u;
    try { u = new URL(url); } catch { return; }
    if (u.origin !== ORIGIN && !isPaypal(u) && /^https?:$/.test(u.protocol)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('did-finish-load', () => { if (!asked) setTimeout(() => offerGateway(false, 0), 3000); });
  win.loadURL(START);
}

function showWin() {
  if (!win) createWin();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

async function pageInfo() {
  try {
    return await win.webContents.executeJavaScript(`(async()=>{
      if(typeof me==='undefined'||!me||typeof site==='undefined'||!site)return null;
      const r=await sb.from('sites').select('name,agent_key').eq('id',site).single();
      return r.data?{name:r.data.name,key:r.data.agent_key}:null})()`);
  } catch { return null; }
}

async function offerGateway(force, tries) {
  if (!win || (cfg.agentKey && !force)) return;
  if (!/maintdesk_app/.test(win.webContents.getURL())) return;
  const info = await pageInfo();
  if (!info || !info.key) { if (tries < 5) setTimeout(() => offerGateway(force, tries + 1), 2500); return; }
  asked = true;
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Yes, use this site', 'Not now'], defaultId: 0, cancelId: 1,
    title: 'Network scanning',
    message: `Use "${info.name}" for network scanning on this computer?`,
    detail: 'STEADYFIX will find the devices on this network and show them under Monitoring. This is part of the PRO plan.',
  });
  if (r.response === 0) { cfg.agentKey = info.key; cfg.siteName = info.name; saveCfg(); gw.start(); buildTray(); }
}

function buildTray() {
  if (!tray) return;
  tray.setToolTip('STEADYFIX CMMS\n' + status);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open STEADYFIX', click: showWin },
    { label: status, enabled: false },
    { label: cfg.siteName ? `Scanning for: ${cfg.siteName}` : 'Network scanning is off', enabled: false },
    { label: 'Use the current site for network scanning', click: () => { showWin(); offerGateway(true, 0); } },
    { label: 'Scan now', enabled: !!cfg.agentKey, click: () => gw.once() },
    { type: 'separator' },
    { label: 'Start when I log in to this computer', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (m) => app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }) },
    { label: 'Quit STEADYFIX', click: () => { quitting = true; app.quit(); } },
  ]));
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', showWin);
  app.whenReady().then(() => {
    cfg = loadCfg();
    const img = nativeImage.createFromPath(ICON);
    tray = new Tray(img.resize({ width: 20, height: 20 }));
    tray.on('click', showWin);
    buildTray();
    createWin();
    if (cfg.agentKey) gw.start();
    if (app.isPackaged) {
      try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify(); } catch (e) { /* updates are optional */ }
    }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('activate', showWin);
}
