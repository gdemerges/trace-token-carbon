// Pont IPC — l'exact équivalent de `src/main/preload.js`, au-dessus de Tauri.
//
// Le renderer n'a PAS été réécrit : il continue d'appeler `window.trace.*`
// comme sous Electron, et les deux implémentations coexistent le temps de la
// migration. C'est ce qui permet de comparer les deux rendus côte à côte au
// lieu de traduire à l'aveugle.
//
// Ce script est injecté par la webview avant tout script de la page, donc hors
// de portée de la politique de sécurité du contenu — laquelle continue de
// s'appliquer à tout ce que la page charge elle-même.
(() => {
  const { invoke } = window.__TAURI__.core;

  // Une erreur de rendu ne se voit pas : le processus principal ne la reçoit
  // pas, et personne ne garde les outils de développement ouverts en
  // permanence. Le renderer la remonte donc lui-même, ce qui permet de
  // vérifier qu'un écran s'est peint sans faute — sans avoir à le photographier.
  const report = (kind, message, source, line) =>
    invoke('renderer_log', { kind, message: String(message), source: String(source || ''), line: line || 0 });
  window.addEventListener('error', (e) =>
    report('error', e.message, e.filename, e.lineno));
  window.addEventListener('unhandledrejection', (e) =>
    report('rejet', (e.reason && e.reason.message) || e.reason, '', 0));
  const { listen } = window.__TAURI__.event;

  window.trace = {
    getSnapshot: (options) => invoke('snapshot', { options: options ?? null }),
    refresh: () => invoke('refresh'),
    getConfig: () => invoke('config_get'),
    getStrings: () => invoke('strings'),
    setConfig: (patch) => invoke('config_set', { patch }),
    setKey: (provider, value) => invoke('key_set', { provider, value }),
    calibrate: (gaugeId, percent) => invoke('calibrate', { gaugeId, percent }),
    openDashboard: () => invoke('dashboard_open'),
    closePopover: () => invoke('popover_close'),
    exportCsv: (options) => invoke('export_csv', { options: options ?? null }),
    shortcutStatus: () => invoke('shortcut_status'),
    openExternal: (url) => invoke('open_external', { url }),
    quit: () => invoke('quit'),
    onUpdate: (cb) => {
      // `listen` rend une promesse de fonction de désabonnement, là où
      // Electron la rendait directement. On garde la signature synchrone
      // attendue par le renderer en refermant sur la promesse.
      const pending = listen('trace:update', (e) => cb(e.payload));
      return () => pending.then((un) => un());
    },
  };
})();
