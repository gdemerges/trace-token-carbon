'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Pont IPC. `contextIsolation` est actif et le renderer n'a AUCUN accès à Node :
 * il ne voit que cette surface, explicitement énumérée. Les logs analysés
 * contiennent le code et les conversations de l'utilisateur — le renderer ne
 * doit jamais pouvoir toucher au système de fichiers.
 */
contextBridge.exposeInMainWorld('trace', {
  getSnapshot: (options) => ipcRenderer.invoke('trace:snapshot', options),
  refresh: () => ipcRenderer.invoke('trace:refresh'),
  getConfig: () => ipcRenderer.invoke('trace:config:get'),
  getStrings: () => ipcRenderer.invoke('trace:strings'),
  setConfig: (patch) => ipcRenderer.invoke('trace:config:set', patch),
  setKey: (provider, value) => ipcRenderer.invoke('trace:key:set', { provider, value }),
  calibrate: (gaugeId, percent) => ipcRenderer.invoke('trace:calibrate', { gaugeId, percent }),
  openDashboard: () => ipcRenderer.invoke('trace:dashboard:open'),
  closePopover: () => ipcRenderer.invoke('trace:popover:close'),
  exportCsv: (options) => ipcRenderer.invoke('trace:export', options),
  shortcutStatus: () => ipcRenderer.invoke('trace:shortcut:status'),
  openExternal: (url) => ipcRenderer.invoke('trace:external', url),
  quit: () => ipcRenderer.invoke('trace:quit'),
  onUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('trace:update', handler);
    return () => ipcRenderer.removeListener('trace:update', handler);
  },
});
