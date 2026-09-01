'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell, dialog, safeStorage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const core = require('../core');
const { drawTrayIcon } = require('./icon');

const isDev = process.argv.includes('--dev');

let tray = null;
let popover = null;
let dashboard = null;
let refreshTimer = null;

/** Dernier instantané calculé, partagé par le popover et le tableau de bord. */
let state = null;
let snap = null;
let refreshing = false;

// ---------------------------------------------------------------------------
// Configuration & secrets
// ---------------------------------------------------------------------------

/**
 * Les clés Admin ne sont jamais écrites en clair : elles sont chiffrées par le
 * trousseau du système (Keychain, DPAPI, libsecret) via `safeStorage`. Si le
 * chiffrement n'est pas disponible (certaines sessions Linux sans trousseau),
 * on refuse de stocker la clé plutôt que de l'écrire en clair sur le disque.
 */
function decryptKey(stored) {
  if (!stored) return null;
  if (typeof stored === 'string') return stored; // migration depuis une version antérieure
  if (stored.enc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}

function loadConfigWithKeys() {
  const cfg = core.store.loadConfig();
  return {
    ...cfg,
    anthropicAdminKey: decryptKey(cfg.anthropicAdminKey),
    openaiAdminKey: decryptKey(cfg.openaiAdminKey),
  };
}

function saveKey(field, value) {
  const cfg = core.store.loadConfig();
  if (!value) {
    cfg[field] = null;
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Le trousseau du système n'est pas disponible : TRACE refuse d'écrire une clé d'API en clair sur le disque."
      );
    }
    cfg[field] = { enc: safeStorage.encryptString(value).toString('base64') };
  }
  core.store.saveConfig(cfg);
}

// ---------------------------------------------------------------------------
// Rafraîchissement
// ---------------------------------------------------------------------------

async function refresh(reason = 'timer') {
  if (refreshing) return snap;
  refreshing = true;
  try {
    const config = loadConfigWithKeys();
    state = await core.refresh({ config, index: state ? state.index : undefined });
    state.config = config;
    snap = core.snapshot(state, { days: config.defaultRangeDays });
    updateTray();
    broadcast();
    return snap;
  } catch (e) {
    console.error('[trace] échec du rafraîchissement:', e);
    // On garde le dernier instantané valide : mieux vaut des chiffres un peu
    // datés qu'une interface vide.
    if (snap) snap.staleError = e.message;
    broadcast();
    return snap;
  } finally {
    refreshing = false;
  }
}

function broadcast() {
  for (const w of [popover, dashboard]) {
    if (w && !w.isDestroyed()) w.webContents.send('trace:update', snap);
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const cfg = core.store.loadConfig();
  const sec = Math.max(15, cfg.refreshIntervalSec || 60);
  refreshTimer = setInterval(() => refresh('timer'), sec * 1000);
}

// ---------------------------------------------------------------------------
// Barre d'état
// ---------------------------------------------------------------------------

/** Métrique la plus parlante d'un coup d'œil : la jauge la plus remplie. */
function primaryGauge() {
  if (!snap || !snap.gauges.length) return null;
  const withPct = snap.gauges.filter((g) => g.percent != null);
  if (!withPct.length) return null;
  return withPct.reduce((a, b) => (b.percent > a.percent ? b : a));
}

function trayTitle() {
  if (!snap) return '';
  const cfg = core.store.loadConfig();
  const t = snap.report.totals;
  switch (cfg.trayMetric) {
    case 'tokens': {
      const n = t.tokens.total;
      return n >= 1e9 ? `${(n / 1e9).toFixed(1)} Md` : `${Math.round(n / 1e6)} M`;
    }
    case 'cost':
      return `$${t.costUSD.toFixed(0)}`;
    case 'carbon':
      return `${(t.carbon.gramsCO2e.mid / 1000).toFixed(1)} kg`;
    case 'session':
    default: {
      const g = primaryGauge();
      return g ? `${Math.round(g.percent)} %` : '—';
    }
  }
}

function updateTray() {
  if (!tray) return;
  const g = primaryGauge();
  const fill = g ? g.percent / 100 : null;

  // macOS teinte lui-même les icônes « template » ; ailleurs on colore selon
  // le niveau, pour qu'un dépassement se voie sans lire le chiffre.
  const isMac = process.platform === 'darwin';
  const hot = fill != null && fill >= 0.85;
  const tint = hot ? [255, 107, 91] : [255, 180, 84];

  const img = nativeImage.createFromBuffer(drawTrayIcon(22, fill, isMac, tint));
  img.addRepresentation({ scaleFactor: 2, buffer: drawTrayIcon(44, fill, isMac, tint) });
  if (isMac) img.setTemplateImage(true);

  tray.setImage(img);
  if (isMac) tray.setTitle(trayTitle() ? ` ${trayTitle()}` : '');

  const lines = ['TRACE'];
  if (snap) {
    for (const gg of snap.gauges) {
      lines.push(`${gg.label} : ${gg.percent != null ? Math.round(gg.percent) + ' %' : '—'}`);
    }
    lines.push(`${snap.range.days} j : $${snap.report.totals.costUSD.toFixed(2)} · ${(snap.report.totals.carbon.gramsCO2e.mid / 1000).toFixed(1)} kg CO₂e`);
  }
  tray.setToolTip(lines.join('\n'));
}

function buildTrayMenu() {
  const cfg = core.store.loadConfig();
  return Menu.buildFromTemplate([
    { label: 'Voir les jauges', accelerator: cfg.shortcut, click: () => togglePopover() },
    { label: 'Ouvrir le tableau de bord', click: () => openDashboard() },
    { type: 'separator' },
    {
      label: 'Afficher dans la barre',
      submenu: ['session', 'tokens', 'cost', 'carbon'].map((m) => ({
        label: { session: 'Consommation de la fenêtre', tokens: 'Tokens', cost: 'Coût', carbon: 'CO₂e' }[m],
        type: 'radio',
        checked: cfg.trayMetric === m,
        click: () => {
          core.store.saveConfig({ ...core.store.loadConfig(), trayMetric: m });
          updateTray();
        },
      })),
    },
    { label: 'Actualiser maintenant', click: () => refresh('manuel') },
    { type: 'separator' },
    { label: 'Quitter TRACE', click: () => app.quit() },
  ]);
}

// ---------------------------------------------------------------------------
// Fenêtres
// ---------------------------------------------------------------------------

const POPOVER_W = 384;
const POPOVER_H = 528;

function createPopover() {
  popover = new BrowserWindow({
    width: POPOVER_W,
    height: POPOVER_H,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    fullscreenable: false,
    transparent: process.platform === 'darwin',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#14161A',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  popover.loadFile(path.join(__dirname, '..', 'renderer', 'popover', 'index.html'));

  // Un popover doit se comporter comme un popover : il disparaît dès qu'on
  // clique ailleurs. En développement on le garde ouvert pour pouvoir
  // inspecter sans qu'il se referme sous les doigts.
  popover.on('blur', () => {
    if (!isDev && popover && !popover.webContents.isDevToolsOpened()) popover.hide();
  });
  popover.on('closed', () => (popover = null));
}

/** Positionne le popover sous l'icône de la barre d'état, en restant à l'écran. */
function positionPopover() {
  if (!popover) return;
  const bounds = tray ? tray.getBounds() : null;
  const display = screen.getDisplayNearestPoint(
    bounds && bounds.width ? { x: bounds.x, y: bounds.y } : screen.getCursorScreenPoint()
  );
  const area = display.workArea;

  let x;
  let y;
  if (bounds && bounds.width) {
    x = Math.round(bounds.x + bounds.width / 2 - POPOVER_W / 2);
    // Barre d'état en haut (macOS, Windows en haut) ou en bas (Windows par défaut).
    y = bounds.y > area.y + area.height / 2 ? area.y + area.height - POPOVER_H - 8 : Math.round(bounds.y + bounds.height + 6);
  } else {
    const cursor = screen.getCursorScreenPoint();
    x = Math.round(cursor.x - POPOVER_W / 2);
    y = Math.round(area.y + 40);
  }

  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPOVER_W - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - POPOVER_H - 8));
  popover.setPosition(x, y, false);
}

function togglePopover() {
  if (!popover) createPopover();
  if (popover.isVisible()) {
    popover.hide();
    return;
  }
  positionPopover();
  popover.show();
  popover.focus();
  refresh('popover');
}

function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return;
  }
  dashboard = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: 'TRACE',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161A' : '#F7F5F1',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  dashboard.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard', 'index.html'));
  if (isDev) {
    dashboard.setPosition(60, 60, false);
    // Garde la fenêtre au premier plan pendant le développement : sans cela,
    // toute capture d'écran attrape ce qui traîne au-dessus.
    dashboard.setAlwaysOnTop(true, 'floating');
  }
  dashboard.on('closed', () => (dashboard = null));
  if (process.argv.includes('--devtools')) dashboard.webContents.openDevTools({ mode: 'detach' });
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const cfg = core.store.loadConfig();
  const accel = cfg.shortcut || 'CommandOrControl+Alt+T';
  const ok = globalShortcut.register(accel, togglePopover);
  if (!ok) console.warn(`[trace] raccourci « ${accel} » déjà pris par une autre application`);
  return ok;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('trace:snapshot', async (_e, options = {}) => {
    if (!snap) await refresh('demande initiale');
    if (options.days && state) snap = core.snapshot(state, { days: options.days });
    return snap;
  });
  ipcMain.handle('trace:refresh', () => {
    // Une demande explicite passe outre la cadence d'interrogation : c'est
    // précisément ce qu'attend quelqu'un qui clique sur « Actualiser ».
    require('../core/collectors/anthropic-oauth').resetCache();
    return refresh('manuel');
  });
  ipcMain.handle('trace:config:get', () => {
    const cfg = core.store.loadConfig();
    return {
      ...cfg,
      // On confirme la présence d'une clé sans jamais la faire redescendre.
      anthropicAdminKey: cfg.anthropicAdminKey ? '••••••••' : null,
      openaiAdminKey: cfg.openaiAdminKey ? '••••••••' : null,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  });
  ipcMain.handle('trace:config:set', async (_e, patch) => {
    const cfg = { ...core.store.loadConfig(), ...patch };
    delete cfg.anthropicAdminKey_display;
    core.store.saveConfig(cfg);
    if (patch.shortcut) registerShortcut();
    if (patch.refreshIntervalSec) scheduleRefresh();
    if (patch.launchAtLogin != null && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    await refresh('réglages');
    return true;
  });
  ipcMain.handle('trace:key:set', async (_e, { provider, value }) => {
    const field = provider === 'openai' ? 'openaiAdminKey' : 'anthropicAdminKey';
    try {
      saveKey(field, value);
      await refresh('clé');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('trace:calibrate', async (_e, { gaugeId, percent }) => {
    if (!state) return { ok: false, error: 'Données pas encore chargées' };
    try {
      core.calibrate(state, gaugeId, Number(percent));
      await refresh('calibrage');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('trace:dashboard:open', () => {
    if (popover && popover.isVisible()) popover.hide();
    openDashboard();
  });
  ipcMain.handle('trace:popover:close', () => popover && popover.hide());
  ipcMain.handle('trace:external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('trace:quit', () => app.quit());
  ipcMain.handle('trace:export', async (_e, options = {}) => {
    if (!snap) return { ok: false, error: 'Aucune donnée à exporter' };
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Exporter la consommation',
      defaultPath: `trace-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    const rows = [['date', 'modele', 'fournisseur', 'source', 'projet', 'entree', 'sortie', 'cache_ecrit', 'cache_lu', 'total', 'cout_usd', 'gco2e_min', 'gco2e_max']];
    for (const day of snap.report.daily) {
      for (const m of day.models) rows.push([day.date, m.label, '', '', '', '', '', '', '', m.total, '', '', '']);
    }
    for (const g of snap.report.byModel) {
      rows.push([
        'TOTAL', g.models[0].label, g.models[0].provider, '', '',
        g.tokens.input, g.tokens.output, g.tokens.cacheWrite, g.tokens.cacheRead, g.tokens.total,
        g.costUSD.toFixed(4), g.carbon.gramsCO2e.min.toFixed(1), g.carbon.gramsCO2e.max.toFixed(1),
      ]);
    }
    const csv = rows.map((r) => r.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
    fs.writeFileSync(filePath, '﻿' + csv, 'utf8'); // BOM : Excel lit correctement les accents
    return { ok: true, filePath };
  });
}

/**
 * macOS exige un menu applicatif pour que les raccourcis d'édition standard
 * (copier, coller, tout sélectionner) fonctionnent dans les champs de saisie.
 */
function buildAppMenu() {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
      { label: 'Édition', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'Fenêtre', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'reload' }] },
    ])
  );
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePopover());

  app.whenReady().then(async () => {
    // Sur macOS, TRACE vit dans la barre d'état : pas d'icône dans le Dock.
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    buildAppMenu();
    registerIpc();

    tray = new Tray(nativeImage.createFromBuffer(drawTrayIcon(22, null, process.platform === 'darwin')));
    if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);

    // Surtout PAS `setContextMenu` : un menu attaché s'ouvre au clic gauche,
    // en plus du popover, et l'utilisateur se retrouve avec deux fenêtres.
    // Le clic gauche montre les jauges, le clic droit le menu — les actions
    // du menu sont de toute façon toutes accessibles depuis le popover.
    tray.on('click', () => togglePopover());
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));

    registerShortcut();
    scheduleRefresh();
    await refresh('démarrage');

    nativeTheme.on('updated', () => updateTray());

    // En développement, on ouvre directement le tableau de bord : inspecter
    // une fenêtre qui n'apparaît que sur raccourci global est pénible.
    if (isDev) {
      // Le thème est forçable en développement : contrôler les deux variantes
      // sans changer le réglage système de la machine.
      if (process.env.TRACE_THEME) nativeTheme.themeSource = process.env.TRACE_THEME;
      openDashboard();
      if (process.argv.includes('--popover')) setTimeout(() => togglePopover(), 500);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // application de barre d'état
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
