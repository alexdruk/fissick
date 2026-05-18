// src/renderer/app.js — Fissick renderer
// Vanilla JS. No frameworks. No build step.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  view:        'import',
  source:      {},
  processing:  false,
  unsubscribe: null,
  filter:      'all',
  offset:      0,
  limit:       60,
  dateFrom:    null,
  dateTo:      null,
  ext:         null, // file extension filter e.g. 'heic', 'jpg', null = all
  // ── Selection ──────────────────────────────────────────────────────────────
  // selectedPaths: Set of file_path strings. Lives in memory, not in the DOM.
  // Updated by checkbox clicks, filter-tab bulk selection, and select-all.
  selectedPaths: new Set(),
};

// ── View switching ─────────────────────────────────────────────────────────────
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name)?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const sbMap = { import: 'sb-import', processing: 'sb-process', results: 'sb-results' };
  document.getElementById(sbMap[name])?.classList.add('active');
  const labels = { import: 'Import', processing: 'Processing', results: 'Results' };
  document.getElementById('tb-phase').textContent = labels[name] || '';
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
document.getElementById('sb-import').addEventListener('click', () => showView('import'));
document.getElementById('sb-results').addEventListener('click', async () => {
  await loadResults();
  showView('results');
});

// ── Import view ────────────────────────────────────────────────────────────────
const btnStart       = document.getElementById('btn-start');
const zipFeedback    = document.getElementById('zip-feedback');
const folderFeedback = document.getElementById('folder-feedback');

function showFeedback(el, text, isError = false) {
  el.textContent = text;
  el.className = 'source-feedback' + (isError ? ' error' : '');
  el.style.display = text ? 'block' : 'none';
}

function updateStartButton() {
  const ready = state.source?.zipPaths?.length > 0 || !!state.source?.extractedFolder;
  btnStart.style.display = ready ? 'block' : 'none';
}

document.getElementById('btn-select-zips').addEventListener('click', async (e) => {
  e.stopPropagation();
  const paths = await window.tt.selectZips();
  if (paths.length > 0) {
    state.source = { ...state.source, zipPaths: paths };
    showFeedback(zipFeedback, paths.map(p => p.split('/').pop()).join('\n'));
    updateStartButton();
  }
});

document.getElementById('btn-select-folder').addEventListener('click', async () => {
  const folder = await window.tt.selectFolder();
  if (folder) {
    state.source = { ...state.source, extractedFolder: folder };
    showFeedback(folderFeedback, '📁 ' + folder);
    updateStartButton();
  }
});

document.getElementById('btn-manual-path').addEventListener('click', () => {
  const val = document.getElementById('manual-path-input').value.trim();
  if (val) {
    state.source = { ...state.source, extractedFolder: val };
    showFeedback(folderFeedback, '📁 ' + val);
    updateStartButton();
  }
});

document.getElementById('manual-path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-manual-path').click();
});

btnStart.addEventListener('click', startProcessing);

// ── Processing ─────────────────────────────────────────────────────────────────
async function startProcessing() {
  if (!state.source?.zipPaths?.length && !state.source?.extractedFolder) return;
  state.processing = true;

  // Always wipe previous results before starting a new run
  await window.tt.resetData();
  const list = document.getElementById('photo-list');
  if (list) list.innerHTML = '';
  document.getElementById('results-stats-row').innerHTML = '';
  showTrialBanner(false);

  // Hide Map tab — will re-appear if location data is found in this run
  const mapTab = document.getElementById('tab-map');
  if (mapTab) mapTab.style.display = 'none';
  _showMapPanel(false);

  resetProcessingUI();
  showView('processing');

  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = window.tt.onProcessEvent(handleProcessEvent);

  await window.tt.startProcessing({
    zipPaths:        state.source.zipPaths        || [],
    extractedFolder: state.source.extractedFolder || null,
  });
}

function resetProcessingUI() {
  document.getElementById('phase-badge').className = 'phase-badge processing';
  document.getElementById('phase-badge').textContent = 'Processing';
  document.getElementById('phase-message').textContent = 'Starting…';
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-text').textContent = '—';
  document.getElementById('progress-eta').textContent = '';
  document.getElementById('stat-processed').textContent = '0';
  document.getElementById('stat-fixed').textContent     = '0';
  document.getElementById('stat-matched').textContent   = '0';
  document.getElementById('stat-failed').textContent    = '0';
  document.getElementById('log-output').innerHTML       = '';
}

function logMsg(text, type = 'ok') {
  const log = document.getElementById('log-output');
  if (!log) return;
  const el = document.createElement('div');
  el.className = 'log-' + type;
  const ts = new Date().toLocaleTimeString('en', { hour12: false });
  el.textContent = `[${ts}] ${text}`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function handleProcessEvent(msg) {
  switch (msg.type) {

    case 'status': {
      // Location worker phases go to the log only — they must not overwrite
      // the main photos progress badge or trigger the done/error navigation.
      const isLocationPhase = msg.phase && msg.phase.startsWith('location-');

      if (!isLocationPhase) {
        const badge = document.getElementById('phase-badge');
        if (badge) {
          badge.className = 'phase-badge ' + (msg.phase || 'processing');
          badge.textContent = msg.phase || '';
        }
        const msgEl = document.getElementById('phase-message');
        if (msgEl) msgEl.textContent = msg.message || '';
      }

      logMsg(msg.message, (msg.phase === 'error' || msg.phase === 'location-error') ? 'err' : 'ok');

      if (!isLocationPhase && (msg.phase === 'done' || msg.phase === 'error')) {
        state.processing = false;
        if (msg.phase === 'done') {
          setTimeout(async () => {
            await loadResults();
            showView('results');
          }, 1000);
        }
      }
      break;
    }

    case 'extract-progress':
      logMsg(`Extracted ${msg.extracted.toLocaleString()} files…`, 'dim');
      break;

    case 'manifest': {
      const m = msg.manifest;
      const found = [];
      if (m.photos)                       found.push('Photos ✓');
      if (m.recordsJson || m.semanticDir) found.push('Location ✓');
      if (m.mboxPath)                     found.push('Gmail ✓');
      if (m.youtubeHtml)                  found.push('YouTube ✓');
      logMsg('Detected: ' + (found.join(', ') || 'nothing'), found.length ? 'ok' : 'err');
      break;
    }

    case 'counts':
      logMsg(`Found ${msg.totalMedia.toLocaleString()} media files, ${msg.totalJson.toLocaleString()} sidecars.${msg.duplicates > 0 ? ` (${msg.duplicates} duplicates skipped)` : ''}`, 'ok');
      break;

    case 'progress': {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('stat-processed', msg.processed.toLocaleString());
      set('stat-fixed',     msg.fixed.toLocaleString());
      set('stat-matched',   msg.matched.toLocaleString());
      set('stat-failed',    msg.failed.toLocaleString());
      const bar = document.getElementById('progress-bar');
      if (bar) bar.style.width = msg.percent + '%';
      set('progress-text', `${msg.processed.toLocaleString()} / ${msg.total.toLocaleString()}`);
      if (msg.etaSecs > 0) set('progress-eta', 'ETA: ' + formatEta(msg.etaSecs));
      break;
    }

    case 'summary':
      updateSidebarStats({ total: msg.processed, fixed: msg.fixed, unmatched: msg.failed });
      break;

    // ── Location events ────────────────────────────────────────────────────
    case 'location-progress':
      // Could drive a second progress bar — for now just keep the log quiet
      // (the status messages already log the phase transitions)
      break;

    case 'location-summary':
      // Pass to the map module — this also reveals the Map tab
      LocationMap.onLocationSummary(msg);
      // Update sidebar Locations stat
      if (msg.total > 0) {
        const el = document.getElementById('sb-locations');
        if (el) el.textContent = msg.total.toLocaleString();
      }
      break;

    case 'trial-limit-hit':
      handleTrialLimitHit();
      break;

    case 'done':
      if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
      break;
  }
}

document.getElementById('btn-back-processing').addEventListener('click', async () => {
  await window.tt.cancelProcessing();
  state.processing = false;
  showView('import');
});

// ── Results ────────────────────────────────────────────────────────────────────
async function loadResults() {
  state.offset = 0;
  state.filter = 'all';
  document.querySelectorAll('.filter-tab').forEach((t, i) => {
    // Keep the Map tab's display state; only reset the active class
    if (t.dataset.filter !== 'map') t.classList.toggle('active', i === 0);
    else t.classList.remove('active');
  });
  // Make sure the first non-map tab is active
  const firstTab = document.querySelector('.filter-tab:not([data-filter="map"])');
  if (firstTab) firstTab.classList.add('active');

  _showMapPanel(false); // always start on photo list
  state.selectedPaths.clear();
  state.filteredTotal = 0;
  await refreshLicenceStatus();
  await refreshStats();
  await populateExtFilter();
  await loadPhotoPage(true);
  _updateSelectionUI();

  // Load location stats to update sidebar, reveal Map tab, and show/hide location exports
  try {
    const locStats = await window.tt.getLocationStats();
    const hasLoc   = locStats && locStats.total > 0;

    // Map tab
    const mapTab = document.getElementById('tab-map');
    if (mapTab) mapTab.style.display = hasLoc ? '' : 'none';

    // Sidebar stat
    const sbLoc = document.getElementById('sb-locations');
    if (sbLoc) sbLoc.textContent = hasLoc ? locStats.total.toLocaleString() : '—';

    // Location export buttons — only meaningful when there is location data
    const btnGpx = document.getElementById('btn-export-gpx');
    const btnMap = document.getElementById('btn-export-map-html');
    if (btnGpx) btnGpx.style.display = hasLoc ? '' : 'none';
    if (btnMap) btnMap.style.display = hasLoc ? '' : 'none';
  } catch {}
}

async function refreshStats() {
  const stats = await window.tt.getStats();
  if (!stats) return;
  updateSidebarStats(stats);

  const trialHit = !licenceStatus.licensed && stats.trial_limited > 0;
  showTrialBanner(trialHit);

  const fixRate = stats.total > 0 ? Math.round((stats.fixed / stats.total) * 100) : 0;
  let range = '';
  if (stats.earliest_ts && stats.latest_ts) {
    range = `<div class="stat-pill"><span class="sp-val">${new Date(stats.earliest_ts).getFullYear()}–${new Date(stats.latest_ts).getFullYear()}</span> date range</div>`;
    // Populate year selects now that we have the actual range
    populateDateRangeSelects(stats.earliest_ts, stats.latest_ts);
  }
  document.getElementById('results-stats-row').innerHTML = `
    <div class="stat-pill green"><span class="sp-val">${(stats.fixed||0).toLocaleString()}</span> EXIF fixed (${fixRate}%)</div>
    <div class="stat-pill"><span class="sp-val">${(stats.total||0).toLocaleString()}</span> total photos</div>
    <div class="stat-pill ${stats.unmatched > 0 ? 'amber' : 'green'}"><span class="sp-val">${(stats.unmatched||0).toLocaleString()}</span> no sidecar</div>
    <div class="stat-pill"><span class="sp-val">${(stats.with_gps||0).toLocaleString()}</span> with GPS</div>
    ${range}
  `;
}

async function loadPhotoPage(replace = false) {
  try {
    const result = await window.tt.getPhotos({ offset: state.offset, limit: state.limit, filter: state.filter, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext });
    if (!result) return;

    const { photos = [], total = 0 } = result;
    const list = document.getElementById('photo-list');
    if (!list) return;
    if (replace) list.innerHTML = '';

    if (photos.length === 0 && replace) {
      list.innerHTML = '<div style="padding:40px 36px;color:var(--dim);font-size:13px">No photos found.</div>';
    }

    photos.forEach(photo => {
      try { list.appendChild(renderPhotoRow(photo)); }
      catch (e) { console.error('renderPhotoRow error:', e, photo); }
    });

    const shown = state.offset + photos.length;
    state.filteredTotal = total; // used by _updateSelectionUI for indeterminate state
    const cl = document.getElementById('list-count-label');
    if (cl) cl.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`;

    const more = document.getElementById('btn-load-more');
    if (more) {
      if (shown < total) { more.style.display = 'inline-block'; state.offset += photos.length; }
      else more.style.display = 'none';
    }
  } catch (err) {
    console.error('loadPhotoPage error:', err);
  }
}

function renderPhotoRow(photo) {
  const row = document.createElement('div');
  row.className = 'photo-row';

  // Checkbox
  const cb = document.createElement('div');
  cb.className = 'photo-cb';
  cb.role = 'checkbox';
  if (state.selectedPaths.has(photo.file_path)) cb.classList.add('checked');

  cb.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.selectedPaths.has(photo.file_path)) {
      state.selectedPaths.delete(photo.file_path);
      cb.classList.remove('checked');
    } else {
      state.selectedPaths.add(photo.file_path);
      cb.classList.add('checked');
    }
    _updateSelectionUI();
  });

  // Thumbnail
  const ext = (photo.filename.split('.').pop() || '').toLowerCase();
  const VIDEO_EXTS = ['mov','mp4','m4v','avi','mkv','3gp'];
  const isImage = ['jpg','jpeg','png','gif','webp','heic','heif','bmp'].includes(ext);
  const isVideo = VIDEO_EXTS.includes(ext);
  const thumbSrc = photo.thumbnail_path || photo.file_path;

  const thumbWrap = document.createElement('div');
  thumbWrap.style.cssText = 'display:contents';
  if (isImage) {
    thumbWrap.innerHTML = `<img class="photo-thumb" src="local://${thumbSrc}" loading="lazy" alt=""
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="photo-thumb-placeholder" style="display:none">🖼️</div>`;
  } else if (isVideo) {
    thumbWrap.innerHTML = `<div class="photo-thumb-placeholder photo-thumb-video">🎬<span class="thumb-video-label">${ext.toUpperCase()}</span></div>`;
  } else {
    thumbWrap.innerHTML = `<div class="photo-thumb-placeholder">📄</div>`;
  }

  // Info cell
  const dateStr = photo.date_ts
    ? new Date(photo.date_ts).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' })
    : '—';
  const infoDiv = document.createElement('div');
  infoDiv.className = 'photo-info';
  infoDiv.innerHTML = `
    <div class="photo-name" title="${photo.filename}">${photo.filename}</div>
    <div class="photo-meta">${dateStr}${photo.lat != null ? ` · lat ${photo.lat.toFixed(4)}, lng ${photo.lng.toFixed(4)}` : ''}</div>
  `;

  // Tag
  let tagHtml;
  if (photo.date_ts == null) {
    tagHtml = `<span class="tag tag-none">No date</span>`;
  } else if (photo.exif_written) {
    tagHtml = photo.date_source === 'filename'
      ? `<span class="tag tag-fname">Filename date</span>`
      : `<span class="tag tag-fixed">EXIF fixed</span>`;
  } else {
    tagHtml = `<span class="tag tag-found">Date found</span>`;
  }
  const tagSpan = document.createElement('span');
  tagSpan.innerHTML = tagHtml;

  // GPS badge
  const gpsSpan = document.createElement('span');
  gpsSpan.innerHTML = photo.lat != null
    ? `<span class="tag tag-gps">GPS</span>`
    : '';

  // Source label
  const sourceLabel = { 'sidecar': 'sidecar', 'filename': 'filename', 'none': 'no source' }[photo.date_source] || (photo.date_source || '—');
  const srcSpan = document.createElement('span');
  srcSpan.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--dim)';
  srcSpan.textContent = sourceLabel;

  // Assemble row — direct children match the 6-column grid
  row.appendChild(cb);
  // thumbWrap uses display:contents so its child img/div become direct grid items
  row.appendChild(thumbWrap);
  row.appendChild(infoDiv);
  row.appendChild(tagSpan);
  row.appendChild(gpsSpan);
  row.appendChild(srcSpan);

  // Thumbnail or video placeholder click → lightbox
  const thumbImg = row.querySelector('.photo-thumb');
  const thumbVid = row.querySelector('.photo-thumb-video');
  const clickTarget = thumbImg || thumbVid;
  if (clickTarget) {
    clickTarget.addEventListener('click', async (e) => {
      e.stopPropagation();
      await openLightbox(photo);
    });
  }

  return row;
}

document.getElementById('btn-back-results').addEventListener('click', async () => {
  await window.tt.resetData();
  state.source = {};
  state.dateFrom = null;
  state.dateTo   = null;
  state.ext      = null;
  const extSel = document.getElementById('ext-filter-select');
  if (extSel) extSel.value = '';
  const fromMonthSelBack = document.getElementById('dr-from-month');
  const toMonthSelBack   = document.getElementById('dr-to-month');
  if (fromMonthSelBack) fromMonthSelBack.value = '';
  if (toMonthSelBack)   toMonthSelBack.value   = '';
  document.getElementById('dr-clear').style.display = 'none';
  showFeedback(zipFeedback, '');
  showFeedback(folderFeedback, '');
  document.getElementById('manual-path-input').value = '';
  btnStart.style.display = 'none';
  updateSidebarStats({ total: 0, fixed: 0, unmatched: 0, with_gps: 0 });
  _showMapPanel(false);
  const mapTab = document.getElementById('tab-map');
  if (mapTab) mapTab.style.display = 'none';
  showView('import');
});

// ── Filter tabs (including Map tab) ───────────────────────────────────────────
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    if (tab.dataset.filter === 'map') {
      _showMapPanel(true);
      LocationMap.onTabActivated();
    } else {
      _showMapPanel(false);
      const newFilter = tab.dataset.filter;

      // ── Clear selection on every tab switch ─────────────────────────────
      state.selectedPaths.clear();
      // Reset date range on tab switch
      state.dateFrom = null;
      state.dateTo   = null;
      // Reset ext filter on tab switch
      state.ext = null;
      const extSel2 = document.getElementById('ext-filter-select');
      if (extSel2) extSel2.value = '';
      const fmSel = document.getElementById('dr-from-month');
      const tmSel = document.getElementById('dr-to-month');
      if (fmSel) fmSel.value = '';
      if (tmSel) tmSel.value = '';
      document.getElementById('dr-clear').style.display = 'none';

      // If a specific filter tab (not ALL), bulk-select all paths for that filter
      if (newFilter !== 'all') {
        const paths = await window.tt.getPhotoPaths({ filter: newFilter, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext });
        paths.forEach(p => state.selectedPaths.add(p));
      }

      state.filter = newFilter;
      state.offset = 0;
      await loadPhotoPage(true);
      _updateSelectionUI();
    }
  });
});

document.getElementById('btn-load-more').addEventListener('click', () => loadPhotoPage(false));

// ── Selection UI ───────────────────────────────────────────────────────────────

// Updates the select-all checkbox state and "N selected" label.
// Also enables/disables the photo export buttons.
function _updateSelectionUI() {
  const n        = state.selectedPaths.size;
  const selCount = document.getElementById('sel-count');
  if (selCount) selCount.textContent = n.toLocaleString();

  // Select-all checkbox: checked / indeterminate / unchecked
  // We compare against the current visible total from the list footer
  const allCb = document.getElementById('select-all-cb');
  if (allCb) {
    allCb.classList.remove('checked', 'indeterminate');
    if (n === 0) {
      // unchecked — no class
    } else {
      // Check if selection == full filtered set by comparing to the DB total
      // We cache the total in state when loadPhotoPage runs
      if (state.filteredTotal > 0 && n >= state.filteredTotal) {
        allCb.classList.add('checked');
      } else {
        allCb.classList.add('indeterminate');
      }
    }
  }

  // Enable/disable photo export buttons
  const csvBtn  = document.getElementById('btn-export-csv');
  const copyBtn = document.getElementById('btn-export-copy');
  const hasSelection = n > 0;
  if (csvBtn)  csvBtn.disabled  = !hasSelection;
  if (copyBtn) copyBtn.disabled = !hasSelection;
}

// Select-all / deselect-all
document.getElementById('select-all-cb').addEventListener('click', async () => {
  const allCb = document.getElementById('select-all-cb');
  const isChecked = allCb.classList.contains('checked');

  if (isChecked) {
    // Deselect all
    state.selectedPaths.clear();
    // Uncheck all visible rows
    document.querySelectorAll('.photo-cb').forEach(cb => cb.classList.remove('checked'));
  } else {
    // Select all paths for current filter — fetch from DB (handles > 60 visible rows)
    const paths = await window.tt.getPhotoPaths({ filter: state.filter, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext });
    state.selectedPaths = new Set(paths);
    // Check all visible rows
    document.querySelectorAll('#photo-list .photo-row').forEach(row => {
      row.querySelector('.photo-cb')?.classList.add('checked');
    });
  }

  _updateSelectionUI();
});

// ── Map panel show/hide ────────────────────────────────────────────────────────
// Sizes the map panel to fill the space below the results-header and filter-bar.
// Swaps overflow on view-results so the fixed-height map doesn't scroll.
function _showMapPanel(show) {
  const viewResults  = document.getElementById('view-results');
  const photoList    = document.getElementById('photo-list');
  const listFooter   = viewResults?.querySelector('.list-footer');
  const trialBanner  = document.getElementById('trial-banner');
  const mapPanel     = document.getElementById('map-panel');
  if (!viewResults || !mapPanel) return;

  if (show) {
    if (photoList)   photoList.style.display   = 'none';
    if (listFooter)  listFooter.style.display  = 'none';
    if (trialBanner) trialBanner.style.display = 'none';
    const selBar = document.getElementById('select-bar');
    if (selBar) selBar.style.display = 'none';
    viewResults.style.overflow = 'hidden';

    const usedH = (viewResults.querySelector('.results-header')?.offsetHeight || 0)
                + (viewResults.querySelector('.filter-bar')?.offsetHeight || 0);
    mapPanel.style.height = (viewResults.clientHeight - usedH) + 'px';
    mapPanel.classList.add('visible');
  } else {
    mapPanel.classList.remove('visible');
    viewResults.style.overflow = '';
    if (photoList)   photoList.style.display   = '';
    if (listFooter)  listFooter.style.display  = '';
    const selBar = document.getElementById('select-bar');
    if (selBar) selBar.style.display = '';
    // trial banner visibility is managed by showTrialBanner()
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function updateSidebarStats({ total, fixed, unmatched, with_gps }) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v != null ? v.toLocaleString() : '—'; };
  set('sb-total',     total);
  set('sb-fixed',     fixed);
  set('sb-unmatched', unmatched);
  set('sb-gps',       with_gps);
}

function formatEta(secs) {
  if (secs < 60)   return secs + 's';
  if (secs < 3600) return Math.round(secs / 60) + 'm';
  return Math.floor(secs / 3600) + 'h ' + Math.round((secs % 3600) / 60) + 'm';
}

// ── Licence & trial ────────────────────────────────────────────────────────────
let licenceStatus = { licensed: false, trialLimit: 100 };

async function refreshLicenceStatus() {
  licenceStatus = await window.tt.getLicenceStatus();
  return licenceStatus;
}

function showTrialBanner(show) {
  const banner = document.getElementById('trial-banner');
  if (banner) banner.style.display = show ? 'block' : 'none';
}

function handleTrialLimitHit() {
  showTrialBanner(true);
}

document.getElementById('btn-unlock').addEventListener('click', () => {
  openLicenceModal();
});

// ── Exports ────────────────────────────────────────────────────────────────────

document.getElementById('btn-export-gpx').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    const result = await window.tt.exportGpx();
    if (result.ok) {
      _exportToast(`GPX saved — ${result.trackPoints.toLocaleString()} track points, ${result.waypoints} named places.`);
    } else if (!result.canceled) {
      _exportToast('GPX export failed: ' + result.error, true);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">🗺</span> Location GPX';
  }
});

document.getElementById('btn-export-csv').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  try {
    const selectedPaths = [...state.selectedPaths];
    const result = await window.tt.exportPhotosCsv({ selectedPaths });
    if (result.ok) {
      _exportToast(`CSV saved — ${result.count.toLocaleString()} photos.`);
    } else if (!result.canceled) {
      _exportToast('CSV export failed: ' + result.error, true);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">📋</span> Photos CSV';
  }
});

document.getElementById('btn-export-copy').addEventListener('click', async (e) => {
  const btn          = e.currentTarget;
  const progressWrap = document.getElementById('copy-progress-wrap');
  const barFill      = document.getElementById('copy-progress-bar-fill');
  const barLabel     = document.getElementById('copy-progress-label');

  btn.disabled = true;

  const selectedPaths = [...state.selectedPaths];
  const result = await window.tt.exportCopyFixed({ selectedPaths });
  if (!result.ok) {
    btn.disabled = false;
    if (!result.canceled) _exportToast('Copy failed: ' + result.error, true);
    return;
  }

  // Show inline progress bar
  progressWrap.style.display = 'flex';
  barFill.style.width = '0%';
  barLabel.textContent = `Copying 0 / ${result.total.toLocaleString()}…`;

  const unsubProgress = window.tt.onCopyProgress(({ copied, skipped, failed, total, percent }) => {
    barFill.style.width = percent + '%';
    barLabel.textContent = `Copying ${(copied + skipped + failed).toLocaleString()} / ${total.toLocaleString()}…`;
  });

  const unsubDone = window.tt.onCopyDone(({ copied, skipped, failed, destDir, aborted }) => {
    unsubProgress();
    unsubDone();
    progressWrap.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">📂</span> Copy Fixed Files';

    // Reset abort button
    const abortBtn = document.getElementById('btn-copy-abort');
    if (abortBtn) { abortBtn.disabled = false; abortBtn.textContent = 'Abort'; }

    if (aborted) {
      _exportToast(`Aborted — ${copied.toLocaleString()} files copied before stopping.`, true);
    } else {
      const parts = [`${copied.toLocaleString()} files copied`];
      if (skipped) parts.push(`${skipped} not found`);
      if (failed)  parts.push(`${failed} errors`);
      _exportToast(parts.join(' · '));
    }
  });
});

document.getElementById('btn-export-map-html').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Building map…';
  try {
    const result = await window.tt.exportMapHtml();
    if (result.ok) {
      const msg = result.decimated
        ? `Map saved — ${result.exportedPts.toLocaleString()} of ${result.total.toLocaleString()} points (sampled for browser performance).`
        : `Map saved — ${result.exportedPts.toLocaleString()} points.`;
      _exportToast(msg);
    } else if (!result.canceled) {
      _exportToast('Map export failed: ' + result.error, true);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">🌐</span> Interactive Map';
  }
});

// Small transient toast shown below the export bar after an export completes
let _toastTimer = null;
function _exportToast(message, isError = false) {
  let toast = document.getElementById('export-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'export-toast';
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      font-family: var(--mono); font-size: 11px; padding: 8px 18px;
      border-radius: 20px; border: 1px solid; z-index: 200;
      transition: opacity .3s; white-space: nowrap;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background    = isError ? 'var(--red-lt)'   : 'var(--green-lt)';
  toast.style.borderColor   = isError ? 'var(--red-bdr)'  : 'var(--green-bdr)';
  toast.style.color         = isError ? 'var(--red)'      : 'var(--green)';
  toast.style.opacity       = '1';
  toast.style.display       = 'block';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 4000);
}

// ── Licence modal ──────────────────────────────────────────────────────────────
function openLicenceModal() {
  const modal = document.getElementById('licence-modal');
  document.getElementById('licence-key-input').value = '';
  document.getElementById('licence-error').style.display   = 'none';
  document.getElementById('licence-success').style.display = 'none';
  modal.classList.add('open');
  setTimeout(() => document.getElementById('licence-key-input').focus(), 50);
}

function closeLicenceModal() {
  document.getElementById('licence-modal').classList.remove('open');
}

document.getElementById('btn-modal-cancel').addEventListener('click', closeLicenceModal);

document.getElementById('btn-modal-activate').addEventListener('click', async () => {
  const key = document.getElementById('licence-key-input').value.trim();
  const errEl = document.getElementById('licence-error');
  const okEl  = document.getElementById('licence-success');

  errEl.style.display = 'none';
  okEl.style.display  = 'none';

  if (!key) {
    errEl.textContent   = 'Please enter your licence key.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-modal-activate');
  btn.textContent = 'Activating…';
  btn.disabled    = true;

  const result = await window.tt.activateLicence({ key });

  btn.textContent = 'Activate';
  btn.disabled    = false;

  if (result.ok) {
    okEl.textContent   = result.offline
      ? '✓ Activated (offline — will verify next time you connect)'
      : '✓ Activated! Thank you for purchasing Fissick.';
    okEl.style.display = 'block';
    licenceStatus.licensed = true;
    showTrialBanner(false);
    setTimeout(closeLicenceModal, 2000);
  } else {
    errEl.textContent   = result.error || 'Activation failed. Check your key and try again.';
    errEl.style.display = 'block';
  }
});

document.getElementById('licence-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLicenceModal();
});

// ── Date range filter ──────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Populate year selects from the data's actual date range.
// Called from loadResults() after refreshStats() returns.
function populateDateRangeSelects(earliestTs, latestTs) {
  if (!earliestTs || !latestTs) return;
  const firstYear = new Date(earliestTs).getFullYear();
  const lastYear  = new Date(latestTs).getFullYear();

  ['dr-from-year', 'dr-to-year'].forEach((id, idx) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    // Keep the placeholder option, rebuild the rest
    sel.innerHTML = '<option value="">Year</option>';
    for (let y = firstYear; y <= lastYear; y++) {
      const opt = document.createElement('option');
      opt.value       = y;
      opt.textContent = y;
      sel.appendChild(opt);
    }
    // Pre-select sensible defaults: from = first year, to = last year
    if (idx === 0) sel.value = firstYear;
    else           sel.value = lastYear;
  });
}

function populateDaySelect(selectId, year, month) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Day</option>';
  if (!year || !month) return;
  const daysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d;
    sel.appendChild(opt);
  }
  if (prev && parseInt(prev) <= daysInMonth) sel.value = prev;
}

// Repopulate day selects when year/month change
['dr-from-year','dr-from-month'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    populateDaySelect('dr-from-day',
      document.getElementById('dr-from-year').value,
      document.getElementById('dr-from-month').value);
  });
});
['dr-to-year','dr-to-month'].forEach(id => {
  document.getElementById(id)?.addEventListener('change', () => {
    populateDaySelect('dr-to-day',
      document.getElementById('dr-to-year').value,
      document.getElementById('dr-to-month').value);
  });
});

document.getElementById('dr-apply').addEventListener('click', async () => {
  const fromYear  = document.getElementById('dr-from-year').value;
  const fromMonth = document.getElementById('dr-from-month').value;
  const fromDay   = document.getElementById('dr-from-day').value;
  const toYear    = document.getElementById('dr-to-year').value;
  const toMonth   = document.getElementById('dr-to-month').value;
  const toDay     = document.getElementById('dr-to-day').value;

  if (fromYear) {
    const m = fromMonth ? parseInt(fromMonth) - 1 : 0;
    const d = fromDay   ? parseInt(fromDay)        : 1;
    state.dateFrom = new Date(parseInt(fromYear), m, d, 0, 0, 0, 0).getTime();
  } else {
    state.dateFrom = null;
  }

  if (toYear) {
    const m = toMonth ? parseInt(toMonth) - 1 : 11;
    const d = toDay   ? parseInt(toDay)        : 0; // day 0 = last day of previous month
    // If day specified: end of that day; if not: end of last day of month
    state.dateTo = toDay
      ? new Date(parseInt(toYear), m, parseInt(toDay), 23, 59, 59, 999).getTime()
      : new Date(parseInt(toYear), toMonth ? parseInt(toMonth) : 12, 0, 23, 59, 59, 999).getTime();
  } else {
    state.dateTo = null;
  }

  const clearBtn = document.getElementById('dr-clear');
  if (clearBtn) clearBtn.style.display = (state.dateFrom || state.dateTo) ? '' : 'none';

  state.offset = 0;
  state.selectedPaths.clear();
  await loadPhotoPage(true);
  _updateSelectionUI();
});

document.getElementById('dr-clear').addEventListener('click', async () => {
  state.dateFrom = null;
  state.dateTo   = null;
  // Reset selects to their default (populated values — leave years as-is, clear months)
  const fromMonthSel = document.getElementById('dr-from-month');
  const toMonthSel   = document.getElementById('dr-to-month');
  if (fromMonthSel) fromMonthSel.value = '';
  if (toMonthSel)   toMonthSel.value   = '';
  document.getElementById('dr-clear').style.display = 'none';
  state.offset = 0;
  state.selectedPaths.clear();
  await loadPhotoPage(true);
  _updateSelectionUI();
});

// ── Extension filter ───────────────────────────────────────────────────────────

async function populateExtFilter() {
  const sel = document.getElementById('ext-filter-select');
  if (!sel) return;
  try {
    const exts = await window.tt.getExtensions();
    sel.innerHTML = '<option value="">All types</option>';
    exts.forEach(({ ext, n }) => {
      const opt = document.createElement('option');
      opt.value = ext;
      opt.textContent = `${ext.toUpperCase()} (${n.toLocaleString()})`;
      sel.appendChild(opt);
    });
  } catch {}
}

document.getElementById('ext-filter-select').addEventListener('change', async (e) => {
  state.ext    = e.target.value || null;
  state.offset = 0;
  state.selectedPaths.clear();

  // Reset tab to ALL when a type is selected — otherwise the tab filter
  // combines with the type filter and produces confusing results
  if (state.ext && state.filter !== 'all') {
    state.filter = 'all';
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.filter-tab[data-filter="all"]')?.classList.add('active');
  }

  await loadPhotoPage(true);
  _updateSelectionUI();
});

// ── Generate Thumbnails ────────────────────────────────────────────────────────

document.getElementById('btn-generate-thumbs').addEventListener('click', async () => {
  const btn       = document.getElementById('btn-generate-thumbs');
  const wrap      = document.getElementById('thumb-progress-wrap');
  const fill      = document.getElementById('thumb-progress-bar-fill');
  const label     = document.getElementById('thumb-progress-label');

  btn.disabled = true;
  wrap.style.display = 'flex';
  fill.style.width   = '0%';
  label.textContent  = 'Starting…';

  const unsub = window.tt.onThumbProgress(({ done, total, generated }) => {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    fill.style.width  = pct + '%';
    label.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} · ${generated.toLocaleString()} created`;
  });

  try {
    const result = await window.tt.generateThumbnails();
    unsub();
    fill.style.width  = '100%';
    label.textContent = `Done — ${result.generated.toLocaleString()} thumbnails created`;
    // Reload current page to show new thumbnails
    await loadPhotoPage(true);
    setTimeout(() => {
      wrap.style.display = 'none';
      btn.disabled = false;
    }, 3000);
  } catch (err) {
    unsub();
    label.textContent = 'Failed: ' + err.message;
    btn.disabled = false;
  }
});

const HEIC_EXTS  = ['heic','heif'];
const VIDEO_EXTS_LB = ['mov','mp4','m4v','avi','mkv','3gp'];

async function openLightbox(photo) {
  const lb       = document.getElementById('lightbox');
  const lbImg    = document.getElementById('lightbox-img');
  const lbVideo  = document.getElementById('lightbox-video');
  const lbInfo   = document.getElementById('lightbox-info');
  if (!lb) return;

  const ext = (photo.filename.split('.').pop() || '').toLowerCase();
  const isVideo = VIDEO_EXTS_LB.includes(ext);

  // Reset both elements
  lbImg.style.display   = 'none';
  lbImg.src             = '';
  lbVideo.style.display = 'none';
  lbVideo.pause();
  lbVideo.src           = '';

  lb.classList.add('open');

  if (isVideo) {
    lbVideo.style.display = 'block';
    // Encode path segments so spaces and special chars work in the local:// protocol
    const encodedPath = photo.file_path.split('/').map(s => encodeURIComponent(s)).join('/');
    lbVideo.src = `local://${encodedPath}`;
    lbVideo.load();
    lbVideo.play().catch(() => {}); // autoplay, ignore if blocked
  } else if (HEIC_EXTS.includes(ext)) {
    lbImg.style.display = 'block';
    lbImg.alt = 'Converting…';
    try {
      const result = await window.tt.heicToJpeg({ filePath: photo.file_path });
      lbImg.src = result.ok ? `local://${result.tempPath}` : '';
      lbImg.alt = result.ok ? '' : 'Cannot display this HEIC file';
    } catch {
      lbImg.alt = 'Conversion failed';
    }
  } else {
    lbImg.style.display = 'block';
    lbImg.src = `local://${photo.file_path}`;
    lbImg.alt = '';
  }

  // Info bar
  const dateStr = photo.date_ts
    ? new Date(photo.date_ts).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' })
    : null;
  const gpsStr = photo.lat != null
    ? `lat ${photo.lat.toFixed(4)}, lng ${photo.lng.toFixed(4)}`
    : null;
  const parts = [photo.filename];
  if (dateStr) parts.push(dateStr);
  if (gpsStr)  parts.push(gpsStr);
  if (lbInfo)  lbInfo.textContent = parts.join('  ·  ');
}

function closeLightbox() {
  const lb    = document.getElementById('lightbox');
  const img   = document.getElementById('lightbox-img');
  const video = document.getElementById('lightbox-video');
  if (!lb) return;
  lb.classList.remove('open');
  if (img)   { img.src = ''; img.style.display = 'none'; }
  if (video) { video.pause(); video.src = ''; video.style.display = 'none'; }
}

// Use mousedown + capture:true so the titlebar drag region cannot intercept
document.getElementById('lightbox-close').addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeLightbox();
}, true);
document.getElementById('lightbox-back-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeLightbox();
});
document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeLightbox(); closeLicenceModal(); }
});

// ── Copy abort ─────────────────────────────────────────────────────────────────

document.getElementById('btn-copy-abort').addEventListener('click', async () => {
  const btn = document.getElementById('btn-copy-abort');
  btn.disabled = true;
  btn.textContent = 'Aborting…';
  await window.tt.cancelCopy();
});

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await refreshLicenceStatus();
  showView('import');
  const stats = await window.tt.getStats();
  if (stats && stats.total > 0) updateSidebarStats(stats);
}

init();
