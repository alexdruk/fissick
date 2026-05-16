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
  await refreshLicenceStatus();
  await refreshStats();
  await loadPhotoPage(true);

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
    const result = await window.tt.getPhotos({ offset: state.offset, limit: state.limit, filter: state.filter });
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

  const ext = (photo.filename.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg','jpeg','png','gif','webp','heic','heif','bmp'].includes(ext);
  const thumb = isImage
    ? `<img class="photo-thumb" src="local://${photo.file_path}" loading="lazy" alt=""
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="photo-thumb-placeholder" style="display:none">🖼️</div>`
    : `<div class="photo-thumb-placeholder">🎥</div>`;

  const dateStr = photo.date_ts
    ? new Date(photo.date_ts).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' })
    : '—';

  const tag = photo.exif_written
    ? `<span class="tag ${photo.date_source === 'filename' ? 'tag-fname' : 'tag-fixed'}">${photo.date_source === 'filename' ? 'Filename date' : 'EXIF fixed'}</span>`
    : `<span class="tag tag-none">No date</span>`;

  const gps = photo.lat != null ? `<span class="tag tag-gps">GPS</span>` : `<span></span>`;

  row.innerHTML = `
    ${thumb}
    <div class="photo-info">
      <div class="photo-name" title="${photo.filename}">${photo.filename}</div>
      <div class="photo-meta">${dateStr}${photo.lat != null ? ` · ${photo.lat.toFixed(4)}, ${photo.lng.toFixed(4)}` : ''}</div>
    </div>
    ${tag}${gps}
    <span style="font-family:var(--mono);font-size:9px;color:var(--dim)">${photo.date_source || '—'}</span>
  `;
  return row;
}

document.getElementById('btn-back-results').addEventListener('click', async () => {
  await window.tt.resetData();
  state.source = {};
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
      // Switch to map view
      _showMapPanel(true);
      LocationMap.onTabActivated();
    } else {
      // Switch back to photo list
      _showMapPanel(false);
      state.filter = tab.dataset.filter;
      state.offset = 0;
      await loadPhotoPage(true);
    }
  });
});

document.getElementById('btn-load-more').addEventListener('click', () => loadPhotoPage(false));

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
    const result = await window.tt.exportPhotosCsv();
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
  const btn        = e.currentTarget;
  const progressWrap = document.getElementById('copy-progress-wrap');
  const barFill      = document.getElementById('copy-progress-bar-fill');
  const barLabel     = document.getElementById('copy-progress-label');

  btn.disabled = true;

  // Start the copy — main process returns immediately, progress comes via events
  const result = await window.tt.exportCopyFixed();
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

  const unsubDone = window.tt.onCopyDone(({ copied, skipped, failed, destDir }) => {
    unsubProgress();
    unsubDone();
    progressWrap.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">📂</span> Copy Fixed Files';
    const parts = [`${copied.toLocaleString()} files copied`];
    if (skipped) parts.push(`${skipped} not found`);
    if (failed)  parts.push(`${failed} errors`);
    _exportToast(parts.join(' · '));
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLicenceModal();
});

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await refreshLicenceStatus();
  showView('import');
  const stats = await window.tt.getStats();
  if (stats && stats.total > 0) updateSidebarStats(stats);
}

init();
