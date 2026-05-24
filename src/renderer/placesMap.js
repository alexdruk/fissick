// src/renderer/placesMap.js
// PlaceDetailMap — single Leaflet instance for the place detail panel.
//
// API:
//   PlaceDetailMap.init(place, photos, onPhotoClick)
//     — renders a centred pin for the place + circle markers for nearby photos
//   PlaceDetailMap.destroy()
//     — removes the map instance

'use strict';

const PlaceDetailMap = (() => {

  let _map = null;

  async function init(place, photos, onPhotoClick) {
    destroy();

    const container = document.getElementById('places-detail-map');
    if (!container || typeof L === 'undefined') return;

    // Double rAF — guarantees container is painted before Leaflet reads its size
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    _map = L.map('places-detail-map', {
      zoomControl:        true,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:     19,
      attribution: '\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(_map);

    const bounds = [];

    // ── Place pin (blue, larger) ─────────────────────────────────────────────
    const placeMarker = L.circleMarker([place.lat, place.lng], {
      radius:      10,
      fillColor:   '#1e4d7a',
      color:       '#0d2d4a',
      weight:      2,
      opacity:     1,
      fillOpacity: 0.9,
    });
    placeMarker.bindTooltip(
      `<strong>${_esc(place.name)}</strong><br>${(place.visit_count || 0).toLocaleString()} visit${place.visit_count !== 1 ? 's' : ''}`,
      { direction: 'top', offset: [0, -16], sticky: false }
    );
    placeMarker.addTo(_map);
    bounds.push([place.lat, place.lng]);

    // ── Photo pins (orange) ──────────────────────────────────────────────────
    const withGps = (photos || []).filter(p => p.lat != null && p.lng != null);
    withGps.forEach(ph => {
      bounds.push([ph.lat, ph.lng]);

      const marker = L.circleMarker([ph.lat, ph.lng], {
        radius:      6,
        fillColor:   '#b85c2c',
        color:       '#8a3a10',
        weight:      1.5,
        opacity:     1,
        fillOpacity: 0.85,
      });

      marker.bindTooltip(
        `<span class="tdm-tip">${_esc(ph.filename)}</span>`,
        { direction: 'top', offset: [0, -12], sticky: false }
      );

      const src = _encodePath(ph.thumbnail_path || ph.file_path);
      const dateStr = ph.date_ts
        ? new Date(ph.date_ts).toLocaleDateString(undefined,
            { year: 'numeric', month: 'short', day: 'numeric' })
        : '';

      marker.bindPopup(
        `<div class="tdm-popup">` +
        `<div class="tdm-popup-loading">Loading\u2026</div>` +
        `<img class="tdm-popup-img" src="local://${src}"` +
        ` onload="this.previousElementSibling.style.display='none'"` +
        ` onerror="this.previousElementSibling.textContent='No preview';this.style.display='none'" alt="">` +
        `<div class="tdm-popup-name">${_esc(ph.filename)}</div>` +
        (dateStr ? `<div class="tdm-popup-date">${dateStr}</div>` : '') +
        `</div>`,
        {
          maxWidth: 260,
          className: 'tdm-popup-wrap',
          autoPan: true,
          autoPanPaddingTopLeft:     L.point(20, 80),
          autoPanPaddingBottomRight: L.point(20, 20),
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

    // Fit bounds — zoom to show place + all photo pins, max zoom 16
    if (bounds.length > 1) {
      try { _map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 16 }); }
      catch {}
    } else {
      _map.setView([place.lat, place.lng], 14);
    }

    setTimeout(() => { try { _map.invalidateSize(); } catch {} }, 80);
  }

  function destroy() {
    if (_map) { try { _map.remove(); } catch {} _map = null; }
  }

  function _encodePath(p) {
    return (p || '').split('/').map(s => encodeURIComponent(s)).join('/');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, destroy };

})();
