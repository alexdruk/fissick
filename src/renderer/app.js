// src/renderer/app.js — Fissick renderer
// Vanilla JS. No frameworks. No build step.

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let licenceStatus = { licensed: false, trialLimit: 100 };
let _currentPagePhotos = []; // all photos currently rendered in photo-list, for lightbox navigation

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
  // ── Places
  placesComputed: false,
  // ── Albums — set when viewing a specific album's photos
  albumId:   null,
  albumName: null,
  // ── Trips ─────────────────────────────────────────────────────────────────────────────
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
  // Workflow step active state — results step stays active when in archive views
  const sbMap = { import: 'sb-import', processing: 'sb-process', results: 'sb-results' };
  document.getElementById(sbMap[name])?.classList.add('active');
  const labels = { import: 'Import', processing: 'Processing', results: 'Results' };
  document.getElementById('tb-phase').textContent = labels[name] || '';
  // Show/hide the archive sidebar section
  const sbArchive = document.getElementById('sb-archive');
  if (sbArchive) sbArchive.style.display = (name === 'results') ? 'flex' : 'none';
}

// Directly reset all view-results elements that panels may have hidden.
// Called before loadResults() and from sb-results click.
// Does NOT call _show*Panel() to avoid height-calculation side-effects
// on a still-hidden view.
function _forceResetResultsView() {
  const vr = document.getElementById('view-results');
  if (!vr) return;
  // Restore overflow
  vr.style.overflow = '';
  // Restore elements that panels hide
  const ids = [
    'photos-page-header', 'photo-list', 'export-bar',
    'date-range-bar', 'trial-banner', 'select-bar',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }
  const listFooter = vr.querySelector('.list-footer');
  const filterBar  = vr.querySelector('.filter-bar');
  const resultsHdr = vr.querySelector('.results-header');
  if (listFooter) listFooter.style.display = '';
  if (filterBar)  filterBar.style.display  = '';
  if (resultsHdr) resultsHdr.style.display = '';
  // Hide all panels
  ['trips-panel','albums-panel','places-panel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
  document.getElementById('albums-breadcrumb')?.classList.remove('visible');
  try { if (typeof PlaceDetailMap !== 'undefined') PlaceDetailMap.destroy(); } catch {}
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
document.getElementById('sb-import').addEventListener('click', () => showView('import'));
document.getElementById('sb-results').addEventListener('click', async () => {
  _forceResetResultsView();
  await loadResults();
  showView('results');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('sb-results').classList.add('active');
  document.getElementById('sb-photos')?.classList.add('active');
});
document.getElementById('sb-photos')?.addEventListener('click', async () => {
  if (state.view !== 'results') {
    await loadResults();
    showView('results');
  }
  // Switch to photo list, clear any special panels
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.filter-tab[data-filter="all"]')?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('sb-results').classList.add('active');
  document.getElementById('sb-photos')?.classList.add('active');
  _showMapPanel(false);
  _showTripsPanel(false);
  _showAlbumsPanel(false);
  _showPlacesPanel(false);
  // Clear any album view
  if (state.albumId != null) {
    state.albumId   = null;
    state.albumName = null;
    document.getElementById('albums-breadcrumb')?.classList.remove('visible');
  }
  state.filter = 'all';
  state.offset = 0;
  await loadPhotoPage(true);
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
  document.getElementById('sb-results').classList.add('active');
  document.getElementById('sb-trips').classList.add('active');
  _showMapPanel(false);
  _showAlbumsPanel(false);
  _showPlacesPanel(false);
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

  // Hide Map + Trips + Albums tabs -- will re-appear when data is found
  const mapTab    = document.getElementById('tab-map');
  const tripsTab  = document.getElementById('tab-trips');
  const albumsTab = document.getElementById('tab-albums');
  if (mapTab)    mapTab.style.display    = 'none';
  if (tripsTab)  tripsTab.style.display  = 'none';
  if (albumsTab) albumsTab.style.display = 'none';
  document.getElementById('sb-trips').style.display = 'none';
  const _sbAlbums0 = document.getElementById('sb-albums');
  if (_sbAlbums0) _sbAlbums0.style.display = 'none';
  const _sbPlaces0 = document.getElementById('sb-places');
  if (_sbPlaces0) _sbPlaces0.style.display = 'none';
  document.getElementById('tab-places')?.style && (document.getElementById('tab-places').style.display = 'none');
  const _sbArch0 = document.getElementById('sb-archive');
  if (_sbArch0) _sbArch0.style.display = 'none';
  _showMapPanel(false);
  _showTripsPanel(false);
  _showAlbumsPanel(false);
  _showPlacesPanel(false);
  Albums.reset();
  Places.reset();
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

async function checkForResumableRun() {
  try {
    const runState = await window.tt.getRunState();
    const banner   = document.getElementById('resume-banner');
    const sub      = document.getElementById('resume-banner-sub');
    if (!banner) return;
    if (runState && runState.processed > 0) {
      if (sub) sub.textContent = `${runState.processed.toLocaleString()} photos already processed — continue from where it stopped.`;
      banner.classList.add('visible');
      // Stash run state for the resume handler
      banner.dataset.runState = JSON.stringify(runState);
    } else {
      banner.classList.remove('visible');
    }
  } catch {}
}

async function resumeProcessing(savedRunState) {
  state.processing = true;

  // Do NOT call resetData() — keep the DB as-is so worker skips processed files
  const list = document.getElementById('photo-list');
  if (list) list.innerHTML = '';
  document.getElementById('results-stats-row').innerHTML = '';
  showTrialBanner(false);

  const mapTab    = document.getElementById('tab-map');
  const tripsTab  = document.getElementById('tab-trips');
  const albumsTab = document.getElementById('tab-albums');
  if (mapTab)    mapTab.style.display    = 'none';
  if (tripsTab)  tripsTab.style.display  = 'none';
  if (albumsTab) albumsTab.style.display = 'none';
  document.getElementById('sb-trips').style.display = 'none';
  document.getElementById('sb-albums')?.style && (document.getElementById('sb-albums').style.display = 'none');
  document.getElementById('sb-places')?.style && (document.getElementById('sb-places').style.display = 'none');
  document.getElementById('tab-places')?.style && (document.getElementById('tab-places').style.display = 'none');
  document.getElementById('sb-archive')?.style && (document.getElementById('sb-archive').style.display = 'none');
  _showMapPanel(false);
  _showTripsPanel(false);
  _showAlbumsPanel(false);
  _showPlacesPanel(false);

  resetProcessingUI();
  showView('processing');

  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = window.tt.onProcessEvent(handleProcessEvent);

  await window.tt.startProcessing({
    zipPaths:        savedRunState.zipPaths        || [],
    extractedFolder: savedRunState.extractedFolder || savedRunState.tempDir || null,
    isResume:        true,
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
            document.getElementById('sb-photos')?.classList.add('active');
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

    case 'albums-summary': {
      if (msg.total > 0) {
        const _tabA = document.getElementById('tab-albums');
        const _sbA  = document.getElementById('sb-albums');
        const _sbAS = document.getElementById('sb-albums-stat');
        if (_tabA) _tabA.style.display = '';
        if (_sbA)  _sbA.style.display  = '';
        if (_sbAS) _sbAS.textContent   = msg.total.toLocaleString();
      }
      logMsg(`Albums: ${msg.total} album(s) populated.`, 'ok');
      break;
    }

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

  _forceResetResultsView();
  // Show archive sidebar and activate Photos & Videos by default
  const _sbArchive = document.getElementById('sb-archive');
  if (_sbArchive) _sbArchive.style.display = 'flex';
  document.getElementById('sb-photos')?.classList.add('active');
  state.albumId    = null;
  state.albumName  = null;
  const _bcReset = document.getElementById('albums-breadcrumb');
  if (_bcReset) _bcReset.classList.remove('visible');
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

    // Location export buttons -- only meaningful when there is location data
    const btnGpx = document.getElementById('btn-export-gpx');
    const btnMap = document.getElementById('btn-export-map-html');
    const btnKml = document.getElementById('btn-export-kml');
    if (btnGpx) btnGpx.style.display = hasLoc ? '' : 'none';
    if (btnKml) btnKml.style.display = hasLoc ? '' : 'none';
    if (btnMap) btnMap.style.display = hasLoc ? '' : 'none';
  } catch {}

  // Update photos page header subtitle
  try {
    const _stats0 = await window.tt.getStats();
    const _subEl  = document.getElementById('photos-page-sub');
    if (_subEl && _stats0) {
      _subEl.textContent = `${(_stats0.total || 0).toLocaleString()} photos · ${(_stats0.fixed || 0).toLocaleString()} EXIF fixed`;
    }
  } catch {}

  // Trips stat in sidebar
  try {
    const _tripsData = await window.tt.getTrips({ limit: 1 });
    const _tripsStat = document.getElementById('sb-trips-stat');
    if (_tripsStat && _tripsData?.total > 0) _tripsStat.textContent = _tripsData.total.toLocaleString();
  } catch {}

  // Albums tab visibility
  try {
    const _albumsList = await window.tt.getAlbums();
    const _hasAlbums  = _albumsList && _albumsList.length > 0;
    const _tabAlbums  = document.getElementById('tab-albums');
    const _sbAlbumsN  = document.getElementById('sb-albums');
    const _sbAlbumsS  = document.getElementById('sb-albums-stat');
    if (_tabAlbums) _tabAlbums.style.display = _hasAlbums ? '' : 'none';
    if (_sbAlbumsN) _sbAlbumsN.style.display = _hasAlbums ? '' : 'none';
    if (_sbAlbumsS) _sbAlbumsS.textContent   = _hasAlbums ? _albumsList.length.toLocaleString() : '—';
  } catch {}

  // Places tab — show if there are GPS photos OR Timeline visits
  try {
    const _locStat    = await window.tt.getLocationStats();
    const _stats2     = await window.tt.getStats();
    const _hasVisits  = (_locStat?.visits || 0) > 0;
    const _hasGps     = (_stats2?.with_gps || 0) > 0;
    const _showPlaces = _hasVisits || _hasGps;
    const _tabPlaces  = document.getElementById('tab-places');
    const _sbPlacesN  = document.getElementById('sb-places');
    if (_tabPlaces) _tabPlaces.style.display = _showPlaces ? '' : 'none';
    if (_sbPlacesN) _sbPlacesN.style.display = _showPlaces ? '' : 'none';
    // Update places stat from DB if already computed
    const _placesList = await window.tt.getPlaces();
    const _sbPlacesS  = document.getElementById('sb-places-stat');
    if (_sbPlacesS) _sbPlacesS.textContent = _placesList.length > 0 ? _placesList.length.toLocaleString() : '—';
    if (_placesList.length > 0) state.placesComputed = true;
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
    let result;
    if (state.albumId != null) {
      result = await window.tt.getAlbumPhotos({
        albumId:  state.albumId,
        offset:   state.offset,
        limit:    state.limit,
        dateFrom: state.dateFrom,
        dateTo:   state.dateTo,
      });
    } else {
      result = await window.tt.getPhotos({ offset: state.offset, limit: state.limit, filter: state.filter, dateFrom: state.dateFrom, dateTo: state.dateTo, ext: state.ext });
    }
    if (!result) return;

    const { photos = [], total = 0 } = result;
    const list = document.getElementById('photo-list');
    if (!list) return;
    if (replace) { list.innerHTML = ''; _currentPagePhotos = []; }

    if (photos.length === 0 && replace) {
      list.innerHTML = '<div style="padding:40px 36px;color:var(--dim);font-size:13px">No photos found.</div>';
    }

    // Track all rendered photos for lightbox ←/→ navigation
    _currentPagePhotos = replace ? [...photos] : [..._currentPagePhotos, ...photos];

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
  } else if (isVideo && photo.thumbnail_path) {
    // Video with generated thumbnail — show it like an image
    thumbWrap.innerHTML = `<img class="photo-thumb" src="local://${thumbSrc}" loading="lazy" alt=""
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="photo-thumb-placeholder photo-thumb-video" style="display:none">🎬<span class="thumb-video-label">${ext.toUpperCase()}</span></div>`;
  } else if (isVideo) {
    thumbWrap.innerHTML = `<div class="photo-thumb-placeholder photo-thumb-video">🎬<span class="thumb-video-label">${ext.toUpperCase()}</span></div>`;
  } else {
    thumbWrap.innerHTML = `<div class="photo-thumb-placeholder">📄</div>`;
  }

  // Info cell — date is primary, filename secondary
  const dateStr = photo.date_ts
    ? new Date(photo.date_ts).toLocaleDateString('en', { year:'numeric', month:'short', day:'numeric' })
    : '—';
  const infoDiv = document.createElement('div');
  infoDiv.className = 'photo-info';
  infoDiv.innerHTML =
    `<div class="photo-date">${dateStr}</div>` +
    `<div class="photo-name" title="${photo.filename}">${photo.filename}</div>`;

  // EXIF status pill
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
  gpsSpan.innerHTML = photo.lat != null ? `<span class="tag tag-gps">GPS</span>` : '';

  // Sidecar source — dimmed mono text
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
      const idx = _currentPagePhotos.indexOf(photo);
      await openLightbox(photo, _currentPagePhotos, idx);
    });
  }

  return row;
}

document.getElementById('btn-back-results')?.addEventListener('click', async () => {
  // Confirm before wiping — processed data takes significant time to regenerate
  const confirmed = await window.tt.showConfirmDialog({
    title:   'Start over?',
    message: 'This will clear all processed photos and trips. You will need to re-process your archive.\n\nAre you sure?',
    buttons: ['Cancel', 'Clear & Start Over'],
  });
  if (!confirmed) return;

  await window.tt.resetData();
  await window.tt.resetTrips();
  Albums.reset();
  state.source    = {};
  state.albumId   = null;
  state.albumName = null;
  state.dateFrom  = null;
  state.dateTo    = null;
  state.ext       = null;
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
  const mapTab     = document.getElementById('tab-map');
  const tripsTab   = document.getElementById('tab-trips');
  const albumsTabB = document.getElementById('tab-albums');
  if (mapTab)     mapTab.style.display     = 'none';
  if (tripsTab)   tripsTab.style.display   = 'none';
  if (albumsTabB) albumsTabB.style.display = 'none';
  document.getElementById('sb-trips').style.display = 'none';
  const _sbAlbumsB  = document.getElementById('sb-albums');
  const _sbAlbumsSB = document.getElementById('sb-albums-stat');
  if (_sbAlbumsB)  _sbAlbumsB.style.display  = 'none';
  if (_sbAlbumsSB) _sbAlbumsSB.textContent   = '—';
  document.getElementById('sb-places')?.style && (document.getElementById('sb-places').style.display = 'none');
  document.getElementById('tab-places')?.style && (document.getElementById('tab-places').style.display = 'none');
  const _sbPlacesSB = document.getElementById('sb-places-stat');
  if (_sbPlacesSB) _sbPlacesSB.textContent = '—';
  state.placesComputed = false;
  _showPlacesPanel(false);
  const _sbArchB = document.getElementById('sb-archive');
  if (_sbArchB) _sbArchB.style.display = 'none';
  showView('import');
  checkForResumableRun();
});

// ── Filter tabs (including Map tab) ───────────────────────────────────────────
document.querySelectorAll('.filter-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    if (tab.dataset.filter === 'map') {
      _showTripsPanel(false);
      _showAlbumsPanel(false);
      _showMapPanel(true);
      LocationMap.onTabActivated();
    } else if (tab.dataset.filter === 'trips') {
      _showMapPanel(false);
      _showAlbumsPanel(false);
      _showTripsPanel(true);
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      document.getElementById('sb-trips').classList.add('active');
      Trips.onTabActivated();
    } else if (tab.dataset.filter === 'albums') {
      _showMapPanel(false);
      _showTripsPanel(false);
      _showPlacesPanel(false);
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      document.getElementById('sb-albums')?.classList.add('active');
      state.albumId   = null;
      state.albumName = null;
      const _bcAT = document.getElementById('albums-breadcrumb');
      if (_bcAT) _bcAT.classList.remove('visible');
      Albums.onTabActivated();
    } else if (tab.dataset.filter === 'places') {
      _showMapPanel(false);
      _showTripsPanel(false);
      _showAlbumsPanel(false);
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      document.getElementById('sb-places')?.classList.add('active');
      Places.onTabActivated();
    } else {
      _showMapPanel(false);
      _showTripsPanel(false);
      _showAlbumsPanel(false);
      _showPlacesPanel(false);
      // Clear album view when switching to a standard filter tab
      if (state.albumId != null) {
        state.albumId   = null;
        state.albumName = null;
        const _bcElse = document.getElementById('albums-breadcrumb');
        if (_bcElse) _bcElse.classList.remove('visible');
        // Restore selection UI that may have been hidden in album view
        const _selBar2    = document.getElementById('select-bar');
        const _exportBar2 = document.getElementById('export-bar');
        if (_selBar2)    _selBar2.style.display    = '';
        if (_exportBar2) _exportBar2.style.display = '';
      }
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
      const fyEl  = document.getElementById('dr-from-year');
      const tyEl  = document.getElementById('dr-to-year');
      const fdEl  = document.getElementById('dr-from-day');
      const tdEl  = document.getElementById('dr-to-day');
      if (fmSel) fmSel.value = '';
      if (tmSel) tmSel.value = '';
      if (fyEl)  fyEl.value  = '';
      if (tyEl)  tyEl.value  = '';
      if (fdEl)  fdEl.value  = '';
      if (tdEl)  tdEl.value  = '';
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
  const csvBtn    = document.getElementById('btn-export-csv');
  const copyBtn   = document.getElementById('btn-export-copy');
  const byDateBtn = document.getElementById('btn-export-by-date');
  const hasSelection = n > 0;
  if (csvBtn)    csvBtn.disabled    = !hasSelection;
  if (copyBtn)   copyBtn.disabled   = !hasSelection;
  if (byDateBtn) byDateBtn.disabled = false;
}

document.getElementById('btn-export-by-date')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const selectedPaths = [...state.selectedPaths];
  const hasSelection  = selectedPaths.length > 0;

  if (!hasSelection) {
    let total = 0;
    try { const s = await window.tt.getStats(); total = s?.total || 0; } catch {}
    const confirmed = await window.tt.showConfirmDialog({
      title:   'Export all photos by date?',
      message: `This will copy all ${total.toLocaleString()} photos into Year ⁄ Month folders. Are you sure?`,
      buttons: ['Cancel', 'Export All'],
    });
    if (!confirmed) return;
  }

  btn.disabled = true; btn.textContent = 'Exporting…';
  const result = await window.tt.exportByDate({ selectedPaths });
  if (!result.ok) {
    btn.disabled = false;
    btn.innerHTML = '<span class="eb-icon">📅</span> Export by Date';
    if (!result.canceled) _exportToast('Export failed: ' + result.error, true);
    return;
  }
  _runExportWithProgress(btn, '<span class="eb-icon">📅</span> Export by Date');
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

  // Ensure we're in photo list view, not trips/map
  _showTripsPanel(false);
  _showMapPanel(false);

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

// ── Generate Thumbnails — disabled: thumbnails generated during processing ──────
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

// ── Lightbox navigation state ─────────────────────────────────────────────────
// Populated when lightbox opens from a browsable list context
let _lbPhotos  = [];  // array of photo objects available for ←/→ navigation
let _lbIndex   = -1;  // index of currently shown photo in _lbPhotos

function _updateLbNavButtons() {
  const prev = document.getElementById('lightbox-prev');
  const next = document.getElementById('lightbox-next');
  if (!prev || !next) return;
  prev.classList.toggle('hidden', _lbIndex <= 0);
  next.classList.toggle('hidden', _lbIndex < 0 || _lbIndex >= _lbPhotos.length - 1);
}

async function openLightbox(photo, photoList, index) {
  // photoList and index are optional — pass them to enable ←/→ navigation
  _lbPhotos = photoList || [];
  _lbIndex  = index != null ? index : (_lbPhotos.length > 0 ? _lbPhotos.indexOf(photo) : -1);
  _updateLbNavButtons();
  const lb       = document.getElementById('lightbox');
  const lbImg    = document.getElementById('lightbox-img');
  const lbVideo  = document.getElementById('lightbox-video');
  const lbInfo   = document.getElementById('lightbox-info');
  if (!lb) return;

  // Move to body to escape any stacking context from overflow:hidden parents
  if (lb.parentNode !== document.body) document.body.appendChild(lb);

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
    lbImg.src = '';
    lbImg.alt = 'Converting…';
    try {
      const result = await window.tt.heicToJpeg({ filePath: photo.file_path });
      if (result.ok) {
        const encoded = result.tempPath.split('/').map(s => encodeURIComponent(s)).join('/');
        lbImg.src = `local://${encoded}`;
        lbImg.alt = '';
      } else {
        lbImg.alt = `Cannot display HEIC: ${result.error || 'conversion failed'}`;
        console.error('[lightbox] HEIC failed:', result.error);
      }
    } catch (err) {
      lbImg.alt = `Conversion failed: ${err.message}`;
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

// Resume banner
document.getElementById('btn-resume-processing')?.addEventListener('click', () => {
  const banner = document.getElementById('resume-banner');
  const saved  = banner?.dataset?.runState;
  if (!saved) return;
  try { resumeProcessing(JSON.parse(saved)); } catch {}
});
document.getElementById('btn-discard-run')?.addEventListener('click', async () => {
  document.getElementById('resume-banner')?.classList.remove('visible');
  await window.tt.resetData();
  await window.tt.resetTrips();
});

document.getElementById('lightbox-back-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeLightbox();
});
document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (_lbIndex > 0) { _lbIndex--; await openLightbox(_lbPhotos[_lbIndex], _lbPhotos, _lbIndex); }
});
document.getElementById('lightbox-next')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (_lbIndex < _lbPhotos.length - 1) { _lbIndex++; await openLightbox(_lbPhotos[_lbIndex], _lbPhotos, _lbIndex); }
});
document.addEventListener('keydown', async (e) => {
  const lb = document.getElementById('lightbox');
  if (!lb?.classList.contains('open')) {
    if (e.key === 'Escape') closeLicenceModal();
    return;
  }
  if (e.key === 'Escape') { closeLightbox(); return; }
  if (e.key === 'ArrowLeft'  && _lbIndex > 0) {
    _lbIndex--;
    await openLightbox(_lbPhotos[_lbIndex], _lbPhotos, _lbIndex);
  }
  if (e.key === 'ArrowRight' && _lbIndex >= 0 && _lbIndex < _lbPhotos.length - 1) {
    _lbIndex++;
    await openLightbox(_lbPhotos[_lbIndex], _lbPhotos, _lbIndex);
  }
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
  const thumbGenBar  = document.getElementById('thumb-gen-bar');
  const selBar       = document.getElementById('select-bar');
  if (!viewResults || !tripsPanel) return;

  const photosHdr = document.getElementById('photos-page-header');
  const filterBar = viewResults?.querySelector('.filter-bar');
  const resultsHdr = viewResults?.querySelector('.results-header');

  if (show) {
    [photoList, listFooter, trialBanner, selBar, exportBar, dateRangeBar, thumbGenBar]
      .forEach(el => { if (el) el.style.display = 'none'; });
    if (photosHdr)  photosHdr.style.display  = 'none';
    if (filterBar)  filterBar.style.display  = 'none';
    if (resultsHdr) resultsHdr.style.display = 'none';
    viewResults.style.overflow = 'hidden';
    const usedH = 0; // trips-panel has its own page-header
    tripsPanel.style.height = viewResults.clientHeight + 'px';
    tripsPanel.classList.add('visible');
  } else {
    tripsPanel.classList.remove('visible');
    viewResults.style.overflow = '';
    if (photosHdr)  photosHdr.style.display  = '';
    if (filterBar)  filterBar.style.display  = '';
    if (resultsHdr) resultsHdr.style.display = '';
    if (photoList)    photoList.style.display    = '';
    if (listFooter)   listFooter.style.display   = '';
    if (selBar)       selBar.style.display        = '';
    if (exportBar)    exportBar.style.display     = '';
    if (dateRangeBar) dateRangeBar.style.display  = '';
    if (thumbGenBar)  thumbGenBar.style.display   = '';
  }
}

// ── Places panel show/hide ──────────────────────────────────────────────────────────────────
function _showPlacesPanel(show) {
  const viewResults = document.getElementById('view-results');
  const photoList   = document.getElementById('photo-list');
  const listFooter  = viewResults?.querySelector('.list-footer');
  const trialBanner = document.getElementById('trial-banner');
  const placesPanel = document.getElementById('places-panel');
  const exportBar   = document.getElementById('export-bar');
  const dateRangeBar= document.getElementById('date-range-bar');
  const thumbGenBar = document.getElementById('thumb-gen-bar');
  const selBar      = document.getElementById('select-bar');
  if (!viewResults || !placesPanel) return;

  const photosHdrP = document.getElementById('photos-page-header');
  const filterBarP  = viewResults?.querySelector('.filter-bar');
  const resultsHdrP = viewResults?.querySelector('.results-header');

  if (show) {
    [photoList, listFooter, trialBanner, selBar, exportBar, dateRangeBar, thumbGenBar]
      .forEach(el => { if (el) el.style.display = 'none'; });
    if (photosHdrP)  photosHdrP.style.display  = 'none';
    if (filterBarP)  filterBarP.style.display  = 'none';
    if (resultsHdrP) resultsHdrP.style.display = 'none';
    viewResults.style.overflow = 'hidden';
    placesPanel.style.height = viewResults.clientHeight + 'px';
    placesPanel.classList.add('visible');
  } else {
    PlaceDetailMap.destroy();
    placesPanel.classList.remove('visible');
    viewResults.style.overflow = '';
    if (photosHdrP)  photosHdrP.style.display  = '';
    if (filterBarP)  filterBarP.style.display  = '';
    if (resultsHdrP) resultsHdrP.style.display = '';
    if (photoList)     photoList.style.display    = '';
    if (listFooter)    listFooter.style.display   = '';
    if (selBar)        selBar.style.display        = '';
    if (exportBar)     exportBar.style.display     = '';
    if (dateRangeBar)  dateRangeBar.style.display  = '';
    if (thumbGenBar)   thumbGenBar.style.display   = '';
  }
}

// ── Places module ─────────────────────────────────────────────────────────────────────────────────
const Places = (() => {
  'use strict';

  let _places = [];

  function _setPlacesPanelState(state) {
    // state: 'empty' | 'list' | 'detail'
    document.getElementById('places-empty').style.display  = state === 'empty'  ? '' : 'none';
    document.getElementById('places-list').style.display   = state === 'list'   ? '' : 'none';
    const det = document.getElementById('places-detail');
    if (state === 'detail') det.classList.add('visible');
    else                    det.classList.remove('visible');
  }

  async function onTabActivated() {
    _showPlacesPanel(true);
    if (state.placesComputed && _places.length > 0) {
      _setPlacesPanelState('list');
      _renderGrid();
      return;
    }
    // Check DB — may have been computed in a previous session
    try {
      _places = await window.tt.getPlaces();
      if (_places.length > 0) {
        state.placesComputed = true;
        _setPlacesPanelState('list');
        _renderGrid();
        return;
      }
    } catch {}
    _setPlacesPanelState('empty');
  }

  async function computePlaces() {
    _setPlacesPanelState('empty');
    const btn = document.getElementById('btn-compute-places');
    if (btn) { btn.textContent = 'Computing…'; btn.disabled = true; }

    try {
      const result = await window.tt.computePlaces();
      if (!result.ok) {
        if (btn) { btn.textContent = 'Compute Places'; btn.disabled = false; }
        alert('No GPS or location data found. Process your Takeout archive first.');
        return;
      }
      _places = await window.tt.getPlaces();
      state.placesComputed = true;
      // Update sidebar stat
      const sbStat = document.getElementById('sb-places-stat');
      if (sbStat) sbStat.textContent = _places.length.toLocaleString();
      _setPlacesPanelState('list');
      _renderGrid();
    } catch (err) {
      if (btn) { btn.textContent = 'Compute Places'; btn.disabled = false; }
      console.error('[Places] computePlaces error:', err);
    }
  }

  let _searchQuery = '';

  function _renderGrid() {
    const grid = document.getElementById('places-grid');
    if (!grid) return;
    const filtered = _searchQuery
      ? _places.filter(p => p.name.toLowerCase().includes(_searchQuery))
      : _places;
    const countEl = document.getElementById('places-list-count');
    if (countEl) {
      const suffix = _searchQuery ? ` matching “${_searchQuery}”` : '';
      countEl.textContent = filtered.length.toLocaleString() + ' place' + (filtered.length !== 1 ? 's' : '') + suffix;
    }
    grid.innerHTML = '';
    if (filtered.length === 0 && _searchQuery) {
      grid.innerHTML = '<div style="padding:40px 20px;color:var(--dim);font-family:var(--mono);font-size:11px">No places match that search.</div>';
      return;
    }
    for (const place of filtered) grid.appendChild(_renderCard(place));
  }

  function _renderCard(place) {
    const card = document.createElement('div');
    card.className = 'place-card';
    const thumbSrc = place.cover_thumbnail || place.cover_file_path;
    const thumbHtml = thumbSrc
      ? '<img class="place-thumb" src="local://' + thumbSrc + '" alt="" loading="lazy"' +
        ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<div class="place-thumb-placeholder" style="display:none">&#128205;</div>'
      : '<div class="place-thumb-placeholder">&#128205;</div>';
    const visits = place.visit_count || 0;
    const photos = place.photo_count || 0;
    const metaParts = [visits + ' visit' + (visits !== 1 ? 's' : '')];
    if (photos > 0) metaParts.push(photos + ' photo' + (photos !== 1 ? 's' : ''));
    card.innerHTML = thumbHtml +
      '<div class="place-info">' +
      '<div class="place-name" title="' + _aesc(place.name) + '">' + _aesc(place.name) + '</div>' +
      '<div class="place-meta">' + metaParts.join(' · ') + '</div>' +
      '</div>';
    card.addEventListener('click', () => _openDetail(place));
    return card;
  }

  async function _openDetail(place) {
    _setPlacesPanelState('detail');
    const titleEl = document.getElementById('places-detail-title');
    const metaEl  = document.getElementById('places-detail-meta');
    if (titleEl) titleEl.textContent = place.name;
    const visits = place.visit_count || 0;
    const photos = place.photo_count || 0;
    if (metaEl) metaEl.textContent =
      visits + ' visit' + (visits !== 1 ? 's' : '') +
      (photos > 0 ? ' · ' + photos + ' photo' + (photos !== 1 ? 's' : '') + ' nearby' : '');

    // Build photo strip
    const strip = document.getElementById('places-photo-strip');
    if (strip) strip.innerHTML = '';

    let detail;
    try { detail = await window.tt.getPlaceDetail({ placeId: place.id }); } catch {}

    const photos_data = detail?.photos || [];

    // Render photo strip
    if (strip) {
      for (const ph of photos_data) {
        const src = (ph.thumbnail_path || ph.file_path || '').split('/').map(encodeURIComponent).join('/');
        const img = document.createElement('img');
        img.className = 'place-strip-photo';
        img.src = 'local://' + src;
        img.alt = ph.filename || '';
        img.title = ph.filename || '';
        img.addEventListener('click', () => openLightbox(ph));
        strip.appendChild(img);
      }
    }

    // Render map
    await PlaceDetailMap.init(place, photos_data, (ph) => openLightbox(ph));
  }

  async function applySort(sortValue) {
    try { _places = await window.tt.getPlaces({ sort: sortValue }); } catch { return; }
    _renderGrid();
  }

  function setSearch(q) {
    _searchQuery = q.toLowerCase().trim();
    _renderGrid();
  }

  function reset() {
    _places = [];
    _searchQuery = '';
    const searchEl = document.getElementById('places-search');
    if (searchEl) searchEl.value = '';
    state.placesComputed = false;
    PlaceDetailMap.destroy();
  }

  function _aesc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { onTabActivated, computePlaces, applySort, reset, setSearch };
})();

// Places: compute + recompute buttons
document.getElementById('btn-compute-places')?.addEventListener('click', () => Places.computePlaces());
document.getElementById('btn-recompute-places')?.addEventListener('click', () => Places.computePlaces());

// Places: back button
document.getElementById('btn-places-back')?.addEventListener('click', async () => {
  PlaceDetailMap.destroy();
  document.getElementById('places-detail')?.classList.remove('visible');
  document.getElementById('places-list').style.display = '';
  document.getElementById('places-empty').style.display = 'none';
});

// Places: sort selector
document.getElementById('places-sort-select')?.addEventListener('change', (e) => {
  Places.applySort(e.target.value);
});

// Places: search input
document.getElementById('places-search')?.addEventListener('input', (e) => {
  const val = e.target.value;
  Places.setSearch(val);
  const clearBtn = document.getElementById('places-search-clear');
  if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
});

// Places: search clear button
document.getElementById('places-search-clear')?.addEventListener('click', () => {
  const input = document.getElementById('places-search');
  if (input) { input.value = ''; input.focus(); }
  document.getElementById('places-search-clear').style.display = 'none';
  Places.setSearch('');
});

// sb-places sidebar click
document.getElementById('sb-places')?.addEventListener('click', async () => {
  if (state.view !== 'results') {
    await loadResults();
    showView('results');
  }
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.filter-tab[data-filter="places"]')?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('sb-places')?.classList.add('active');
  _showMapPanel(false);
  _showTripsPanel(false);
  _showAlbumsPanel(false);
  document.getElementById('sb-results')?.classList.add('active');
  Places.onTabActivated();
});

// ── Albums panel show/hide ─────────────────────────────────────────────────────────
function _showAlbumsPanel(show) {
  const viewResults  = document.getElementById('view-results');
  const photoList    = document.getElementById('photo-list');
  const listFooter   = viewResults?.querySelector('.list-footer');
  const trialBanner  = document.getElementById('trial-banner');
  const albumsPanel  = document.getElementById('albums-panel');
  const exportBar    = document.getElementById('export-bar');
  const dateRangeBar = document.getElementById('date-range-bar');
  const thumbGenBar  = document.getElementById('thumb-gen-bar');
  const selBar       = document.getElementById('select-bar');
  if (!viewResults || !albumsPanel) return;

  const photosHdrA = document.getElementById('photos-page-header');
  const filterBarA = viewResults?.querySelector('.filter-bar');
  const resultsHdrA = viewResults?.querySelector('.results-header');

  if (show) {
    [photoList, listFooter, trialBanner, selBar, exportBar, dateRangeBar, thumbGenBar]
      .forEach(el => { if (el) el.style.display = 'none'; });
    document.getElementById('albums-breadcrumb')?.classList.remove('visible');
    if (photosHdrA)  photosHdrA.style.display  = 'none';
    if (filterBarA)  filterBarA.style.display  = 'none';
    if (resultsHdrA) resultsHdrA.style.display = 'none';
    viewResults.style.overflow = 'hidden';
    albumsPanel.style.height = viewResults.clientHeight + 'px';
    albumsPanel.classList.add('visible');
  } else {
    albumsPanel.classList.remove('visible');
    viewResults.style.overflow = '';
    if (photosHdrA)  photosHdrA.style.display  = '';
    if (filterBarA)  filterBarA.style.display  = '';
    if (resultsHdrA) resultsHdrA.style.display = '';
    if (photoList)    photoList.style.display    = '';
    if (listFooter)   listFooter.style.display   = '';
    if (selBar)       selBar.style.display        = '';
    if (exportBar)    exportBar.style.display     = '';
    if (dateRangeBar) dateRangeBar.style.display  = '';
    if (thumbGenBar)  thumbGenBar.style.display   = '';
  }
}

// ── Albums module ──────────────────────────────────────────────────────────────────────
const Albums = (() => {
  'use strict';

  let _albums = [];

  async function onTabActivated() {
    state.albumId   = null;
    state.albumName = null;
    document.getElementById('albums-breadcrumb')?.classList.remove('visible');
    _showAlbumsPanel(true);
    await _loadAndRender();
  }

  async function _loadAndRender() {
    const grid = document.getElementById('albums-grid');
    if (!grid) return;
    grid.innerHTML = '';

    _albums = await window.tt.getAlbums();

    const countEl = document.getElementById('albums-count');
    if (countEl) {
      countEl.textContent = _albums.length.toLocaleString() + ' album' + (_albums.length !== 1 ? 's' : '');
    }

    if (_albums.length === 0) {
      grid.innerHTML =
        '<div style="padding:40px 28px;color:var(--dim);font-size:13px;line-height:1.9">' +
        'No albums found in this archive.<br>' +
        '<span style="font-family:var(--mono);font-size:10px">Albums appear when your Takeout ' +
        'includes named album folders inside Google Photos.</span></div>';
      return;
    }

    const gridWrap = document.createElement('div');
    gridWrap.className = 'albums-grid';
    for (const album of _albums) gridWrap.appendChild(_renderCard(album));
    grid.appendChild(gridWrap);
  }

  function _renderCard(album) {
    const card = document.createElement('div');
    card.className = 'album-card';

    const thumbSrc = album.cover_thumbnail || album.cover_file_path;
    const thumbHtml = thumbSrc
      ? '<img class="album-thumb" src="local://' + thumbSrc + '" alt="" loading="lazy"' +
        ' onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
        '<div class="album-thumb-placeholder" style="display:none">&#128193;</div>'
      : '<div class="album-thumb-placeholder">&#128193;</div>';

    const infoHtml =
      '<div class="album-info">' +
      '<div class="album-name" title="' + _aesc(album.name) + '">' + _aesc(album.name) + '</div>' +
      '<div class="album-count">' + album.photo_count.toLocaleString() +
        ' photo' + (album.photo_count !== 1 ? 's' : '') + '</div>' +
      '</div>';

    card.innerHTML = thumbHtml + infoHtml;
    card.addEventListener('click', () => _enterAlbumView(album));
    return card;
  }

  async function _enterAlbumView(album) {
    state.albumId   = album.id;
    state.albumName = album.name;
    state.offset    = 0;
    state.filter    = 'all';
    state.selectedPaths.clear();

    _showAlbumsPanel(false);

    // Hide date range bar — date filtering not supported in album view
    const drb = document.getElementById('date-range-bar');
    if (drb) drb.style.display = 'none';

    const bc     = document.getElementById('albums-breadcrumb');
    const nameEl = document.getElementById('albums-breadcrumb-name');
    if (bc)     bc.classList.add('visible');
    if (nameEl) nameEl.textContent = album.name;

    await loadPhotoPage(true);
  }

  function exitAlbumView() {
    state.albumId   = null;
    state.albumName = null;
    state.offset    = 0;
    state.selectedPaths.clear();
    // Restore date range bar
    const drb = document.getElementById('date-range-bar');
    if (drb) drb.style.display = '';
    document.getElementById('albums-breadcrumb')?.classList.remove('visible');
    _showAlbumsPanel(true);
  }

  function reset() {
    _albums         = [];
    state.albumId   = null;
    state.albumName = null;
    document.getElementById('albums-breadcrumb')?.classList.remove('visible');
  }

  function applySort(sortValue) {
    const SORTERS = {
      'name-asc':   (a, b) => a.name.localeCompare(b.name),
      'name-desc':  (a, b) => b.name.localeCompare(a.name),
      'count-desc': (a, b) => b.photo_count - a.photo_count,
      'count-asc':  (a, b) => a.photo_count - b.photo_count,
    };
    const fn = SORTERS[sortValue] || SORTERS['name-asc'];
    _albums.sort(fn);

    const grid = document.getElementById('albums-grid');
    if (!grid) return;
    const gridWrap = grid.querySelector('.albums-grid');
    if (!gridWrap) return;
    // Re-render cards in new order (cheap — no new DOM for each, just reorder)
    gridWrap.innerHTML = '';
    for (const album of _albums) gridWrap.appendChild(_renderCard(album));
  }

  function _aesc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { onTabActivated, exitAlbumView, reset, applySort };
})();

document.getElementById('albums-breadcrumb-back')?.addEventListener('click', () => Albums.exitAlbumView());

// Albums sort selector — sorts the album cards grid
document.getElementById('albums-sort-select')?.addEventListener('change', (e) => {
  if (state.albumId != null) return; // ignore when inside an album's photo list
  Albums.applySort(e.target.value);
});

document.getElementById('sb-albums')?.addEventListener('click', async () => {
  if (state.view !== 'results') {
    await loadResults();
    showView('results');
  }
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.filter-tab[data-filter="albums"]')?.classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  document.getElementById('sb-albums')?.classList.add('active');
  _showMapPanel(false);
  _showTripsPanel(false);
  _showPlacesPanel(false);
  state.albumId   = null;
  state.albumName = null;
  document.getElementById('albums-breadcrumb')?.classList.remove('visible');
  document.getElementById('sb-results')?.classList.add('active');
  Albums.onTabActivated();
});

// ── Trips module ───────────────────────────────────────────────────────────────
const Trips = (() => {
  'use strict';

  // ── Home zone state ──────────────────────────────────────────────────────────
  let _homeZones      = [];  // [{ lat, lng, name, countryCode }]
  let _hzConfirmMap   = null;
  let _hzConfirmResult = null;  // current search result awaiting confirmation

  // ── List + detail state ───────────────────────────────────────────────────
  let _currentSort       = 'chrono';
  let _sortListenerAdded = false;
  let _activeTrip        = null;
  let _allTrips          = [];    // full unfiltered list
  let _searchQuery       = '';
  let _searchListenerAdded = false;

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
    if (!_searchListenerAdded) {
      const inp  = document.getElementById('trips-search-input');
      const clr  = document.getElementById('trips-search-clear');
      if (inp) {
        inp.addEventListener('input', (e) => {
          _searchQuery = e.target.value.trim().toLowerCase();
          if (clr) clr.style.display = _searchQuery ? '' : 'none';
          _renderFilteredCards();
        });
        // Hook for autocomplete to trigger filter with selected value
        window._tripsSearchTrigger = (val) => {
          if (!_allTrips.length) return;
          _searchQuery = val.toLowerCase();
          _renderFilteredCards();
        };
      }
      if (clr) {
        clr.addEventListener('click', () => {
          _searchQuery = '';
          if (inp) { inp.value = ''; inp.focus(); }
          clr.style.display = 'none';
          _renderFilteredCards();
        });
      }
      _searchListenerAdded = true;
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
    TripMaps.destroyAll();
    _allTrips    = [];
    _searchQuery = '';
    const inp = document.getElementById('trips-search-input');
    const clr = document.getElementById('trips-search-clear');
    if (inp) inp.value = '';
    if (clr) clr.style.display = 'none';
    _setTripsPanelState('empty');
  }

  // ── Panel state ────────────────────────────────────────────────────────────

  function _showEmpty() {
    _setTripsPanelState('empty');
    const btn = document.getElementById('btn-recompute-trips-empty');
    if (btn) btn.style.display = state.trips.computed ? '' : 'none';
  }
  function _showComputing(message) {
    _setTripsPanelState('computing');
    const msg = document.getElementById('trips-computing-msg');
    if (msg && message) msg.textContent = message;
  }

  function _setTripsPanelState(mode) {
    const empty     = document.getElementById('trips-empty');
    const computing = document.getElementById('trips-computing');
    const list      = document.getElementById('trips-list');
    const detail    = document.getElementById('trips-detail');
    if (!empty || !computing || !list) return;
    empty.style.display     = mode === 'empty'     ? '' : 'none';
    computing.style.display = mode === 'computing' ? '' : 'none';
    list.style.display      = mode === 'list'      ? '' : 'none';
    if (detail) detail.classList.toggle('visible', mode === 'detail');
  }

  // ── Trip card list ─────────────────────────────────────────────────────────

  async function _loadAndRenderTrips() {
    _setTripsPanelState('list');
    TripMaps.destroyAll();
    const ORDER = {
      'chrono':        'start_ts ASC',
      'chrono-desc':   'start_ts DESC',
      'country':       'name ASC, start_ts ASC',
      'country-desc':  'name DESC, start_ts ASC',
      'photos':        'photo_count DESC, start_ts ASC',
      'photos-asc':    'photo_count ASC, start_ts ASC',
      'distance':      'distance_km DESC, start_ts ASC',
      'distance-asc':  'distance_km ASC, start_ts ASC',
    };
    const { trips, total } = await window.tt.getTrips({
      limit: 200, orderBy: ORDER[_currentSort] || 'start_ts ASC',
    });
    const sortSel = document.getElementById('trips-sort-select');
    if (sortSel) sortSel.value = _currentSort;
    _allTrips = trips;
    window._allTripsForAc = trips;
    _renderFilteredCards();

    // Auto-fix trips with fallback names or ISO code as country (e.g. "Phnom Penh, KH")
    const fallbackCount = trips.filter(t =>
      /^Trip [A-Z]/.test(t.name || '') ||
      !t.name ||
      (t.country_code && t.name?.endsWith(', ' + t.country_code)) ||
      (t.country_code && !t.country)
    ).length;
    if (fallbackCount > 0) {
      console.log(`[fossick] ${fallbackCount} trips need name repair — triggering re-geocode…`);
      window.tt.fixFallbackNames().catch(() => {});
    }
    if (state.trips.unsubName) state.trips.unsubName();
    state.trips.unsubName = window.tt.onTripNameUpdate(({ tripId, name, countryCode }) => {
      const card = document.querySelector(`.trip-card[data-trip-id="${tripId}"]`);
      if (!card) return;
      const nameEl = card.querySelector('.tc-name');
      const flagEl = card.querySelector('.tc-flag');
      if (nameEl && name) nameEl.textContent = name;
      if (flagEl && countryCode) flagEl.textContent = _flag(countryCode);
    });
  }

  function _renderFilteredCards() {
    const list = document.getElementById('trips-list');
    if (!list || !_allTrips.length) return;
    [...list.querySelectorAll('.trip-card, .trips-no-results')].forEach(el => el.remove());

    const q = _searchQuery;
    const filtered = q
      ? _allTrips.filter(t => {
          const year = t.start_ts ? new Date(t.start_ts).getFullYear().toString() : '';
          return (t.name || '').toLowerCase().includes(q)
              || year.includes(q);
        })
      : _allTrips;

    // Update count to reflect current filter
    const countEl = document.getElementById('trips-list-count');
    if (countEl) {
      const n = filtered.length;
      countEl.textContent = q
        ? `${n} of ${_allTrips.length} trip${_allTrips.length !== 1 ? 's' : ''}`
        : `${_allTrips.length.toLocaleString()} trip${_allTrips.length !== 1 ? 's' : ''}`;
    }

    if (filtered.length === 0 && q) {
      const msg = document.createElement('div');
      msg.className = 'trips-no-results';
      msg.textContent = `No trips matching "${q}"`;
      list.appendChild(msg);
      return;
    }

    for (const trip of filtered) list.appendChild(_renderTripCard(trip));
  }

  function _renderTripCard(trip) {
    const card = document.createElement('div');
    card.className = 'trip-card';
    card.dataset.tripId = trip.id;
    const start  = new Date(trip.start_ts);
    const end    = new Date(trip.end_ts);
    const days   = Math.max(1, Math.round((trip.end_ts - trip.start_ts) / 86400000) + 1);
    const fmt    = d => d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    const sameDayStr = start.toDateString() === end.toDateString();
    const dateStr = sameDayStr ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
    const flag   = _flag(trip.country_code);
    const distStr = trip.distance_km != null ? `${Math.round(trip.distance_km).toLocaleString()} km from home` : '';
    const thumbSrc = trip.cover_thumbnail || trip.cover_file_path;
    const thumbHtml = thumbSrc
      ? `<img class="tc-thumb" src="local://${thumbSrc}" alt="" loading="lazy"` +
        ` onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`  +
        `<div class="tc-thumb-placeholder" style="display:none">✈️</div>`
      : `<div class="tc-thumb-placeholder">✈️</div>`;
    card.innerHTML =
      thumbHtml +
      `<div class="tc-flag">${_esc(flag)}</div>` +
      `<div class="tc-body">` +
        `<div class="tc-name">${_esc(trip.name)}</div>` +
        `<div class="tc-meta">${_esc(dateStr)} · ${days} day${days !== 1 ? 's' : ''}</div>` +
        `<div class="tc-stats">` +
          `<span class="tc-stat">${(trip.photo_count || 0).toLocaleString()} photos</span>` +
          (distStr ? `<span class="tc-stat tc-stat-dist" title="Distance from the nearest home zone">${_esc(distStr)}</span>` : '') +
        `</div>` +
      `</div>` +
      `<div class="tc-arrow">›</div>`;

    // Single click anywhere on card → open detail.
    // Double-click specifically on the name → rename.
    // _renaming flag blocks _openDetail while input is active.
    card.addEventListener('click', () => _openDetail(trip));
    return card;
  }


  // ── Trip detail view ───────────────────────────────────────────────────────

  async function _openDetail(trip) {
    _activeTrip = trip;
    _setTripsPanelState('detail');
    const titleEl = document.getElementById('trips-detail-title');
    const metaEl  = document.getElementById('trips-detail-meta');
    const fmt     = d => new Date(d).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    const days    = Math.max(1, Math.round((trip.end_ts - trip.start_ts) / 86400000) + 1);
    const flag    = _flag(trip.country_code);
    if (titleEl) titleEl.textContent = `${flag} ${trip.name}`;
    if (metaEl)  metaEl.textContent  =
      `${fmt(trip.start_ts)} – ${fmt(trip.end_ts)} · ${days} days · ${(trip.photo_count||0).toLocaleString()} photos`;
    await TripDetailMap.init('trips-detail-map', trip.id, (photo) => { openLightbox(photo); });
  }

  function _closeDetail() {
    TripDetailMap.destroy();
    _activeTrip = null;
    _loadAndRenderTrips(); // re-renders cards and re-registers mini-maps
  }

  // ── Computing state ─────────────────────────────────────────────────────────

  async function confirmHomeZones() {
    const homeZones = _homeZones.map(h => ({ lat: h.lat, lng: h.lng }));
    if (homeZones.length === 0) return;
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

  // ── Home zone search modal ─────────────────────────────────────────────────

  async function openHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (!modal) return;
    _homeZones = [];
    _hzConfirmResult = null;
    _renderHomesList();
    _clearConfirmCard();
    document.getElementById('hz-search-input').value = '';
    document.getElementById('hz-search-status').textContent = '';
    document.getElementById('btn-hz-confirm').disabled = true;
    modal.classList.add('open');
    setTimeout(() => document.getElementById('hz-search-input')?.focus(), 80);
  }

  function closeHomeZoneModal() {
    const modal = document.getElementById('home-zone-modal');
    if (modal) modal.classList.remove('open');
    if (_hzConfirmMap) { try { _hzConfirmMap.remove(); } catch {} _hzConfirmMap = null; }
    _hzConfirmResult = null;
  }

  async function _doSearch() {
    const input  = document.getElementById('hz-search-input');
    const status = document.getElementById('hz-search-status');
    const btn    = document.getElementById('hz-search-btn');
    const query  = input?.value?.trim();
    if (!query) return;

    btn.disabled = true;
    status.textContent = 'Searching…';
    _clearConfirmCard();

    try {
      const res = await window.tt.searchLocation({ query });
      btn.disabled = false;
      if (!res || res.error) {
        status.textContent = `Search failed: ${res?.error || 'unknown error'}`;
        return;
      }
      if (!res.results || res.results.length === 0) {
        status.textContent = 'No results found. Try a different spelling.';
        return;
      }
      status.textContent = '';
      _showConfirmCard(res.results[0]);
    } catch (err) {
      btn.disabled = false;
      status.textContent = `Search failed: ${err.message}`;
    }
  }

  function _showConfirmCard(result) {
    _hzConfirmResult = result;
    const card    = document.getElementById('hz-confirm-card');
    const nameEl  = document.getElementById('hz-confirm-name');
    const detail  = document.getElementById('hz-confirm-detail');
    if (nameEl) nameEl.textContent = result.name;
    if (detail) detail.textContent = result.displayName;
    card.style.display = '';

    // Small preview map
    if (_hzConfirmMap) { try { _hzConfirmMap.remove(); } catch {} _hzConfirmMap = null; }
    if (typeof L !== 'undefined') {
      requestAnimationFrame(() => {
        _hzConfirmMap = L.map('hz-confirm-map', { zoomControl: false, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_hzConfirmMap);
        L.circleMarker([result.lat, result.lng], {
          radius: 8, fillColor: '#b85c2c', color: '#8a3a10', weight: 2, fillOpacity: 0.9,
        }).addTo(_hzConfirmMap);
        _hzConfirmMap.setView([result.lat, result.lng], 10);
        setTimeout(() => { try { _hzConfirmMap.invalidateSize(); } catch {} }, 80);
      });
    }
  }

  function _clearConfirmCard() {
    const card = document.getElementById('hz-confirm-card');
    if (card) card.style.display = 'none';
    if (_hzConfirmMap) { try { _hzConfirmMap.remove(); } catch {} _hzConfirmMap = null; }
    _hzConfirmResult = null;
  }

  function _confirmLocation() {
    if (!_hzConfirmResult) return;
    _homeZones.push(_hzConfirmResult);
    _renderHomesList();
    _clearConfirmCard();
    const input = document.getElementById('hz-search-input');
    const status = document.getElementById('hz-search-status');
    if (input) { input.value = ''; input.focus(); }
    if (status) status.textContent = `✓ Added. Search for another home, or click Confirm.`;
    document.getElementById('btn-hz-confirm').disabled = false;
  }

  function _removeHome(index) {
    _homeZones.splice(index, 1);
    _renderHomesList();
    document.getElementById('btn-hz-confirm').disabled = _homeZones.length === 0;
  }

  function _renderHomesList() {
    const list  = document.getElementById('hz-homes-list');
    const empty = document.getElementById('hz-homes-empty');
    if (!list) return;
    [...list.querySelectorAll('.hz-home-item')].forEach(el => el.remove());
    if (_homeZones.length === 0) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    _homeZones.forEach((h, i) => {
      const item = document.createElement('div');
      item.className = 'hz-home-item';
      item.innerHTML = `
        <div class="hz-home-icon">${_esc(_flag(h.countryCode))}</div>
        <div class="hz-home-info">
          <div class="hz-home-name">${_esc(h.name)}</div>
          <div class="hz-home-coords">${h.lat.toFixed(3)}, ${h.lng.toFixed(3)}</div>
        </div>
        <button class="hz-home-remove" title="Remove">✕</button>`;
      item.querySelector('.hz-home-remove').addEventListener('click', () => _removeHome(i));
      list.appendChild(item);
    });
  }

  return {
    onTabActivated, reset,
    openHomeZoneModal, closeHomeZoneModal, confirmHomeZones,
    doSearch: _doSearch, confirmLocation: _confirmLocation,
    showConfirmFromResult: _showConfirmCard,
    closeDetail: _closeDetail,
  };
})();

document.getElementById('btn-trips-back').addEventListener('click', () => Trips.closeDetail());

// ── Home zone modal wiring ──────────────────────────────────────────────────────
document.getElementById('btn-compute-trips').addEventListener('click', () => Trips.openHomeZoneModal());

async function _recomputeTrips() {
  await window.tt.resetTrips();
  Trips.reset();
  Trips.openHomeZoneModal();
}
document.getElementById('btn-recompute-trips').addEventListener('click', _recomputeTrips);
document.getElementById('btn-recompute-trips-empty').addEventListener('click', _recomputeTrips);

document.getElementById('hz-search-btn').addEventListener('click', () => Trips.doSearch());
document.getElementById('hz-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') Trips.doSearch();
});
document.getElementById('hz-confirm-yes').addEventListener('click', () => Trips.confirmLocation());
document.getElementById('hz-confirm-no').addEventListener('click', () => {
  document.getElementById('hz-confirm-card').style.display = 'none';
  document.getElementById('hz-search-status').textContent = 'Try a more specific search.';
  document.getElementById('hz-search-input').focus();
});
document.getElementById('btn-hz-cancel').addEventListener('click', () => Trips.closeHomeZoneModal());
document.getElementById('btn-hz-confirm').addEventListener('click', () => Trips.confirmHomeZones());
document.getElementById('home-zone-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) Trips.closeHomeZoneModal();
});

// ── Autocomplete utility ────────────────────────────────────────────────────────
// Autocomplete(inputId, dropdownId, getSuggestions, onSelect)
// getSuggestions(query) → Promise<[{label, sub, value}]>
// onSelect(item) → called when user picks a suggestion
function Autocomplete(inputId, dropdownId, getSuggestions, onSelect) {
  const inp  = document.getElementById(inputId);
  const drop = document.getElementById(dropdownId);
  if (!inp || !drop) return;

  let _timer = null, _focused = -1, _items = [];

  function _show(items) {
    _items   = items;
    _focused = -1;
    drop.innerHTML = '';
    if (!items.length) { drop.style.display = 'none'; return; }
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'autocomplete-item';
      el.innerHTML = `<div>${_acEsc(item.label)}</div>` +
        (item.sub ? `<div class="autocomplete-sub">${_acEsc(item.sub)}</div>` : '');
      el.addEventListener('mousedown', (e) => { e.preventDefault(); _pick(i); });
      drop.appendChild(el);
    });
    drop.style.display = '';
  }

  function _hide() { drop.style.display = 'none'; _focused = -1; _items = []; }

  function _pick(i) {
    const item = _items[i];
    if (!item) return;
    inp.value = item.label;
    _hide();
    onSelect(item);
  }

  function _highlight(dir) {
    const els = drop.querySelectorAll('.autocomplete-item');
    if (!els.length) return;
    els[_focused]?.classList.remove('focused');
    _focused = (_focused + dir + els.length) % els.length;
    els[_focused]?.classList.add('focused');
  }

  inp.addEventListener('input', () => {
    clearTimeout(_timer);
    const q = inp.value.trim();
    if (q.length < 2) { _hide(); return; }
    _timer = setTimeout(async () => {
      const suggestions = await getSuggestions(q);
      _show(suggestions);
    }, 250);
  });

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); _highlight(1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); _highlight(-1); }
    else if (e.key === 'Enter' && _focused >= 0) { e.stopPropagation(); _pick(_focused); }
    else if (e.key === 'Escape') _hide();
  });

  inp.addEventListener('blur', () => setTimeout(_hide, 150));
}

function _acEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Trip search autocomplete ────────────────────────────────────────────────────
Autocomplete(
  'trips-search-input',
  'trips-search-dropdown',
  async (q) => {
    if (!q) return [];
    const ql = q.toLowerCase();
    const matches = (window._allTripsForAc || []).filter(t =>
      (t.name || '').toLowerCase().includes(ql) ||
      (t.start_ts ? new Date(t.start_ts).getFullYear().toString() : '').includes(ql)
    ).slice(0, 8);
    return matches.map(t => ({
      label: t.name || 'Trip',
      sub:   t.start_ts ? new Date(t.start_ts).getFullYear().toString() : '',
      value: t,
    }));
  },
  (item) => {
    const inp = document.getElementById('trips-search-input');
    const clr = document.getElementById('trips-search-clear');
    if (inp) inp.value = item.label;
    if (clr) clr.style.display = '';
    // Trigger filter
    window._tripsSearchTrigger?.(item.label);
  }
);

// ── Home zone search autocomplete — disabled (Nominatim rate limit: 1 req/sec)
// The Search button fires a single request on demand instead.
// Autocomplete(
//   'hz-search-input', 'hz-search-dropdown', ...
// );
async function init() {
  await checkForResumableRun();
  await refreshLicenceStatus();
  const stats = await window.tt.getStats();
  if (stats && stats.total > 0) {
    updateSidebarStats(stats);
    await loadResults();
    showView('results');
  } else {
    showView('import');
  }

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
