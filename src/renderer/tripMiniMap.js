// src/renderer/tripMiniMap.js
// Renders small static Leaflet maps on trip cards, loaded lazily as cards
// scroll into view via IntersectionObserver.
//
// API:
//   TripMiniMap.observe(containerId)   — register a card map container
//   TripMiniMap.destroyAll()           — remove all map instances (called on panel hide)

'use strict';

const TripMiniMap = (() => {

  // Map of containerId -> Leaflet map instance
  const _maps = new Map();

  // One shared observer for all card containers
  const _observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      _observer.unobserve(entry.target);
      _initMap(entry.target).catch(() => {});
    }
  }, { threshold: 0.05 });

  async function _initMap(el) {
    const tripId = parseInt(el.dataset.tripId, 10);
    if (!tripId || isNaN(tripId)) return;

    // Already initialized
    if (_maps.has(el.id)) return;

    let data;
    try { data = await window.tt.getTripBbox({ tripId }); } catch { return; }
    if (!data) return;

    // Show the container (hidden until map is ready to avoid blank flash)
    el.style.visibility = 'visible';

    const map = L.map(el, {
      zoomControl:        false,
      attributionControl: false,
      dragging:           false,
      touchZoom:          false,
      scrollWheelZoom:    false,
      doubleClickZoom:    false,
      boxZoom:            false,
      keyboard:           false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
    }).addTo(map);

    const bounds = [];
    for (const p of data.photos || []) {
      if (p.lat == null || p.lng == null) continue;
      bounds.push([p.lat, p.lng]);
      L.circleMarker([p.lat, p.lng], {
        radius:      3.5,
        fillColor:   '#b85c2c',
        color:       '#7a3010',
        weight:      1,
        opacity:     1,
        fillOpacity: 0.85,
      }).addTo(map);
    }

    if (bounds.length > 1) {
      try {
        map.fitBounds(L.latLngBounds(bounds), { padding: [10, 10], maxZoom: 13 });
      } catch {}
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 10);
    } else if (data.center_lat != null && data.center_lng != null) {
      map.setView([data.center_lat, data.center_lng], 7);
    } else {
      // No coords at all — hide container cleanly
      el.style.display = 'none';
      return;
    }

    // Force Leaflet to recalculate size after the container is fully painted
    setTimeout(() => { try { map.invalidateSize(); } catch {} }, 50);

    _maps.set(el.id, map);
  }

  function observe(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    // Mark as pending — hidden until map loads to avoid blank grey box flash
    el.style.visibility = 'hidden';
    _observer.observe(el);
  }

  function destroyAll() {
    _observer.disconnect();
    _maps.forEach((map) => { try { map.remove(); } catch {} });
    _maps.clear();
    // Re-connect observer for next activation
    // (observer is recreated via module reload; destroyAll is final)
  }

  // Backward-compat stub used by old code
  const TripMaps = { destroyAll, observe };

  return { observe, destroyAll };

})();

// Expose as TripMaps for backward compatibility with any remaining references
// (tripsMap.js also defines a TripMaps stub — this one wins since it loads after)
