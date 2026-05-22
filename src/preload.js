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
  pauseProcessing:  ()     => ipcRenderer.invoke('process:pause'),
  resumeProcessing: ()     => ipcRenderer.invoke('process:resume'),

  // ── Database queries ───────────────────────────────────────────────────────
  getPhotos:        (opts) => ipcRenderer.invoke('db:get-photos', opts),
  getStats:         ()     => ipcRenderer.invoke('db:get-stats'),
  getPhotoPaths:    (opts) => ipcRenderer.invoke('db:get-photo-paths', opts),
  hasData:          ()     => ipcRenderer.invoke('db:has-data'),
  resetData:        ()     => ipcRenderer.invoke('db:reset'),

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

  // ── Exports ────────────────────────────────────────────────────────────────
  exportGpx:        ()     => ipcRenderer.invoke('export:gpx'),
  exportPhotosCsv:  (opts) => ipcRenderer.invoke('export:photos-csv', opts),
  exportCopyFixed:  (opts) => ipcRenderer.invoke('export:copy-fixed', opts),
  cancelCopy:       ()     => ipcRenderer.invoke('export:cancel-copy'),
  exportMapHtml:    ()     => ipcRenderer.invoke('export:map-html'),

  // ── Utilities ──────────────────────────────────────────────────────────────
  heicToJpeg:          (opts) => ipcRenderer.invoke('util:heic-to-jpeg', opts),
  generateThumbnails:  ()     => ipcRenderer.invoke('util:generate-thumbnails'),
  getExtensions:       ()     => ipcRenderer.invoke('db:get-extensions'),

  onCopyProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('export:copy-progress', handler);
    return () => ipcRenderer.removeListener('export:copy-progress', handler);
  },
  onCopyDone: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('export:copy-done', handler);
    return () => ipcRenderer.removeListener('export:copy-done', handler);
  },
  onThumbProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('util:thumb-progress', handler);
    return () => ipcRenderer.removeListener('util:thumb-progress', handler);
  },

  // ── Licence ────────────────────────────────────────────────────────────────
  getLicenceStatus:  ()     => ipcRenderer.invoke('licence:get-status'),
  activateLicence:   (opts) => ipcRenderer.invoke('licence:activate', opts),
  deactivateLicence: ()     => ipcRenderer.invoke('licence:deactivate'),

  showConfirmDialog: (opts) => ipcRenderer.invoke('util:show-confirm-dialog', opts),

  // ── Working folder ─────────────────────────────────────────────────────────
  getWorkingFolder:    ()      => ipcRenderer.invoke('settings:get-working-folder'),
  setWorkingFolder:    (opts)  => ipcRenderer.invoke('settings:set-working-folder', opts),
  browseWorkingFolder: ()      => ipcRenderer.invoke('settings:browse-working-folder'),

  // ── Albums ─────────────────────────────────────────────────────────────────────
  getAlbums:      ()     => ipcRenderer.invoke('db:get-albums'),
  getAlbumPhotos: (opts) => ipcRenderer.invoke('db:get-album-photos', opts),

  // ── Trips ───────────────────────────────────────────────────────────────────
  getClusters:      ()     => ipcRenderer.invoke('trips:get-clusters'),
  getAllClusters:   ()     => ipcRenderer.invoke('trips:get-all-clusters'),
  fixFallbackNames: ()     => ipcRenderer.invoke('trips:fix-fallback-names'),
  searchLocation:   (opts) => ipcRenderer.invoke('trips:search-location', opts),
  geocodeBatch:     (opts) => ipcRenderer.invoke('trips:geocode-batch', opts),
  computeTrips:     (opts) => ipcRenderer.invoke('trips:compute', opts),
  getTrips:         (opts) => ipcRenderer.invoke('trips:get-trips', opts),
  getTripDetail:    (opts) => ipcRenderer.invoke('trips:get-trip-detail', opts),
  getTripThumbs:    (opts) => ipcRenderer.invoke('trips:get-trip-thumbs', opts),
  resetTrips:       ()     => ipcRenderer.invoke('trips:reset'),

  onTripsEvent: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('trips:event', handler);
    return () => ipcRenderer.removeListener('trips:event', handler);
  },

  onGeocodeResult: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('trips:geocode-result', handler);
    return () => ipcRenderer.removeListener('trips:geocode-result', handler);
  },

  onTripNameUpdate: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('trips:name-update', handler);
    return () => ipcRenderer.removeListener('trips:name-update', handler);
  },

});
