// src/renderer/tripsMap.js
// TripDetailMap — single Leaflet instance for the trip detail panel.
// Replaces the previous per-card lazy-init system.
//
// API:
//   TripDetailMap.init(containerId, tripId, onPhotoClick)
//     — fetches detail, renders polyline + numbered photo pins
//   TripDetailMap.destroy()
//     — removes map instance and cleans up

'use strict';

const TripDetailMap = (() => {

  let _map       = null;
  let _tripId    = null;

  // ── Public ──────────────────────────────────────────────────────────────────

  async function init(containerId, tripId, onPhotoClick) {
    destroy();
    _tripId = tripId;

    const container = document.getElementById(containerId);
    if (!container || typeof L === 'undefined') return;

    let detail;
    try {
      detail = await window.tt.getTripDetail({ tripId, pointLimit: 2000 });
    } catch (err) {
      console.error('[TripDetailMap] getTripDetail failed:', err);
      return;
    }
    if (!detail) { console.error('[TripDetailMap] getTripDetail returned null for tripId', tripId); return; }

    const { points, photos } = detail;

    // Wait until the container is visible and has dimensions.
    // _setTripsPanelState('detail') fires just before init() is called —
    // the display:flex change may not have been painted yet.
    // Poll up to 600ms, then proceed regardless.
    {
      let waited = 0;
      while (container.offsetHeight === 0 && waited < 600) {
        await new Promise(r => setTimeout(r, 30));
        waited += 30;
      }
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      _map = L.map(containerId, {
        zoomControl:        true,
        attributionControl: true,
      });
    } catch (err) {
      console.error('[TripDetailMap] L.map() failed:', err, 'container:', containerId, 'offsetHeight:', container.offsetHeight);
      return;
    }

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:     19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(_map);

    const bounds = [];

    // ── GPS polyline (Timeline data) ─────────────────────────────────────────
    if (points && points.length > 1) {
      const lls = points.map(p => [p.lat, p.lng]);
      lls.forEach(ll => bounds.push(ll));
      L.polyline(lls, { color: '#1e4d7a', weight: 2.5, opacity: 0.6 }).addTo(_map);
    }

    // ── Photo location pins ──────────────────────────────────────────────────
    const withGps = (photos || []).filter(p => p.lat != null && p.lng != null);

    // Preload all thumbnails now — by the time the user clicks a pin,
    // the image will already be in the browser's memory cache.
    withGps.forEach(ph => {
      const src = _encodePath(ph.thumbnail_path || ph.file_path);
      const preload = new window.Image();
      preload.src = `local://${src}`;
    });

    withGps.forEach((ph) => {
      bounds.push([ph.lat, ph.lng]);

      const marker = L.circleMarker([ph.lat, ph.lng], {
        radius:      7,
        fillColor:   '#b85c2c',
        color:       '#8a3a10',
        weight:      1.5,
        opacity:     1,
        fillOpacity: 0.9,
      });

      // Hover tooltip — filename
      marker.bindTooltip(
        `<span class="tdm-tip">${_esc(ph.filename)}</span>`,
        { direction: 'top', offset: [0, -14], sticky: false }
      );

      const src = _encodePath(ph.thumbnail_path || ph.file_path);
      const dateStr = ph.date_ts
        ? new Date(ph.date_ts).toLocaleDateString(undefined,
            { year: 'numeric', month: 'short', day: 'numeric' })
        : '';

      marker.bindPopup(
        `<div class="tdm-popup">` +
        `<img class="tdm-popup-img" src="local://${src}" alt="">` +
        `<div class="tdm-popup-name">${_esc(ph.filename)}</div>` +
        (dateStr ? `<div class="tdm-popup-date">${dateStr}</div>` : '') +
        `</div>`,
        {
          maxWidth:  260,
          className: 'tdm-popup-wrap',
          autoPan:   false,  // pan animation delays popup display
        }
      );

      marker.on('popupopen', () => {
        const img = marker.getPopup()?.getElement()?.querySelector('.tdm-popup-img');
        if (img && onPhotoClick) {
          img.style.cursor = 'pointer';
          img.addEventListener('click', () => onPhotoClick(ph), { once: true });
        }
      });

      marker.addTo(_map);
    });

    // Fit bounds
    if (bounds.length > 0) {
      try { _map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 14 }); }
      catch {}
    } else {
      _map.setView([20, 0], 2);
    }

    setTimeout(() => { try { _map.invalidateSize(); } catch {} }, 250);
  }

  function destroy() {
    if (_map) { try { _map.remove(); } catch {} _map = null; }
    _tripId = null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function _encodePath(p) {
    return (p || '').split('/').map(s => encodeURIComponent(s)).join('/');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init, destroy };

})();

// Backward compat — old code called TripMaps.destroyAll()
const TripMaps = { destroyAll: () => TripDetailMap.destroy() };
// src/renderer/tripsMap.js
