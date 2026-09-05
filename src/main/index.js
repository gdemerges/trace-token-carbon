'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, shell, dialog, safeStorage, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const core = require('../core');
const { drawTrayIcon } = require('./icon');
const { startUpdateChecks, RELEASES_PAGE } = require('./update');
const present = require('./present');
const i18n = require('../i18n');

const isDev = process.argv.includes('--dev');

let tray = null;
let popover = null;
let dashboard = null;
let refreshTimer = null;

/** Dernier instantané calculé, partagé par le popover et le tableau de bord. */
let state = null;
let snap = null;
let refreshing = false;

/**
 * Période demandée par chaque fenêtre.
 *
 * Le popover et le tableau de bord regardent des périodes différentes, et le
 * tableau de bord change la sienne à la demande. Sans cette mémoire, le
 * rafraîchissement de fond recalculait un instantané avec la période PAR
 * DÉFAUT et le diffusait à tout le monde : une vue « 1 an » repassait
 * silencieusement à 30 jours au bout d'une minute, le sélecteur continuant
 * d'afficher « 1 an ». L'interface mentait sur ce qu'elle montrait.
 */
const viewRange = new Map(); // webContents.id -> période demandée

/** Seuils déjà notifiés, par fenêtre. Volatil : rien à persister. */
let alertState = {};

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
      throw new Error(i18n.t('main.noKeychain'));
    }
    cfg[field] = { enc: safeStorage.encryptString(value).toString('base64') };
  }
  core.store.saveConfig(cfg);
}

// ---------------------------------------------------------------------------
// Rafraîchissement
// ---------------------------------------------------------------------------

/**
 * Fixe la langue du processus principal.
 *
 * Le renderer, lui, reçoit son catalogue par IPC : il n'a pas accès au système
 * de fichiers, et une seule source de vérité vaut mieux que deux catalogues à
 * garder synchronisés.
 */
function applyLocale() {
  return i18n.setLocale(i18n.resolveLocale(core.store.loadConfig().locale, app.getLocale()));
}

async function refresh(reason = 'timer') {
  if (refreshing) return snap;
  refreshing = true;
  try {
    // L'application est le propriétaire de l'index tant qu'elle tourne : une
    // CLI lancée en parallèle lira les mêmes chiffres sans réécrire par-dessus
    // le cycle en cours. La marque est rafraîchie à chaque tour, pour qu'un
    // arrêt brutal ne condamne pas le fichier plus de quelques minutes.
    core.store.claimOwnership();
    const config = loadConfigWithKeys();
    state = await core.refresh({ config, index: state ? state.index : undefined });
    state.config = config;
    snap = core.snapshot(state, { days: config.defaultRangeDays });
    updateTray();
    notifyThresholds(config);
    broadcast();
    return snap;
  } catch (e) {
    console.error(i18n.t('main.refreshFailed'), e);
    // On garde le dernier instantané valide : mieux vaut des chiffres un peu
    // datés qu'une interface vide.
    if (snap) snap.staleError = e.message;
    broadcast();
    return snap;
  } finally {
    refreshing = false;
  }
}

/** Chaque fenêtre reçoit un instantané calculé pour SA période. */
/**
 * Prévient quand une fenêtre franchit un seuil.
 *
 * C'est la raison d'être de l'outil : savoir qu'on approche d'une limite
 * AVANT de la heurter. Le moteur (core/alerts.js) refuse d'alerter sur une
 * échelle approximative — une alerte fausse ferait perdre confiance dans
 * toutes les autres.
 */
function notifyThresholds(config) {
  if (!snap || !Notification.isSupported()) return;
  const { notifications, state: nextAlertState } = core.alerts.evaluate(snap.gauges, config, alertState);
  alertState = nextAlertState;

  for (const n of notifications) {
    const notif = new Notification({
      title: n.title,
      body: n.body,
      urgency: n.urgency, // Linux ; ignoré ailleurs
      silent: n.urgency !== 'critical',
    });
    notif.on('click', () => openDashboard());
    notif.show();
  }
}

/** Instantané destiné à la fenêtre qui le demande, dans SA période. */
function viewFor(senderId) {
  return present.snapshotFor(state, snap, viewRange.get(senderId), core.snapshot);
}

function broadcast() {
  for (const w of [popover, dashboard]) {
    if (!w || w.isDestroyed()) continue;
    w.webContents.send('trace:update', viewFor(w.webContents.id));
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

function updateTray() {
  if (!tray) return;
  const g = present.primaryGauge(snap);
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
  const title = present.trayTitle(snap, core.store.loadConfig());
  if (isMac) tray.setTitle(title ? ` ${title}` : '');
  tray.setToolTip(present.trayTooltip(snap));
}

function buildTrayMenu() {
  const cfg = core.store.loadConfig();
  return Menu.buildFromTemplate([
    { label: i18n.t('menu.gauges'), accelerator: cfg.shortcut, click: () => togglePopover() },
    { label: i18n.t('menu.dashboard'), click: () => openDashboard() },
    { type: 'separator' },
    {
      label: i18n.t('menu.trayMetric'),
      submenu: ['session', 'tokens', 'cost', 'carbon'].map((m) => ({
        label: i18n.t(`metric.${m}`),
        type: 'radio',
        checked: cfg.trayMetric === m,
        click: () => {
          core.store.saveConfig({ ...core.store.loadConfig(), trayMetric: m });
          updateTray();
        },
      })),
    },
    { label: i18n.t('menu.refreshNow'), click: () => refresh('manuel') },
    { type: 'separator' },
    { label: i18n.t('menu.quit'), click: () => app.quit() },
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
  // L'identifiant est capturé MAINTENANT : dans `closed`, la fenêtre est déjà
  // détruite et tout accès à `webContents` lève « Object has been destroyed ».
  const popoverContentsId = popover.webContents.id;

  // Un popover doit se comporter comme un popover : il disparaît dès qu'on
  // clique ailleurs. En développement on le garde ouvert pour pouvoir
  // inspecter sans qu'il se referme sous les doigts.
  popover.on('blur', () => {
    if (!isDev && popover && !popover.webContents.isDevToolsOpened()) popover.hide();
  });
  popover.on('closed', () => {
    viewRange.delete(popoverContentsId);
    popover = null;
  });
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

/**
 * Présence dans le Dock, sur macOS.
 *
 * TRACE vit dans la barre de menus : pas d'icône au repos, c'est le propre
 * d'une application d'arrière-plan. Mais dès qu'une vraie fenêtre est ouverte,
 * l'absence d'icône devient un piège — le tableau de bord n'est plus atteignable
 * au ⌘Tab, et disparaît définitivement s'il passe derrière une autre fenêtre.
 * L'icône n'apparaît donc que tant qu'une fenêtre est ouverte.
 */
function syncDockVisibility() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const hasWindow = dashboard && !dashboard.isDestroyed() && dashboard.isVisible();
  if (hasWindow) app.dock.show();
  else app.dock.hide();
}

function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    syncDockVisibility();
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
  // En développement, la console du renderer remonte dans le terminal. Une
  // erreur de rendu s'y perdait autrement : le processus principal ne la voit
  // pas, et personne ne garde les outils de développement ouverts en
  // permanence.
  if (isDev) {
    dashboard.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
    });
  }
  // Idem : capturé à la création, pas lu à la fermeture.
  const dashboardContentsId = dashboard.webContents.id;
  if (isDev) {
    dashboard.setPosition(60, 60, false);
    // Garde la fenêtre au premier plan pendant le développement : sans cela,
    // toute capture d'écran attrape ce qui traîne au-dessus.
    dashboard.setAlwaysOnTop(true, 'floating');
  }
  dashboard.on('closed', () => {
    viewRange.delete(dashboardContentsId);
    dashboard = null;
    syncDockVisibility();
  });
  dashboard.on('hide', syncDockVisibility);
  dashboard.on('show', syncDockVisibility);
  dashboard.once('ready-to-show', syncDockVisibility);
  if (process.argv.includes('--devtools')) dashboard.webContents.openDevTools({ mode: 'detach' });
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const cfg = core.store.loadConfig();
  const accel = cfg.shortcut || 'CommandOrControl+Alt+T';
  let ok = false;
  try {
    ok = globalShortcut.register(accel, togglePopover);
  } catch {
    ok = false; // accélérateur syntaxiquement invalide
  }
  if (!ok) console.warn(i18n.t('main.shortcutRefused', { accel }));
  return ok;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('trace:snapshot', async (e, options = {}) => {
    if (!snap) await refresh('demande initiale');
    // La période demandée est mémorisée pour cette fenêtre : les diffusions
    // suivantes la respecteront au lieu de retomber sur la valeur par défaut.
    if (options.days != null) viewRange.set(e.sender.id, options.days);
    return viewFor(e.sender.id);
  });
  ipcMain.handle('trace:refresh', async (e) => {
    // Une demande explicite passe outre la cadence d'interrogation : c'est
    // précisément ce qu'attend quelqu'un qui clique sur « Actualiser ».
    require('../core/collectors/anthropic-oauth').forceRefresh();
    await refresh('manuel');
    return viewFor(e.sender.id);
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
    // La langue change des libellés calculés côté cœur (jauges, sources) : on
    // la pose AVANT le rafraîchissement, sinon l'instantané renvoyé porterait
    // encore les anciens.
    if (patch.locale !== undefined) {
      applyLocale();
      buildAppMenu();
    }
    let shortcutOk = true;
    if (patch.shortcut) shortcutOk = registerShortcut();
    if (patch.refreshIntervalSec) scheduleRefresh();
    if (patch.launchAtLogin != null && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    await refresh('réglages');
    // Le renderer teste `shortcutOk` pour afficher « raccourci refusé ». Tant
    // que ce handler renvoyait `true`, la branche était morte et un raccourci
    // déjà pris par une autre application restait silencieusement inopérant.
    return { ok: true, shortcutOk };
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
    if (!state) return { ok: false, error: i18n.t('main.notLoaded') };
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
  ipcMain.handle('trace:export', async (e, options = {}) => {
    if (!state) return { ok: false, error: i18n.t('main.nothingToExport') };

    const days = options.days != null ? options.days : viewRange.get(e.sender.id);
    const view = core.snapshot(state, { days });
    const rows = core.exportRows(state.events, {
      from: view.range.from,
      to: view.range.to,
      carbon: (view.config.carbon || {}),
    });
    if (rows.length <= 1) return { ok: false, error: i18n.t('main.emptyRange') };

    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: i18n.t('main.exportTitle'),
      defaultPath: `trace-${stamp}-${view.range.days}j.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    // L'annexe part avec les données, dans un second fichier : un tableau de
    // grammes sans les facteurs qui l'ont produit n'est pas vérifiable, et
    // personne ne pense à l'exporter séparément au moment de rédiger.
    const annexPath = filePath.replace(/\.csv$/i, '') + '-methodologie.csv';
    const annex = core.methodologyRows({ gridKey: (view.config.carbon || {}).gridKey });

    try {
      // BOM UTF-8 : sans lui, Excel sous Windows massacre les accents.
      fs.writeFileSync(filePath, '\ufeff' + core.toCsv(rows), 'utf8');
      fs.writeFileSync(annexPath, '\ufeff' + core.toCsv(annex), 'utf8');
    } catch (err) {
      return { ok: false, error: i18n.t('main.writeFailed', { message: err.message }) };
    }
    return { ok: true, filePath, annexPath, rows: rows.length - 1 };
  });

  // Catalogue de traduction : le renderer n'a pas accès aux fichiers, il le
  // reçoit ici, une fois, au chargement.
  ipcMain.handle('trace:strings', () => i18n.currentStrings());

  ipcMain.handle('trace:shortcut:status', () => ({
    accelerator: core.store.loadConfig().shortcut,
    registered: globalShortcut.isRegistered(core.store.loadConfig().shortcut || ''),
  }));
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
      { label: i18n.t('menu.edit'), submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: i18n.t('menu.window'), submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'reload' }] },
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

  // Clic sur l'icône du Dock alors que la fenêtre est fermée : on la rouvre,
  // comme le ferait n'importe quelle application macOS.
  app.on('activate', () => openDashboard());

  app.whenReady().then(async () => {
    // Au démarrage, aucune fenêtre n'est ouverte : pas d'icône dans le Dock.
    syncDockVisibility();

    applyLocale();
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

    // Vérification de version : jamais de téléchargement, une notification qui
    // ouvre la page si on la clique. Voir `src/main/update.js` pour ce que
    // l'appel expose exactement.
    startUpdateChecks({
      version: app.getVersion(),
      isEnabled: () => core.store.loadConfig().checkUpdates !== false,
      notify: (found) => {
        if (!Notification.isSupported()) return;
        const n = new Notification({
          title: i18n.t('main.updateTitle', { version: found.version }),
          body: i18n.t('main.updateBody', { current: app.getVersion() }),
          silent: true,
        });
        n.on('click', () => shell.openExternal(found.url || RELEASES_PAGE));
        n.show();
      },
    });

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
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    core.store.releaseOwnership();
  });
}
