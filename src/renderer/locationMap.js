// src/renderer/locationMap.js  — Module 2: Location Timeline map
// Called from app.js:
//   LocationMap.onTabActivated()        — when the Map filter-tab is clicked
//   LocationMap.onLocationSummary(msg)  — when a 'location-summary' event arrives

'use strict';

const LocationMap = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let map          = null;
  let clusterGroup = null;
  let visitLayer   = null;
  let initialised  = false;
  let loadedOnce   = false;
  let dataEarliestTs = null;
  let dataLatestTs   = null;
  let _mapMoved      = false;

  function el(id) { return document.getElementById(id); }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function onTabActivated() {
    if (!initialised) {
      _initMap();
      initialised = true;
    } else {
      map.invalidateSize();
    }
    if (!loadedOnce) {
      await _loadStats();
      await _loadPoints();
      loadedOnce = true;
    }
  }

  function onLocationSummary({ total, visits, earliestTs, latestTs }) {
    dataEarliestTs = earliestTs;
    dataLatestTs   = latestTs;
    _updateStatsBar(total, visits, earliestTs, latestTs);
    if (earliestTs) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(earliestTs); }
    if (latestTs)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(latestTs); }
    // Reveal the Map tab now that we know location data exists
    const tab = el('tab-map');
    if (tab) tab.style.display = '';
    // If already on the map tab, reload with fresh data
    if (initialised) { loadedOnce = false; _loadPoints(); }
  }

  // ── Map init ───────────────────────────────────────────────────────────────

  function _initMap() {
    const container = el('location-map');
    if (!container || typeof L === 'undefined') return;

    map = L.map('location-map', {
      center: [20, 0],
      zoom:   2,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      chunkedLoading:      true,
      chunkInterval:       200,
      chunkDelay:          50,
      maxClusterRadius:    60,
      spiderfyOnMaxZoom:   true,
      showCoverageOnHover: false,
    });
    visitLayer = L.layerGroup();
    map.addLayer(clusterGroup);
    map.addLayer(visitLayer);

    map.once('moveend', () => { _mapMoved = true; });

    const applyBtn = el('map-filter-apply');
    const clearBtn = el('map-filter-clear');
    if (applyBtn) applyBtn.addEventListener('click', _onFilterApply);
    if (clearBtn) clearBtn.addEventListener('click', _onFilterClear);
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  async function _loadStats() {
    try {
      const stats = await window.tt.getLocationStats();
      if (!stats || stats.total === 0) return;
      dataEarliestTs = stats.earliest_ts;
      dataLatestTs   = stats.latest_ts;
      _updateStatsBar(stats.total, stats.visits, stats.earliest_ts, stats.latest_ts);
      if (stats.earliest_ts) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(stats.earliest_ts); }
      if (stats.latest_ts)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(stats.latest_ts); }
    } catch (e) {
      console.warn('[locationMap] stats error:', e);
    }
  }

  async function _loadPoints(minTs, maxTs) {
    if (!map) return;
    try {
      const opts = {};
      if (minTs != null) opts.minTs = minTs;
      if (maxTs != null) opts.maxTs = maxTs;
      const { points, total, decimated } = await window.tt.getLocations(opts);
      const notice = el('map-decimation-notice');
      if (notice) notice.style.display = decimated ? '' : 'none';
      _renderPoints(points, total);
      loadedOnce = true;
    } catch (e) {
      console.error('[locationMap] load error:', e);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function _renderPoints(points, total) {
    clusterGroup.clearLayers();
    visitLayer.clearLayers();
    if (!points || points.length === 0) return;

    const pointMarkers = [];
    const bounds = [];

    for (const p of points) {
      if (p.lat == null || p.lng == null) continue;
      bounds.push([p.lat, p.lng]);

      if (p.type === 'visit' && p.name) {
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 7, fillColor: '#b85c2c', color: '#8a3a10',
          weight: 1.5, opacity: 1, fillOpacity: 0.85,
        });
        const dateStr = p.ts ? new Date(p.ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
        m.bindTooltip(
          `<strong style="font-family:'DM Serif Display',serif">${_esc(p.name)}</strong>` +
          (p.address ? `<br><span style="font-size:11px;opacity:.7">${_esc(p.address)}</span>` : '') +
          (dateStr   ? `<br><span style="font-family:monospace;font-size:10px;opacity:.6">${dateStr}</span>` : ''),
          { sticky: false, direction: 'top', offset: [0, -4] }
        );
        visitLayer.addLayer(m);
      } else {
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 3, fillColor: '#1e4d7a', color: '#1e4d7a',
          weight: 0, opacity: 0.7, fillOpacity: 0.55,
        });
        if (p.ts) m.bindPopup(`<span style="font-family:monospace;font-size:10px">${new Date(p.ts).toLocaleString()}</span>`, { maxWidth: 180 });
        pointMarkers.push(m);
      }
    }

    clusterGroup.addLayers(pointMarkers);

    if (bounds.length > 0 && !_mapMoved) {
      try { map.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 7 }); } catch {}
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  async function _onFilterApply() {
    const fromVal = el('map-date-from')?.value;
    const toVal   = el('map-date-to')?.value;
    const minTs = fromVal ? new Date(fromVal + 'T00:00:00Z').getTime() : undefined;
    const maxTs = toVal   ? new Date(toVal   + 'T23:59:59Z').getTime() : undefined;
    await _loadPoints(minTs, maxTs);
  }

  async function _onFilterClear() {
    if (dataEarliestTs) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(dataEarliestTs); }
    if (dataLatestTs)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(dataLatestTs); }
    await _loadPoints();
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────

  function _updateStatsBar(total, visits, earliestTs, latestTs) {
    const countEl = el('map-point-count');
    const rangeEl = el('map-date-range');
    if (countEl) {
      const pts = (total || 0) - (visits || 0);
      const parts = [];
      if (pts   > 0) parts.push(`${pts.toLocaleString()} GPS points`);
      if (visits > 0) parts.push(`${visits.toLocaleString()} named places`);
      countEl.textContent = parts.join(' · ') || '0 points';
    }
    if (rangeEl && earliestTs && latestTs) {
      const fmt  = { year: 'numeric', month: 'short' };
      const from = new Date(earliestTs).toLocaleDateString(undefined, fmt);
      const to   = new Date(latestTs).toLocaleDateString(undefined, fmt);
      rangeEl.textContent = from === to ? from : `${from} – ${to}`;
    }
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  function _msToDateInput(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { onTabActivated, onLocationSummary };
})();
// src/renderer/locationMap.js  — Module 2: Location Timeline map
// Called from app.js:
//   LocationMap.onTabActivated()        — when the Map filter-tab is clicked
//   LocationMap.onLocationSummary(msg)  — when a 'location-summary' event arrives

'use strict';

const LocationMap = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let map          = null;
  let clusterGroup = null;
  let visitLayer   = null;
  let initialised  = false;
  let loadedOnce   = false;
  let dataEarliestTs = null;
  let dataLatestTs   = null;
  let _mapMoved      = false;

  function el(id) { return document.getElementById(id); }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function onTabActivated() {
    if (!initialised) {
      _initMap();
      initialised = true;
    } else {
      map.invalidateSize();
    }
    if (!loadedOnce) {
      await _loadStats();
      await _loadPoints();
      loadedOnce = true;
    }
  }

  function onLocationSummary({ total, visits, earliestTs, latestTs }) {
    dataEarliestTs = earliestTs;
    dataLatestTs   = latestTs;
    _updateStatsBar(total, visits, earliestTs, latestTs);
    if (earliestTs) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(earliestTs); }
    if (latestTs)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(latestTs); }
    // Reveal the Map tab now that we know location data exists
    const tab = el('tab-map');
    if (tab) tab.style.display = '';
    // If already on the map tab, reload with fresh data
    if (initialised) { loadedOnce = false; _loadPoints(); }
  }

  // ── Map init ───────────────────────────────────────────────────────────────

  function _initMap() {
    const container = el('location-map');
    if (!container || typeof L === 'undefined') return;

    map = L.map('location-map', {
      center: [20, 0],
      zoom:   2,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      chunkedLoading:      true,
      chunkInterval:       200,
      chunkDelay:          50,
      maxClusterRadius:    60,
      spiderfyOnMaxZoom:   true,
      showCoverageOnHover: false,
    });
    visitLayer = L.layerGroup();
    map.addLayer(clusterGroup);
    map.addLayer(visitLayer);

    map.once('moveend', () => { _mapMoved = true; });

    const applyBtn = el('map-filter-apply');
    const clearBtn = el('map-filter-clear');
    if (applyBtn) applyBtn.addEventListener('click', _onFilterApply);
    if (clearBtn) clearBtn.addEventListener('click', _onFilterClear);
  }

  // ── Data ───────────────────────────────────────────────────────────────────

  async function _loadStats() {
    try {
      const stats = await window.tt.getLocationStats();
      if (!stats || stats.total === 0) return;
      dataEarliestTs = stats.earliest_ts;
      dataLatestTs   = stats.latest_ts;
      _updateStatsBar(stats.total, stats.visits, stats.earliest_ts, stats.latest_ts);
      if (stats.earliest_ts) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(stats.earliest_ts); }
      if (stats.latest_ts)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(stats.latest_ts); }
    } catch (e) {
      console.warn('[locationMap] stats error:', e);
    }
  }

  async function _loadPoints(minTs, maxTs) {
    if (!map) return;
    try {
      const opts = {};
      if (minTs != null) opts.minTs = minTs;
      if (maxTs != null) opts.maxTs = maxTs;
      const { points, total, decimated } = await window.tt.getLocations(opts);
      const notice = el('map-decimation-notice');
      if (notice) notice.style.display = decimated ? '' : 'none';
      _renderPoints(points, total);
      loadedOnce = true;
    } catch (e) {
      console.error('[locationMap] load error:', e);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function _renderPoints(points, total) {
    clusterGroup.clearLayers();
    visitLayer.clearLayers();
    if (!points || points.length === 0) return;

    const pointMarkers = [];
    const bounds = [];

    for (const p of points) {
      if (p.lat == null || p.lng == null) continue;
      bounds.push([p.lat, p.lng]);

      if (p.type === 'visit' && p.name) {
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 7, fillColor: '#b85c2c', color: '#8a3a10',
          weight: 1.5, opacity: 1, fillOpacity: 0.85,
        });
        const dateStr = p.ts ? new Date(p.ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
        m.bindTooltip(
          `<strong style="font-family:'DM Serif Display',serif">${_esc(p.name)}</strong>` +
          (p.address ? `<br><span style="font-size:11px;opacity:.7">${_esc(p.address)}</span>` : '') +
          (dateStr   ? `<br><span style="font-family:monospace;font-size:10px;opacity:.6">${dateStr}</span>` : ''),
          { sticky: false, direction: 'top', offset: [0, -4] }
        );
        visitLayer.addLayer(m);
      } else {
        const m = L.circleMarker([p.lat, p.lng], {
          radius: 3, fillColor: '#1e4d7a', color: '#1e4d7a',
          weight: 0, opacity: 0.7, fillOpacity: 0.55,
        });
        if (p.ts) m.bindPopup(`<span style="font-family:monospace;font-size:10px">${new Date(p.ts).toLocaleString()}</span>`, { maxWidth: 180 });
        pointMarkers.push(m);
      }
    }

    clusterGroup.addLayers(pointMarkers);

    if (bounds.length > 0 && !_mapMoved) {
      try { map.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 7 }); } catch {}
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  async function _onFilterApply() {
    const fromVal = el('map-date-from')?.value;
    const toVal   = el('map-date-to')?.value;
    const minTs = fromVal ? new Date(fromVal + 'T00:00:00Z').getTime() : undefined;
    const maxTs = toVal   ? new Date(toVal   + 'T23:59:59Z').getTime() : undefined;
    await _loadPoints(minTs, maxTs);
  }

  async function _onFilterClear() {
    if (dataEarliestTs) { const d = el('map-date-from'); if (d) d.value = _msToDateInput(dataEarliestTs); }
    if (dataLatestTs)   { const d = el('map-date-to');   if (d) d.value = _msToDateInput(dataLatestTs); }
    await _loadPoints();
  }

  // ── Stats bar ──────────────────────────────────────────────────────────────

  function _updateStatsBar(total, visits, earliestTs, latestTs) {
    const countEl = el('map-point-count');
    const rangeEl = el('map-date-range');
    if (countEl) {
      const pts = (total || 0) - (visits || 0);
      const parts = [];
      if (pts   > 0) parts.push(`${pts.toLocaleString()} GPS points`);
      if (visits > 0) parts.push(`${visits.toLocaleString()} named places`);
      countEl.textContent = parts.join(' · ') || '0 points';
    }
    if (rangeEl && earliestTs && latestTs) {
      const fmt  = { year: 'numeric', month: 'short' };
      const from = new Date(earliestTs).toLocaleDateString(undefined, fmt);
      const to   = new Date(latestTs).toLocaleDateString(undefined, fmt);
      rangeEl.textContent = from === to ? from : `${from} – ${to}`;
    }
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  function _msToDateInput(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { onTabActivated, onLocationSummary };
})();
