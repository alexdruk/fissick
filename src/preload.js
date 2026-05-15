// src/preload.js — contextBridge exposure
// This is the only interface between the renderer (untrusted) and the main process.
// Keep it minimal: only expose what the renderer actually needs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tt', {

  // ── Dialogs ────────────────────────────────────────────────────────────────
  selectZips:   () => ipcRenderer.invoke('dialog:select-zips'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),

  // ── Processing ─────────────────────────────────────────────────────────────
  startProcessing:  (opts) => ipcRenderer.invoke('process:start', opts),
  cancelProcessing: ()     => ipcRenderer.invoke('process:cancel'),

  // ── Database queries ───────────────────────────────────────────────────────
  getPhotos: (opts) => ipcRenderer.invoke('db:get-photos', opts),
  getStats:  ()     => ipcRenderer.invoke('db:get-stats'),
  hasData:   ()     => ipcRenderer.invoke('db:has-data'),
  resetData: ()     => ipcRenderer.invoke('db:reset'),

  // ── Location (Module 2) ────────────────────────────────────────────────────
  getLocationStats: ()     => ipcRenderer.invoke('db:get-location-stats'),
  getLocations:     (opts) => ipcRenderer.invoke('db:get-locations', opts),

  // ── Event subscriptions ────────────────────────────────────────────────────
  // Returns an unsubscribe function — call it to clean up the listener.
  onProcessEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('process:event', handler);
    return () => ipcRenderer.removeListener('process:event', handler);
  },

  // ── Licence ────────────────────────────────────────────────────────────────
  getLicenceStatus:  ()     => ipcRenderer.invoke('licence:get-status'),
  activateLicence:   (opts) => ipcRenderer.invoke('licence:activate', opts),
  deactivateLicence: ()     => ipcRenderer.invoke('licence:deactivate'),

});
