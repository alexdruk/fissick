// src/renderer/app.js — Fissick renderer
// Vanilla JS. No frameworks. No build step.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  view:        'import',
  source:      {},
  processing:  false,
  isPaused:    false,
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
  // ── Trips ──────────────────────────────────────────────────────────────────
  trips: {
    initialized: false,
    computed:    false,
    computing:   false,
    unsubEvent:  null,
    unsubName:   null,
  },
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
document.getElementById('sb-trips').addEventListener('click', async () => {
  // Navigate to results if not already there, then activate trips tab
  if (state.view !== 'results') {
    await loadResults();
    showView('results');
  }
  // Activate trips tab and panel
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.filter-tab[data-filter="trips"]')?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('sb-trips').classList.add('active');
  _showMapPanel(false);
  _showTripsPanel(true);
  Trips.onTabActivated();
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
  await window.tt.resetTrips();
  const list = document.getElementById('photo-list');
  if (list) list.innerHTML = '';
  document.getElementById('results-stats-row').innerHTML = '';
  showTrialBanner(false);

  // Hide Map + Trips tabs — will re-appear if location data is found
  const mapTab   = document.getElementById('tab-map');
  const tripsTab = document.getElementById('tab-trips');
  if (mapTab)   mapTab.style.display   = 'none';
  if (tripsTab) tripsTab.style.display = 'none';
  document.getElementById('sb-trips').style.display = 'none';
  _showMapPanel(false);
  _showTripsPanel(false);
  Trips.reset();

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
  state.isPaused = false;
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
  // Reset pause/abort button states
  const pauseBtn = document.getElementById('btn-pause-resume');
  if (pauseBtn) {
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.className = 'proc-ctrl-btn proc-ctrl-pause';
    pauseBtn.disabled = false;
  }
  const pausedLabel = document.getElementById('proc-paused-label');
  if (pausedLabel) pausedLabel.style.display = 'none';
  const abortBtn = document.getElementById('btn-abort-processing');
  if (abortBtn) abortBtn.disabled = false;
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
        state.isPaused   = false;
        // Disable controls when done
        const pauseBtn = document.getElementById('btn-pause-resume');
        const abortBtn = document.getElementById('btn-abort-processing');
        if (pauseBtn) pauseBtn.disabled = true;
        if (abortBtn) abortBtn.disabled = true;
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
      const label = msg.phase === 'thumbnails' ? 'thumbnails' : 'photos';
      set('progress-text', `${msg.processed.toLocaleString()} / ${msg.total.toLocaleString()} ${label}`);
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
  state.isPaused   = false;
  showView('import');
});

document.getElementById('btn-pause-resume').addEventListener('click', async () => {
  const btn         = document.getElementById('btn-pause-resume');
  const pausedLabel = document.getElementById('proc-paused-label');

  if (!state.isPaused) {
    // Pause
    await window.tt.pauseProcessing();
    state.isPaused = true;
    btn.textContent = '▶ Continue';
    btn.className   = 'proc-ctrl-btn proc-ctrl-resume';
    if (pausedLabel) pausedLabel.style.display = '';
    // Update badge
    const badge = document.getElementById('phase-badge');
    if (badge) { badge.className = 'phase-badge'; badge.textContent = 'Paused'; }
    logMsg('Processing paused — click Continue to resume.', 'dim');
  } else {
    // Resume
    await window.tt.resumeProcessing();
    state.isPaused = false;
    btn.textContent = '⏸ Pause';
    btn.className   = 'proc-ctrl-btn proc-ctrl-pause';
    if (pausedLabel) pausedLabel.style.display = 'none';
    // Restore badge
    const badge = document.getElementById('phase-badge');
    if (badge) { badge.className = 'phase-badge processing'; badge.textContent = 'Processing'; }
    logMsg('Processing resumed.', 'ok');
  }
});

document.getElementById('btn-abort-processing').addEventListener('click', async () => {
  const confirmed = await new Promise(resolve => {
    // Simple inline confirm — reuse the existing dialog pattern
    resolve(window.confirm('Abort processing? Photos processed so far will be saved in the database.'));
  });
  if (!confirmed) return;

  const abortBtn = document.getElementById('btn-abort-processing');
  if (abortBtn) { abortBtn.disabled = true; abortBtn.textContent = 'Aborting…'; }

  await window.tt.cancelProcessing();
  state.processing = false;
  state.isPaused   = false;
  logMsg('Processing aborted.', 'err');

  // Show results with whatever was processed so far
  setTimeout(async () => {
    await loadResults();
    showView('results');
  }, 800);
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
  const runStats = await refreshStats();
  await populateExtFilter();
  await loadPhotoPage(true);
  _updateSelectionUI();

  // Load location stats to update sidebar, reveal Map/Trips tabs, show/hide location exports
  try {
    const locStats  = await window.tt.getLocationStats();
    const hasLoc    = locStats && locStats.total > 0;
    const hasGps    = runStats && runStats.with_gps > 0;

    // Map tab — only if Timeline location data exists
    const mapTab = document.getElementById('tab-map');
    if (mapTab) mapTab.style.display = hasLoc ? '' : 'none';

    // Trips tab — Timeline data OR photo GPS (21k photos with GPS = plenty to work with)
    const tripsTab = document.getElementById('tab-trips');
    if (tripsTab) tripsTab.style.display = (hasLoc || hasGps) ? '' : 'none';
    document.getElementById('sb-trips').style.display = (hasLoc || hasGps) ? '' : 'none';

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
  return stats;
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
  _showTripsPanel(false);
  Trips.reset();
  const mapTab   = document.getElementById('tab-map');
  const tripsTab = document.getElementById('tab-trips');
  if (mapTab)   mapTab.style.display   = 'none';
  if (tripsTab) tripsTab.style.display = 'none';
  document.getElementById('sb-trips').style.display = 'none';
  showView('import');
});

// ── Filter tabs (including Map tab) ───────────────────────────────────────────
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    if (tab.dataset.filter === 'map') {
      _showTripsPanel(false);
      _showMapPanel(true);
      LocationMap.onTabActivated();
    } else if (tab.dataset.filter === 'trips') {
      _showMapPanel(false);
      _showTripsPanel(true);
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      document.getElementById('sb-trips').classList.add('active');
      Trips.onTabActivated();
    } else {
      _showMapPanel(false);
      _showTripsPanel(false);
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      document.getElementById('sb-results').classList.add('active');
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

// ── Generate Thumbnails — disabled: thumbnails now generated during processing ──
/*
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
*/

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

// ── Settings panel ─────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(1) + ' TB';
  if (bytes >= 1e9)  return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6)  return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

async function refreshSettingsPanel() {
  const info = await window.tt.getWorkingFolder();
  const pathLabel   = document.getElementById('wf-path-label');
  const metaLabel   = document.getElementById('wf-meta-label');
  const clearBtn    = document.getElementById('btn-wf-clear');
  const spDb        = document.getElementById('sp-db');
  const spThumbs    = document.getElementById('sp-thumbs');
  const spFree      = document.getElementById('sp-free');

  if (info.workingFolder) {
    pathLabel.textContent = info.workingFolder;
    metaLabel.textContent = 'Custom working folder';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    pathLabel.textContent = 'Default (~/Library/Application Support/fissick)';
    metaLabel.textContent = 'Using built-in default location';
    if (clearBtn) clearBtn.style.display = 'none';
  }
  if (spDb)     spDb.textContent     = info.dbPath || '—';
  if (spThumbs) spThumbs.textContent = info.thumbDir || '—';
  if (spFree)   spFree.textContent   = formatBytes(info.freeBytes) +
    (info.freeBytes != null && info.freeBytes < 10e9 ? ' ⚠️ Low' : '');
}

function openSettingsPanel() {
  document.getElementById('settings-panel').classList.add('open');
  refreshSettingsPanel();
}
function closeSettingsPanel() {
  document.getElementById('settings-panel').classList.remove('open');
  document.getElementById('wf-status').style.display = 'none';
}

document.getElementById('btn-settings').addEventListener('click', openSettingsPanel);
document.getElementById('settings-close').addEventListener('click', closeSettingsPanel);
document.getElementById('settings-backdrop').addEventListener('click', closeSettingsPanel);

document.getElementById('btn-wf-browse').addEventListener('click', async () => {
  const result = await window.tt.browseWorkingFolder();
  if (result.canceled) return;

  const statusEl = document.getElementById('wf-status');
  statusEl.style.display = 'block';
  statusEl.className = 'wf-status';
  statusEl.textContent = 'Applying…';

  const applyResult = await window.tt.setWorkingFolder({ folderPath: result.folderPath });
  if (applyResult.ok) {
    statusEl.className = 'wf-status ok';
    statusEl.textContent = applyResult.migrated
      ? `✓ Working folder set. Existing database copied to new location.`
      : `✓ Working folder set. New archives will extract here.`;
    await refreshSettingsPanel();
  } else {
    statusEl.className = 'wf-status err';
    statusEl.textContent = applyResult.error || 'Failed to set working folder.';
  }
});

document.getElementById('btn-wf-clear').addEventListener('click', async () => {
  const statusEl = document.getElementById('wf-status');
  await window.tt.setWorkingFolder({ folderPath: null });
  statusEl.style.display = 'block';
  statusEl.className = 'wf-status ok';
  statusEl.textContent = '✓ Reset to default location.';
  await refreshSettingsPanel();
});

// ── Trips panel show/hide ──────────────────────────────────────────────────────
function _showTripsPanel(show) {
  const viewResults  = document.getElementById('view-results');
  const photoList    = document.getElementById('photo-list');
  const listFooter   = viewResults?.querySelector('.list-footer');
  const trialBanner  = document.getElementById('trial-banner');
  const tripsPanel   = document.getElementById('trips-panel');
  const exportBar    = document.getElementById('export-bar');
  const dateRangeBar = document.getElementById('date-range-bar');
  const thumbGenBar  = document.getElementById('thumb-gen-bar'); // may be null (disabled)
  const selBar       = document.getElementById('select-bar');
  if (!viewResults || !tripsPanel) return;

  if (show) {
    [photoList, listFooter, trialBanner, selBar, exportBar, dateRangeBar, thumbGenBar]
      .forEach(el => { if (el) el.style.display = 'none'; });
    viewResults.style.overflow = 'hidden';
    const usedH = (viewResults.querySelector('.results-header')?.offsetHeight || 0)
                + (viewResults.querySelector('.filter-bar')?.offsetHeight     || 0);
    tripsPanel.style.height = (viewResults.clientHeight - usedH) + 'px';
    tripsPanel.classList.add('visible');
  } else {
    tripsPanel.classList.remove('visible');
    viewResults.style.overflow = '';
    if (photoList)    photoList.style.display    = '';
    if (listFooter)   listFooter.style.display   = '';
    if (selBar)       selBar.style.display        = '';
    if (exportBar)    exportBar.style.display     = '';
    if (dateRangeBar) dateRangeBar.style.display  = '';
    if (thumbGenBar)  thumbGenBar.style.display   = '';
  }
}

// ── Trips module ───────────────────────────────────────────────────────────────
const Trips = (() => {
  'use strict';

  // ── Home zone modal state ─────────────────────────────────────────────────
  let _hzMap             = null;
  let _hzMarkers         = [];
  let _hzClusters        = [];
  let _hzChecked         = new Set();
  let _geocodeUnsub      = null;
  let _collapsedCountries = new Set();
  let _groupRenderTimer  = null;
  let _geocodeExpected   = 0;
  let _geocodeReceived   = 0;

  // ── List + detail state ───────────────────────────────────────────────────
  let _currentSort       = 'chrono';
  let _sortListenerAdded = false;
  let _activeTrip        = null;  // trip object currently shown in detail

  // ── Country flag helper ───────────────────────────────────────────────────
  function _flag(code) {
    if (!code || code.length !== 2) return '🌍';
    return [...code.toUpperCase()].map(c =>
      String.fromCodePoint(c.charCodeAt(0) + 127397)
    ).join('');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  async function onTabActivated() {
    if (!_sortListenerAdded) {
      const sortSel = document.getElementById('trips-sort-select');
      if (sortSel) {
        sortSel.addEventListener('change', (e) => {
          _currentSort = e.target.value;
          _loadAndRenderTrips();
        });
        _sortListenerAdded = true;
      }
    }
    if (state.trips.computing) { _showComputing(); return; }
    try {
      const { total } = await window.tt.getTrips({ limit: 1 });
      if (total > 0) { state.trips.computed = true; await _loadAndRenderTrips(); }
      else _showEmpty();
    } catch { _showEmpty(); }
  }

  function reset() {
    state.trips.initialized = false;
    state.trips.computed    = false;
    state.trips.computing   = false;
    if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
    if (state.trips.unsubName)  { state.trips.unsubName();  state.trips.unsubName  = null; }
    TripDetailMap.destroy();
    _activeTrip = null;
    _setTripsPanelState('empty');
  }

  // ── Panel state ────────────────────────────────────────────────────────────

  function _showEmpty()    { _setTripsPanelState('empty'); }
  function _showComputing(message) {
    _setTripsPanelState('computing');
    const msg = document.getElementById('trips-computing-msg');
    if (msg && message) msg.textContent = message;
  }

  function _setTripsPanelState(mode) {
    const empty    = document.getElementById('trips-empty');
    const computing = document.getElementById('trips-computing');
    const list     = document.getElementById('trips-list');
    const detail   = document.getElementById('trips-detail');
    if (!empty || !computing || !list) return;
    empty.style.display     = mode === 'empty'     ? '' : 'none';
    computing.style.display = mode === 'computing' ? '' : 'none';
    list.style.display      = mode === 'list'      ? '' : 'none';
    if (detail) detail.classList.toggle('visible', mode === 'detail');
  }

  // ── Trip card list ─────────────────────────────────────────────────────────

  async function _loadAndRenderTrips() {
    _setTripsPanelState('list');
    TripDetailMap.destroy();
    _activeTrip = null;

    const ORDER = {
      'chrono':      'start_ts ASC',
      'chrono-desc': 'start_ts DESC',
      'country':     'name ASC, start_ts ASC',
      'photos':      'photo_count DESC, start_ts ASC',
      'distance':    'distance_km DESC, start_ts ASC',
    };
    const { trips, total } = await window.tt.getTrips({
      limit: 200,
      orderBy: ORDER[_currentSort] || 'start_ts ASC',
    });

    const sortSel = document.getElementById('trips-sort-select');
    if (sortSel) sortSel.value = _currentSort;

    const countEl = document.getElementById('trips-list-count');
    if (countEl) countEl.textContent = `${total.toLocaleString()} trip${total !== 1 ? 's' : ''}`;

    // Remove existing cards
    const list = document.getElementById('trips-list');
    [...list.querySelectorAll('.trip-card')].forEach(el => el.remove());

    for (const trip of trips) {
      const card = _renderTripCard(trip);
      list.appendChild(card);
    }

    // Live name + flag + distance updates from background geocoding
    if (state.trips.unsubName) state.trips.unsubName();
    state.trips.unsubName = window.tt.onTripNameUpdate(({ tripId, name, countryCode, distKm }) => {
      const card = document.querySelector(`.trip-card[data-trip-id="${tripId}"]`);
      if (!card) return;
      const nameEl = card.querySelector('.tc-name');
      const flagEl = card.querySelector('.tc-flag');
      const distEl = card.querySelector('.tc-stat-dist');
      if (nameEl && name) nameEl.textContent = name;
      if (flagEl && countryCode) flagEl.textContent = _flag(countryCode);
      if (distEl && distKm != null) distEl.textContent = `${distKm.toLocaleString()} km from home`;
    });
  }

  function _renderTripCard(trip) {
    const card = document.createElement('div');
    card.className = 'trip-card';
    card.dataset.tripId = trip.id;

    const start   = new Date(trip.start_ts);
    const end     = new Date(trip.end_ts);
    const days    = Math.max(1, Math.round((trip.end_ts - trip.start_ts) / 86400000) + 1);
    const fmt     = d => d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    const sameDayStr = start.toDateString() === end.toDateString();
    const dateStr = sameDayStr ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;

    const flag    = _flag(trip.country_code);
    const distStr = trip.distance_km != null
      ? `${Math.round(trip.distance_km).toLocaleString()} km from home`
      : '';

    card.innerHTML = `
      <div class="tc-flag">${_esc(flag)}</div>
      <div class="tc-body">
        <div class="tc-name">${_esc(trip.name)}</div>
        <div class="tc-meta">${_esc(dateStr)} · ${days} day${days !== 1 ? 's' : ''}</div>
        <div class="tc-stats">
          <span class="tc-stat">${(trip.photo_count || 0).toLocaleString()} photos</span>
          ${distStr ? `<span class="tc-stat tc-stat-dist">${_esc(distStr)}</span>` : ''}
        </div>
      </div>
      <div class="tc-arrow">›</div>`;

    card.addEventListener('click', () => _openDetail(trip));
    return card;
  }

  // ── Trip detail view ───────────────────────────────────────────────────────

  async function _openDetail(trip) {
    _activeTrip = trip;
    _setTripsPanelState('detail');

    const titleEl = document.getElementById('trips-detail-title');
    const metaEl  = document.getElementById('trips-detail-meta');
    const fmt     = d => new Date(d).toLocaleDateString('en',
      { month: 'short', day: 'numeric', year: 'numeric' });
    const days    = Math.max(1, Math.round((trip.end_ts - trip.start_ts) / 86400000) + 1);
    const flag    = _flag(trip.country_code);

    if (titleEl) titleEl.textContent = `${flag} ${trip.name}`;
    if (metaEl)  metaEl.textContent  =
      `${fmt(trip.start_ts)} – ${fmt(trip.end_ts)} · ${days} days · ${(trip.photo_count||0).toLocaleString()} photos`;

    // Resize detail map container to fill available space
    _resizeDetailMap();

    // Init the map — photo click opens the photo lightbox
    await TripDetailMap.init('trips-detail-map', trip.id, (photo) => {
      openLightbox(photo);
    });
  }

  function _closeDetail() {
    TripDetailMap.destroy();
    _activeTrip = null;
    _loadAndRenderTrips();
  }

  function _resizeDetailMap() {
    // Let CSS flex handle it — just trigger an invalidate after render
    requestAnimationFrame(() => {
      try {
        const container = document.getElementById('trips-detail-map');
        if (container && container._leaflet_id) {
          // If Leaflet already attached, invalidate size
          // (handled inside TripDetailMap.init via setTimeout)
        }
      } catch {}
    });
  }

  // ── Computing feedback ─────────────────────────────────────────────────────

  async function confirmHomeZones() {
    if (_hzChecked.size === 0) return;

    const confirmBtn = document.getElementById('btn-hz-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Starting…'; }

    const homeZones = [..._hzChecked].map(i => ({ lat: _hzClusters[i].lat, lng: _hzClusters[i].lng }));
    closeHomeZoneModal();
    state.trips.computing = true;

    _showTripsPanel(true);
    _setTripsPanelState('computing');
    const msgEl = document.getElementById('trips-computing-msg');
    const subEl = document.getElementById('trips-computing-sub');
    const barEl = document.getElementById('trips-prog-bar');
    if (msgEl) msgEl.textContent = 'Preparing analysis…';
    if (subEl) subEl.textContent = '';
    if (barEl) barEl.style.width = '2%';

    if (state.trips.unsubEvent) state.trips.unsubEvent();
    state.trips.unsubEvent = window.tt.onTripsEvent((msg) => {
      if (msg.type === 'trips-status') {
        if (msgEl) msgEl.textContent = msg.message || 'Working…';
      } else if (msg.type === 'trips-progress') {
        const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
        if (barEl) barEl.style.width = Math.min(pct, 96) + '%';
        if (msgEl) msgEl.textContent = 'Classifying GPS points…';
        if (subEl) subEl.textContent = `${msg.done.toLocaleString()} of ${msg.total.toLocaleString()}`;
      } else if (msg.type === 'trips-done') {
        state.trips.computing = false;
        state.trips.computed  = true;
        if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
        if (barEl) barEl.style.width = '100%';
        if (msgEl) msgEl.textContent = `Found ${msg.count} trip${msg.count !== 1 ? 's' : ''} — loading…`;
        setTimeout(() => _loadAndRenderTrips(), 400);
      } else if (msg.type === 'trips-error') {
        state.trips.computing = false;
        if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
        _setTripsPanelState('empty');
        console.error('[Trips] worker error:', msg.message, msg.stack);
      }
    });

    await window.tt.computeTrips({ homeZones });
  }

  // ── Home zone modal ────────────────────────────────────────────────────────

  async function openHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (!modal) return;
    _hzChecked.clear();
    _hzClusters = [];
    _hzMarkers  = [];
    const hzList = document.getElementById('hz-list');
    if (hzList) hzList.innerHTML = '<div class="hz-list-hint">Loading clusters…</div>';
    document.getElementById('btn-hz-confirm').disabled = true;
    modal.classList.add('open');

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    _initHzMap();

    try {
      const { clusters, hasMore, total: totalClusters } = await window.tt.getClusters();
      _hzClusters = clusters;
      _renderHzClusters(clusters, hasMore, totalClusters);

      _geocodeExpected = clusters.length;
      _geocodeReceived = 0;

      _geocodeUnsub = window.tt.onGeocodeResult(({ index, name, country }) => {
        if (_hzClusters[index]) {
          _hzClusters[index].name    = name;
          _hzClusters[index].country = country || null;
        }
        const nameEl = document.querySelector(`.hz-item[data-index="${index}"] .hz-item-name`);
        if (nameEl) { nameEl.textContent = name; nameEl.classList.remove('loading'); }
        _geocodeReceived++;
        clearTimeout(_groupRenderTimer);
        if (_geocodeReceived >= _geocodeExpected) _renderGroupedList();
        else _groupRenderTimer = setTimeout(_renderGroupedList, 600);
      });

      window.tt.geocodeBatch({ points: clusters.map(c => ({ index: c.index, lat: c.lat, lng: c.lng })) })
        .catch(() => {})
        .finally(() => {
          if (_geocodeUnsub) { _geocodeUnsub(); _geocodeUnsub = null; }
          clearTimeout(_groupRenderTimer);
          _renderGroupedList();
        });
    } catch (err) {
      if (hzList) hzList.innerHTML =
        `<div class="hz-list-hint" style="color:var(--red)">Error: ${_esc(err.message)}</div>`;
    }
  }

  function _initHzMap() {
    const container = document.getElementById('hz-map');
    if (!container || typeof L === 'undefined') return;
    if (_hzMap) { try { _hzMap.remove(); } catch {} _hzMap = null; }
    _hzMap = L.map('hz-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_hzMap);
    _hzMap.setView([20, 0], 2);
  }

  function _renderHzClusters(clusters, hasMore, totalClusters) {
    const hzList = document.getElementById('hz-list');
    if (!hzList) return;
    hzList.innerHTML = '<div class="hz-list-hint">Select home zones</div>';

    const bounds = [];
    _hzMarkers = [];

    for (const c of clusters) {
      const item = document.createElement('div');
      item.className = 'hz-item';
      item.dataset.index = c.index;
      item.innerHTML = `
        <div class="hz-num">${c.index + 1}</div>
        <div class="hz-item-info">
          <div class="hz-item-name loading">${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}</div>
          <div class="hz-item-count">${c.count.toLocaleString()} photos</div>
        </div>`;
      item.addEventListener('click', () => _toggleHz(c.index));
      hzList.appendChild(item);

      if (_hzMap) {
        bounds.push([c.lat, c.lng]);
        const icon = L.divIcon({
          html: `<div class="hz-pin" id="hz-pin-${c.index}">${c.index + 1}</div>`,
          className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        });
        const marker = L.marker([c.lat, c.lng], { icon }).addTo(_hzMap);
        marker.on('click', () => _toggleHz(c.index));
        _hzMarkers.push({ marker, index: c.index });
      }
    }

    // "Show all N locations" link
    if (hasMore && totalClusters > clusters.length) {
      const showMore = document.createElement('div');
      showMore.style.cssText = 'padding:8px 14px;cursor:pointer;font-family:var(--mono);font-size:10px;color:var(--acc);text-align:center;border-top:1px solid var(--border)';
      showMore.textContent = `Show all ${totalClusters} locations`;
      showMore.addEventListener('click', async () => {
        showMore.textContent = 'Loading…';
        const { clusters: all } = await window.tt.getAllClusters();
        // Merge new clusters beyond the first 10
        const newClusters = all.slice(_hzClusters.length);
        _hzClusters.push(...newClusters);
        _renderHzClusters(all, false, all.length);
        // Restart geocoding for the new items
        _geocodeExpected += newClusters.length;
        window.tt.geocodeBatch({ points: newClusters.map(c => ({ index: c.index, lat: c.lat, lng: c.lng })) })
          .catch(() => {})
          .finally(() => { clearTimeout(_groupRenderTimer); _renderGroupedList(); });
      });
      hzList.appendChild(showMore);
    }

    if (_hzMap && bounds.length > 0) {
      try { _hzMap.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 8 }); } catch {}
      setTimeout(() => {
        try {
          _hzMap.invalidateSize();
          _hzMap.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 8 });
        } catch {}
      }, 300);
    }
  }

  function _renderGroupedList() {
    const hzList = document.getElementById('hz-list');
    if (!hzList || !_hzClusters.length) return;

    const groups = {};
    for (const c of _hzClusters) {
      const key = c.country || '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }

    const sorted = Object.entries(groups)
      .map(([country, list]) => ({ country, list, total: list.reduce((s, c) => s + c.count, 0) }))
      .sort((a, b) => b.total - a.total);

    const scrollTop = hzList.scrollTop;
    hzList.innerHTML = '<div class="hz-list-hint">Select home zones</div>';

    for (const { country, list, total } of sorted) {
      const collapsed = _collapsedCountries.has(country);
      const checked   = list.filter(c => _hzChecked.has(c.index)).length;
      const metaParts = [`${list.length} location${list.length !== 1 ? 's' : ''}`,
                         `${total.toLocaleString()} photos`];
      if (checked) metaParts.push(`${checked} selected ✓`);

      const group = document.createElement('div');
      group.className = 'hz-country-group';
      group.innerHTML = `
        <div class="hz-country-header" data-country="${_esc(country)}">
          <span class="hz-country-arrow">${collapsed ? '▶' : '▼'}</span>
          <div class="hz-country-info">
            <span class="hz-country-name">${_esc(country)}</span>
            <span class="hz-country-meta">${metaParts.join(' · ')}</span>
          </div>
        </div>
        <div class="hz-country-items${collapsed ? ' collapsed' : ''}"></div>`;

      group.querySelector('.hz-country-header').addEventListener('click', () => _toggleCountry(country));

      const itemsEl = group.querySelector('.hz-country-items');
      for (const c of list) {
        const cityName = c.name ? c.name.split(',')[0].trim()
                                : `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
        const item = document.createElement('div');
        item.className = 'hz-item' + (_hzChecked.has(c.index) ? ' checked' : '');
        item.dataset.index = c.index;
        item.innerHTML = `
          <div class="hz-num">${c.index + 1}</div>
          <div class="hz-item-info">
            <div class="hz-item-name${c.name ? '' : ' loading'}">${_esc(cityName)}</div>
            <div class="hz-item-count">${c.count.toLocaleString()} photos</div>
          </div>`;
        item.addEventListener('click', () => _toggleHz(c.index));
        itemsEl.appendChild(item);
      }
      hzList.appendChild(group);
    }
    hzList.scrollTop = scrollTop;
  }

  function _toggleCountry(country) {
    if (_collapsedCountries.has(country)) _collapsedCountries.delete(country);
    else _collapsedCountries.add(country);
    const header = document.querySelector(`.hz-country-header[data-country="${CSS.escape(country)}"]`);
    if (!header) { _renderGroupedList(); return; }
    const group    = header.closest('.hz-country-group');
    const items    = group?.querySelector('.hz-country-items');
    const arrow    = header.querySelector('.hz-country-arrow');
    const collapsed = _collapsedCountries.has(country);
    if (items) items.classList.toggle('collapsed', collapsed);
    if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
  }

  function _toggleHz(index) {
    if (_hzChecked.has(index)) _hzChecked.delete(index);
    else _hzChecked.add(index);
    const item  = document.querySelector(`.hz-item[data-index="${index}"]`);
    if (item) item.classList.toggle('checked', _hzChecked.has(index));
    const pinEl = document.getElementById(`hz-pin-${index}`);
    if (pinEl) pinEl.classList.toggle('checked', _hzChecked.has(index));
    document.getElementById('btn-hz-confirm').disabled = _hzChecked.size === 0;
    // Update country header meta
    const country = _hzClusters[index]?.country;
    if (country) {
      const header  = document.querySelector(`.hz-country-header[data-country="${CSS.escape(country)}"]`);
      const metaEl  = header?.querySelector('.hz-country-meta');
      if (metaEl) {
        const group   = _hzClusters.filter(c => c.country === country);
        const chk     = group.filter(c => _hzChecked.has(c.index)).length;
        const tot     = group.reduce((s, c) => s + c.count, 0);
        const parts   = [`${group.length} location${group.length !== 1 ? 's' : ''}`,
                         `${tot.toLocaleString()} photos`];
        if (chk) parts.push(`${chk} selected ✓`);
        metaEl.textContent = parts.join(' · ');
      }
    }
  }

  function closeHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (modal) modal.classList.remove('open');
    if (_geocodeUnsub) { _geocodeUnsub(); _geocodeUnsub = null; }
    clearTimeout(_groupRenderTimer); _groupRenderTimer = null;
    if (_hzMap) { try { _hzMap.remove(); } catch {} _hzMap = null; }
    _hzMarkers = [];
    _hzChecked.clear();
    _collapsedCountries.clear();
  }

  return {
    onTabActivated, reset,
    openHomeZoneModal, closeHomeZoneModal, confirmHomeZones,
    closeDetail: _closeDetail,
  };
})();

// ── Home zone modal wiring ──────────────────────────────────────────────────────
document.getElementById('btn-compute-trips').addEventListener('click', () => Trips.openHomeZoneModal());
document.getElementById('btn-recompute-trips').addEventListener('click', async () => {
  await window.tt.resetTrips();
  Trips.reset();
  Trips.openHomeZoneModal();
});
document.getElementById('btn-hz-cancel').addEventListener('click', () => Trips.closeHomeZoneModal());
document.getElementById('btn-hz-confirm').addEventListener('click', () => Trips.confirmHomeZones());
document.getElementById('home-zone-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) Trips.closeHomeZoneModal();
});
document.getElementById('btn-trips-back').addEventListener('click', () => Trips.closeDetail());

// ── Init ───────────────────────────────────────────────────────────────────────
  let _currentSort         = 'chrono';  // 'chrono' | 'country' | 'photos'
  let _sortListenerAdded   = false;

  // ── Public ─────────────────────────────────────────────────────────────────

  async function onTabActivated() {
    // Wire sort select once
    if (!_sortListenerAdded) {
      const sortSel = document.getElementById('trips-sort-select');
      if (sortSel) {
        sortSel.addEventListener('change', (e) => {
          _currentSort = e.target.value;
          _loadAndRenderTrips();
        });
        _sortListenerAdded = true;
      }
    }
    if (state.trips.computing) { _showComputing(); return; }
    try {
      const { total } = await window.tt.getTrips({ limit: 1 });
      if (total > 0) {
        state.trips.computed = true;
        await _loadAndRenderTrips();
      } else {
        _showEmpty();
      }
    } catch { _showEmpty(); }
  }

  function reset() {
    state.trips.initialized = false;
    state.trips.computed    = false;
    state.trips.computing   = false;
    if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
    if (state.trips.unsubName)  { state.trips.unsubName();  state.trips.unsubName  = null; }
    TripMaps.destroyAll();
    _setTripsPanelState('empty');
  }

  // ── States ──────────────────────────────────────────────────────────────────

  function _showEmpty()    { _setTripsPanelState('empty'); }
  function _showComputing(message) {
    _setTripsPanelState('computing');
    const msg = document.getElementById('trips-computing-msg');
    if (msg && message) msg.textContent = message;
  }

  // ── Trip cards ──────────────────────────────────────────────────────────────

  async function _loadAndRenderTrips() {
    _setTripsPanelState('list');
    TripMaps.destroyAll();

    const ORDER = {
      chrono:  'start_ts ASC',
      country: 'name ASC, start_ts ASC',
      photos:  'photo_count DESC, start_ts ASC',
    };
    const { trips, total } = await window.tt.getTrips({
      limit: 200,
      orderBy: ORDER[_currentSort] || 'start_ts ASC',
    });

    // Sync select UI to current sort
    const sortSel = document.getElementById('trips-sort-select');
    if (sortSel) sortSel.value = _currentSort;
    const countEl = document.getElementById('trips-list-count');
    if (countEl) countEl.textContent = `${total.toLocaleString()} trip${total !== 1 ? 's' : ''}`;
    const list = document.getElementById('trips-list');
    [...list.querySelectorAll('.trip-card')].forEach(el => el.remove());
    for (const trip of trips) list.appendChild(_renderTripCard(trip));
    requestAnimationFrame(() => { trips.forEach(t => TripMaps.observe(`trip-map-${t.id}`)); });

    if (state.trips.unsubName) state.trips.unsubName();
    state.trips.unsubName = window.tt.onTripNameUpdate(({ tripId, name }) => {
      const nameEl = document.querySelector(`.trip-card[data-trip-id="${tripId}"] .trip-name`);
      if (nameEl) nameEl.textContent = name;
    });
  }

  function _renderTripCard(trip) {
    const card = document.createElement('div');
    card.className = 'trip-card';
    card.dataset.tripId = trip.id;
    const start = new Date(trip.start_ts);
    const end   = new Date(trip.end_ts);
    const days  = Math.max(1, Math.ceil((trip.end_ts - trip.start_ts) / 86400000));
    const fmt   = d => d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    const dateRange = start.toDateString() === end.toDateString()
      ? fmt(start) : `${fmt(start)} – ${fmt(end)} · ${days} day${days !== 1 ? 's' : ''}`;
    card.innerHTML = `
      <div class="trip-card-inner">
        <div class="trip-info">
          <div class="trip-name">${_esc(trip.name)}</div>
          <div class="trip-meta">${_esc(dateRange)}</div>
          <div class="trip-stats">
            <span class="trip-stat">${(trip.photo_count || 0).toLocaleString()} photos</span>
            <span class="trip-stat">${(trip.point_count || 0).toLocaleString()} GPS pts</span>
          </div>
          <div class="trip-thumbnails" id="trip-thumbs-${trip.id}">
            <span class="trip-thumbs-loading">Loading…</span>
          </div>
        </div>
        <div class="trip-map" id="trip-map-${trip.id}" data-trip-id="${trip.id}"></div>
      </div>`;
    _loadTripThumbs(trip.id);
    return card;
  }

  async function _loadTripThumbs(tripId) {
    const container = document.getElementById(`trip-thumbs-${tripId}`);
    if (!container) return;
    try {
      const photos = await window.tt.getTripThumbs({ tripId });
      if (!photos || photos.length === 0) {
        container.innerHTML = '<span class="trip-no-thumbs">No photos on this trip</span>';
        return;
      }
      container.innerHTML = photos.map(ph => {
        const src = ph.thumbnail_path || ph.file_path;
        return `<img class="trip-thumb" src="local://${src}" loading="lazy" onerror="this.style.display='none'" alt="">`;
      }).join('');
    } catch { container.innerHTML = ''; }
  }

  function _setTripsPanelState(mode) {
    const empty     = document.getElementById('trips-empty');
    const computing = document.getElementById('trips-computing');
    const list      = document.getElementById('trips-list');
    if (!empty || !computing || !list) return;
    empty.style.display     = mode === 'empty'     ? '' : 'none';
    computing.style.display = mode === 'computing' ? '' : 'none';
    list.style.display      = mode === 'list'      ? '' : 'none';
  }

  // ── Home zone modal ─────────────────────────────────────────────────────────

  async function openHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (!modal) return;
    _hzChecked.clear();
    _hzClusters = [];
    _hzMarkers  = [];
    const hzList = document.getElementById('hz-list');
    if (hzList) hzList.innerHTML = '<div class="hz-list-hint">Loading clusters…</div>';
    document.getElementById('btn-hz-confirm').disabled = true;
    modal.classList.add('open');

    // Wait for modal to be fully painted before initialising Leaflet.
    // Double rAF: first fires after style recalc, second fires after paint —
    // guaranteeing the #hz-map container has a real pixel size before L.map() reads it.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    _initHzMap();

    try {
      const { clusters } = await window.tt.getClusters();
      _hzClusters = clusters;
      _renderHzClusters(clusters);

      if (_geocodeUnsub) _geocodeUnsub();
      _geocodeExpected = clusters.length;
      _geocodeReceived = 0;

      _geocodeUnsub = window.tt.onGeocodeResult(({ index, name, country }) => {
        if (_hzClusters[index]) {
          _hzClusters[index].name    = name;
          _hzClusters[index].country = country || null;
        }
        // Update name in flat list while grouping is pending
        const nameEl = document.querySelector(`.hz-item[data-index="${index}"] .hz-item-name`);
        if (nameEl) { nameEl.textContent = name; nameEl.classList.remove('loading'); }

        _geocodeReceived++;
        clearTimeout(_groupRenderTimer);
        if (_geocodeReceived >= _geocodeExpected) {
          // All results received — render grouped list immediately
          _renderGroupedList();
        } else {
          // Partial update — render after a short pause
          _groupRenderTimer = setTimeout(_renderGroupedList, 600);
        }
      });

      window.tt.geocodeBatch({ points: clusters.map(c => ({ index: c.index, lat: c.lat, lng: c.lng })) })
        .catch(() => {})
        .finally(() => {
          if (_geocodeUnsub) { _geocodeUnsub(); _geocodeUnsub = null; }
          // Safety net: render even if received count didn't match expected
          clearTimeout(_groupRenderTimer);
          _renderGroupedList();
        });
    } catch (err) {
      if (hzList) hzList.innerHTML = `<div class="hz-list-hint" style="color:var(--red)">Error: ${_esc(err.message)}</div>`;
    }
  }

  function _initHzMap() {
    const container = document.getElementById('hz-map');
    if (!container || typeof L === 'undefined') return;
    if (_hzMap) { try { _hzMap.remove(); } catch {} _hzMap = null; }
    _hzMap = L.map('hz-map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_hzMap);
    _hzMap.setView([20, 0], 2);
  }

  function _renderHzClusters(clusters) {
    const hzList = document.getElementById('hz-list');
    if (!hzList) return;
    hzList.innerHTML = '<div class="hz-list-hint">Select home zones</div>';
    const bounds = [];
    _hzMarkers = [];
    for (const c of clusters) {
      const item = document.createElement('div');
      item.className = 'hz-item';
      item.dataset.index = c.index;
      item.innerHTML = `
        <div class="hz-num">${c.index + 1}</div>
        <div class="hz-item-info">
          <div class="hz-item-name loading">${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}</div>
          <div class="hz-item-count">${c.count.toLocaleString()} visits</div>
        </div>`;
      item.addEventListener('click', () => _toggleHz(c.index));
      hzList.appendChild(item);
      if (_hzMap) {
        bounds.push([c.lat, c.lng]);
        const icon = L.divIcon({
          html: `<div class="hz-pin" id="hz-pin-${c.index}">${c.index + 1}</div>`,
          className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        });
        const marker = L.marker([c.lat, c.lng], { icon }).addTo(_hzMap);
        marker.on('click', () => _toggleHz(c.index));
        _hzMarkers.push({ marker, index: c.index });
      }
    }
    if (_hzMap && bounds.length > 0) {
      try { _hzMap.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 8 }); } catch {}
      // Belt-and-suspenders: invalidate again after any remaining CSS transitions settle
      setTimeout(() => {
        try {
          _hzMap.invalidateSize();
          _hzMap.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 8 });
        } catch {}
      }, 300);
    }
  }

  function _toggleHz(index) {
    if (_hzChecked.has(index)) _hzChecked.delete(index);
    else _hzChecked.add(index);
    const item  = document.querySelector(`.hz-item[data-index="${index}"]`);
    if (item) item.classList.toggle('checked', _hzChecked.has(index));
    const pinEl = document.getElementById(`hz-pin-${index}`);
    if (pinEl) pinEl.classList.toggle('checked', _hzChecked.has(index));
    document.getElementById('btn-hz-confirm').disabled = _hzChecked.size === 0;
    // Refresh the country header meta line to show updated selection count
    const country = _hzClusters[index]?.country;
    if (country) {
      const header   = document.querySelector(`.hz-country-header[data-country="${CSS.escape(country)}"]`);
      const metaEl   = header?.querySelector('.hz-country-meta');
      if (metaEl) {
        const group    = _hzClusters.filter(c => c.country === country);
        const checked  = group.filter(c => _hzChecked.has(c.index)).length;
        const total    = group.reduce((s, c) => s + c.count, 0);
        const parts    = [`${group.length} location${group.length !== 1 ? 's' : ''}`,
                          `${total.toLocaleString()} photos`];
        if (checked) parts.push(`${checked} selected ✓`);
        metaEl.textContent = parts.join(' · ');
      }
    }
  }

  // ── Grouped list by country ─────────────────────────────────────────────────

  function _renderGroupedList() {
    const hzList = document.getElementById('hz-list');
    if (!hzList || !_hzClusters.length) return;

    // Group clusters by country
    const groups = {};
    for (const c of _hzClusters) {
      const key = c.country || '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }

    // Sort countries by total visit count descending
    const sorted = Object.entries(groups)
      .map(([country, list]) => ({ country, list, total: list.reduce((s, c) => s + c.count, 0) }))
      .sort((a, b) => b.total - a.total);

    // Preserve scroll position
    const scrollTop = hzList.scrollTop;
    hzList.innerHTML = '<div class="hz-list-hint">Select home zones</div>';

    for (const { country, list, total } of sorted) {
      const collapsed  = _collapsedCountries.has(country);
      const checked    = list.filter(c => _hzChecked.has(c.index)).length;
      const metaParts  = [`${list.length} location${list.length !== 1 ? 's' : ''}`,
                          `${total.toLocaleString()} photos`];
      if (checked) metaParts.push(`${checked} selected ✓`);

      const group = document.createElement('div');
      group.className = 'hz-country-group';
      group.innerHTML = `
        <div class="hz-country-header" data-country="${_esc(country)}">
          <span class="hz-country-arrow">${collapsed ? '▶' : '▼'}</span>
          <div class="hz-country-info">
            <span class="hz-country-name">${_esc(country)}</span>
            <span class="hz-country-meta">${metaParts.join(' · ')}</span>
          </div>
        </div>
        <div class="hz-country-items${collapsed ? ' collapsed' : ''}"></div>`;

      group.querySelector('.hz-country-header')
           .addEventListener('click', () => _toggleCountry(country));

      const itemsEl = group.querySelector('.hz-country-items');
      for (const c of list) {
        const cityName = c.name ? c.name.split(',')[0].trim()
                                : `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
        const item = document.createElement('div');
        item.className = 'hz-item' + (_hzChecked.has(c.index) ? ' checked' : '');
        item.dataset.index = c.index;
        item.innerHTML = `
          <div class="hz-num">${c.index + 1}</div>
          <div class="hz-item-info">
            <div class="hz-item-name${c.name ? '' : ' loading'}">${_esc(cityName)}</div>
            <div class="hz-item-count">${c.count.toLocaleString()} photos</div>
          </div>`;
        item.addEventListener('click', () => _toggleHz(c.index));
        itemsEl.appendChild(item);
      }
      hzList.appendChild(group);
    }
    hzList.scrollTop = scrollTop;
  }

  function _toggleCountry(country) {
    if (_collapsedCountries.has(country)) _collapsedCountries.delete(country);
    else _collapsedCountries.add(country);
    // Update arrow and items visibility without full re-render
    const header = document.querySelector(`.hz-country-header[data-country="${CSS.escape(country)}"]`);
    if (!header) { _renderGroupedList(); return; }
    const group   = header.closest('.hz-country-group');
    const items   = group?.querySelector('.hz-country-items');
    const arrow   = header.querySelector('.hz-country-arrow');
    const collapsed = _collapsedCountries.has(country);
    if (items) items.classList.toggle('collapsed', collapsed);
    if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
  }

  function closeHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (modal) modal.classList.remove('open');
    if (_geocodeUnsub) { _geocodeUnsub(); _geocodeUnsub = null; }
    clearTimeout(_groupRenderTimer); _groupRenderTimer = null;
    if (_hzMap) { try { _hzMap.remove(); } catch {} _hzMap = null; }
    _hzMarkers = [];
    _hzChecked.clear();
    _collapsedCountries.clear();
  }

  async function confirmHomeZones() {
    if (_hzChecked.size === 0) return;

    // Disable button immediately — prevents double-clicks and shows something happened
    const confirmBtn = document.getElementById('btn-hz-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Starting…'; }

    const homeZones = [..._hzChecked].map(i => ({ lat: _hzClusters[i].lat, lng: _hzClusters[i].lng }));
    closeHomeZoneModal();
    state.trips.computing = true;

    // Re-call _showTripsPanel(true) after the modal closes so the height is
    // recalculated against the actual window size (modal may have shifted layout)
    _showTripsPanel(true);
    _setTripsPanelState('computing');
    const msgEl = document.getElementById('trips-computing-msg');
    const subEl = document.getElementById('trips-computing-sub');
    const barEl = document.getElementById('trips-prog-bar');
    if (msgEl) msgEl.textContent = 'Preparing analysis…';
    if (subEl) subEl.textContent = '';
    if (barEl) barEl.style.width = '2%'; // show immediate activity

    if (state.trips.unsubEvent) state.trips.unsubEvent();
    state.trips.unsubEvent = window.tt.onTripsEvent((msg) => {
      if (msg.type === 'trips-status') {
        if (msgEl) msgEl.textContent = msg.message || 'Working…';

      } else if (msg.type === 'trips-progress') {
        const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
        if (barEl) barEl.style.width = Math.min(pct, 96) + '%'; // cap at 96 until done
        if (msgEl) msgEl.textContent = 'Classifying GPS points…';
        if (subEl) subEl.textContent = `${msg.done.toLocaleString()} of ${msg.total.toLocaleString()}`;

      } else if (msg.type === 'trips-done') {
        state.trips.computing = false;
        state.trips.computed  = true;
        if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
        if (barEl) barEl.style.width = '100%';
        if (msgEl) msgEl.textContent = `Found ${msg.count} trip${msg.count !== 1 ? 's' : ''} — loading…`;
        setTimeout(() => _loadAndRenderTrips(), 400);

      } else if (msg.type === 'trips-error') {
        state.trips.computing = false;
        if (state.trips.unsubEvent) { state.trips.unsubEvent(); state.trips.unsubEvent = null; }
        _setTripsPanelState('empty');
        if (msgEl) msgEl.textContent = 'Error computing trips';
        console.error('[Trips] worker error:', msg.message, msg.stack);
      }
    });

    await window.tt.computeTrips({ homeZones });
  }

// ── Home zone modal wiring ──────────────────────────────────────────────────────
document.getElementById('btn-compute-trips').addEventListener('click', () => Trips.openHomeZoneModal());
document.getElementById('btn-recompute-trips').addEventListener('click', async () => {
  await window.tt.resetTrips();
  Trips.reset();
  Trips.openHomeZoneModal();
});
document.getElementById('btn-hz-cancel').addEventListener('click', () => Trips.closeHomeZoneModal());
document.getElementById('btn-hz-confirm').addEventListener('click', () => Trips.confirmHomeZones());
document.getElementById('home-zone-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) Trips.closeHomeZoneModal();
});

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  await refreshLicenceStatus();
  showView('import');
  const stats = await window.tt.getStats();
  if (stats && stats.total > 0) updateSidebarStats(stats);

  // Check free space on working folder — warn if under 20GB
  try {
    const info = await window.tt.getWorkingFolder();
    if (info.freeBytes != null && info.freeBytes < 20 * 1e9) {
      const gb = (info.freeBytes / 1e9).toFixed(1);
      showDiskWarning(gb, info.workingFolder);
    }
  } catch {}
}

function showDiskWarning(gbFree, folder) {
  // Insert a warning banner into the import view if not already there
  if (document.getElementById('disk-warning')) return;
  const banner = document.createElement('div');
  banner.id = 'disk-warning';
  banner.style.cssText = `
    margin: 0 0 16px 0;
    background: var(--amber-lt);
    border: 1px solid var(--amber-border);
    border-radius: 5px;
    padding: 10px 14px;
    font-size: 12.5px;
    color: var(--amber);
    line-height: 1.6;
  `;
  banner.innerHTML = `
    <strong style="font-family:var(--mono);font-size:9px;letter-spacing:.08em;text-transform:uppercase">
      ⚠️ Low disk space — ${gbFree} GB free
    </strong><br>
    ${folder ? `Working folder: <code style="font-size:10px">${folder}</code><br>` : ''}
    Large archives need 50–200 GB free for extraction and thumbnails.
    <a href="#" id="disk-warning-settings" style="color:var(--acc);text-decoration:none;font-weight:500">
      Change working folder →
    </a>
  `;
  const importInner = document.querySelector('.import-inner');
  if (importInner) importInner.insertBefore(banner, importInner.firstChild);
  document.getElementById('disk-warning-settings')
    ?.addEventListener('click', (e) => { e.preventDefault(); openSettingsPanel(); });
}

init();
