/* ==========================================================
   Lokoja Flood Operations Dashboard
   Interactive Leaflet.js map with GeoJSON flood event layers
   and timeline slider. Sidebar image-sequence panels retained.
   ========================================================== */

/* ----------------------------------------------------------
   UTILITY: Human-readable date
   ---------------------------------------------------------- */
function formatDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${date} · ${time.toUpperCase()}`;
  } catch (_) {
    return isoString;
  }
}

/* ----------------------------------------------------------
   FLOOD EVENT DEFINITIONS
   ---------------------------------------------------------- */
const FLOOD_EVENTS = [
  {
    file:     'data/april21.geojson',
    label:    'Apr 21',
    date:     'April 21, 2025',
    color:    '#3182bd',
    fillOpacity: 0.45,
    severity: 'Moderate',
    volunteers: 16,
    alerts: 3,
  },
  {
    file:     'data/july15.geojson',
    label:    'Jul 15',
    date:     'July 15, 2025',
    color:    '#de2d26',
    fillOpacity: 0.50,
    severity: 'Severe',
    volunteers: 24,
    alerts: 11,
  },
  {
    file:     'data/nov2.geojson',
    label:    'Nov 2',
    date:     'November 2, 2025',
    color:    '#fd8d3c',
    fillOpacity: 0.45,
    severity: 'Major',
    volunteers: 20,
    alerts: 7,
  },
];

/* ----------------------------------------------------------
   DOM REFERENCES
   ---------------------------------------------------------- */
const els = {
  refImg:         document.getElementById('refMapImg'),
  precipImg:      document.getElementById('precipImg'),
  precipSummary:  document.getElementById('precip-summary'),
  refCaption:     document.getElementById('ref-caption'),
  refreshBtn:     document.getElementById('refreshBtn'),
  slider:         document.getElementById('timeline-slider'),
  activeLabel:    document.getElementById('timeline-active-label'),
  tmVolunteers:   document.getElementById('tm-volunteers'),
  tmAlerts:       document.getElementById('tm-alerts'),
  tmAlertsItem:   document.getElementById('tm-alerts-item'),
  tmPeakRain:     document.getElementById('tm-peak-rain'),
  tmFloodArea:    document.getElementById('tm-flood-area'),
  tmSync:         document.getElementById('tm-sync'),
};

/* ----------------------------------------------------------
   SIDEBAR FRAME-STEPPER (manifest-driven, unchanged logic)
   ---------------------------------------------------------- */
let manifest = null;
let step = 0;

function pad(n) { return String(n).padStart(2, '0'); }

function frameSrc(panelKey, globalStep) {
  const panel = manifest.panels[panelKey];
  const idx = (globalStep % panel.count) + 1;
  return `${panel.folder}/${pad(idx)}.${panel.ext}`;
}

function renderSidebar() {
  if (!manifest) return;
  const mainFrameIdx = step % manifest.panels.mainMap.count;
  const stats = manifest.stats[mainFrameIdx];

  els.refImg.src    = frameSrc('refMap', step);
  els.precipImg.src = frameSrc('precip', step);

  els.precipSummary.textContent =
    `Frame ${mainFrameIdx + 1} of ${manifest.frameCount} \u2014 ${stats.rain_mm_h.toFixed(1)} mm/h this hour, ${stats.cum_rain_mm} mm cumulative.`;
  els.refCaption.textContent =
    `Baseline imagery captured before onset of flooding (reference frame ${(step % manifest.panels.refMap.count) + 1} of ${manifest.panels.refMap.count}).`;
}

function advanceSidebar() {
  step += 1;
  renderSidebar();
  els.refreshBtn.classList.remove('spinning-sidebar');
  void els.refreshBtn.offsetWidth;
  els.refreshBtn.classList.add('spinning-sidebar');
}

els.refreshBtn.addEventListener('click', advanceSidebar);

fetch('data/manifest.json')
  .then(r => r.json())
  .then(data => { manifest = data; renderSidebar(); })
  .catch(err => console.error('Failed to load manifest.json:', err));

/* ----------------------------------------------------------
   LEAFLET MAP SETUP
   ---------------------------------------------------------- */
const LOKOJA_CENTER = [7.795, 6.733];
const LOKOJA_ZOOM   = 12;

const map = L.map('map', {
  center: LOKOJA_CENTER,
  zoom:   LOKOJA_ZOOM,
  zoomControl: true,
  attributionControl: true,
});

// OpenStreetMap basemap
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

/* ----------------------------------------------------------
   VOLUNTEER POINTS OVERLAY (from existing data)
   ---------------------------------------------------------- */
function volunteerIcon(status) {
  const color = status === 'good' ? '#3EA1F2' : '#E5484D';
  return L.divIcon({
    className: '',
    html: `<div style="
      width:12px;height:12px;
      background:${color};
      border:2px solid #fff;
      border-radius:50%;
      box-shadow:0 0 6px ${color}88;
    "></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

fetch('data/volunteer_points.geojson')
  .then(r => r.json())
  .then(data => {
    L.geoJSON(data, {
      pointToLayer: (feature, latlng) =>
        L.marker(latlng, { icon: volunteerIcon(feature.properties.status) }),
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        const statusLabel = p.status === 'good' ? '✅ Accessible' : '🚨 Alert';
        layer.bindPopup(`
          <div class="lf-popup">
            <div class="lf-popup-title">${p.locality}</div>
            <div class="lf-popup-row"><b>Team:</b> ${p.volunteer}</div>
            <div class="lf-popup-row"><b>ID:</b> ${p.id}</div>
            <div class="lf-popup-row"><b>Status:</b> ${statusLabel}</div>
            <div class="lf-popup-row lf-popup-note">${p.note}</div>
            <div class="lf-popup-time">🕐 Reported: ${formatDate(p.reported)}</div>
          </div>
        `, { maxWidth: 240 });
      },
    }).addTo(map);
  })
  .catch(err => console.warn('Could not load volunteer_points.geojson:', err));

/* ----------------------------------------------------------
   GEOJSON FLOOD LAYERS
   ---------------------------------------------------------- */
const floodLayers = [];  // one L.geoJSON layer per event
let currentEventIndex = 0;

/**
 * Compute total flood area in km² from a GeoJSON FeatureCollection
 * using the Shape_Area property (in m²).
 */
function computeFloodAreaKm2(geojson) {
  let total = 0;
  (geojson.features || []).forEach(f => {
    if (f.properties && f.properties.Shape_Area) {
      total += parseFloat(f.properties.Shape_Area);
    }
  });
  return (total / 1e6).toFixed(2);  // m² → km²
}

function buildPopupHtml(event, areaKm2) {
  const severityColor = {
    'Moderate': '#3182bd',
    'Major':    '#fd8d3c',
    'Severe':   '#de2d26',
  }[event.severity] || '#888';

  return `
    <div class="lf-popup">
      <div class="lf-popup-title">🌊 Flood Event</div>
      <div class="lf-popup-row"><b>Date:</b> ${event.date}</div>
      <div class="lf-popup-row"><b>Flood Area:</b> ${areaKm2} km²</div>
      <div class="lf-popup-row">
        <b>Severity:</b>
        <span style="color:${severityColor};font-weight:700;">${event.severity}</span>
      </div>
      <div class="lf-popup-note" style="margin-top:6px;">
        Data source: Sentinel-1 / GIS analysis
      </div>
    </div>
  `;
}

// Load all 3 GeoJSON files and build Leaflet layers
const loadPromises = FLOOD_EVENTS.map((event, idx) =>
  fetch(event.file)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${event.file}`);
      return r.json();
    })
    .then(geojson => {
      const areaKm2 = computeFloodAreaKm2(geojson);
      event._areaKm2 = areaKm2;  // cache

      const layer = L.geoJSON(geojson, {
        style: {
          color:       event.color,
          weight:      2,
          opacity:     0.9,
          fillColor:   event.color,
          fillOpacity: event.fillOpacity,
        },
        onEachFeature: (feature, featureLayer) => {
          featureLayer.bindPopup(buildPopupHtml(event, areaKm2), { maxWidth: 260 });
          featureLayer.on('mouseover', function () {
            this.setStyle({ fillOpacity: Math.min(event.fillOpacity + 0.2, 0.85), weight: 3 });
          });
          featureLayer.on('mouseout', function () {
            layer.resetStyle(this);
          });
        },
      });

      floodLayers[idx] = layer;
    })
    .catch(err => {
      console.error(`Failed to load ${event.file}:`, err);
      floodLayers[idx] = null;
    })
);

/* ----------------------------------------------------------
   SMOOTH FADE TRANSITION BETWEEN LAYERS
   ---------------------------------------------------------- */
let _transitionRaf = null;
const FADE_DURATION = 350; // ms

function animateLayerOpacity(layer, fromFill, toFill, fromStroke, toStroke, duration, onDone) {
  if (!layer) { if (onDone) onDone(); return; }
  const start = performance.now();
  if (_transitionRaf) cancelAnimationFrame(_transitionRaf);

  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    // Ease in-out cubic
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const fill   = fromFill   + (toFill   - fromFill)   * eased;
    const stroke = fromStroke + (toStroke - fromStroke) * eased;
    layer.setStyle({ fillOpacity: fill, opacity: stroke });
    if (t < 1) {
      _transitionRaf = requestAnimationFrame(step);
    } else {
      _transitionRaf = null;
      if (onDone) onDone();
    }
  }
  _transitionRaf = requestAnimationFrame(step);
}

/* ----------------------------------------------------------
   SHOW / HIDE LAYERS + UPDATE TELEMETRY
   ---------------------------------------------------------- */
function showEvent(idx) {
  const event      = FLOOD_EVENTS[idx];
  const targetFill = event.fillOpacity;

  // Layers currently on map (excluding the target)
  const visible = floodLayers.filter((l, i) => l && map.hasLayer(l) && i !== idx);

  function bringInNewLayer() {
    // Remove fully-faded layers
    visible.forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });

    const layer = floodLayers[idx];
    if (layer) {
      layer.setStyle({ fillOpacity: 0, opacity: 0 });
      if (!map.hasLayer(layer)) layer.addTo(map);

      // Smooth pan to new bounds
      try {
        const bounds = layer.getBounds();
        if (bounds.isValid()) map.flyToBounds(bounds, { padding: [30, 30], duration: 0.6 });
      } catch (_) { /* ignore */ }

      // Fade in
      animateLayerOpacity(layer, 0, targetFill, 0, 0.9, FADE_DURATION, null);
    }
  }

  if (visible.length === 0) {
    bringInNewLayer();
  } else {
    let done = 0;
    visible.forEach(l => {
      const curFill   = l.options?.fillOpacity ?? 0.45;
      const curStroke = l.options?.opacity     ?? 0.9;
      animateLayerOpacity(l, curFill, 0, curStroke, 0, FADE_DURATION, () => {
        done++;
        if (done === visible.length) bringInNewLayer();
      });
    });
  }

  currentEventIndex = idx;


  // Update timeline label
  els.activeLabel.textContent = event.date;

  // Update telemetry strip
  els.tmVolunteers.textContent = event.volunteers;
  els.tmAlerts.textContent     = event.alerts;
  els.tmAlertsItem.classList.toggle('has-alerts', event.alerts > 0);
  els.tmPeakRain.textContent   = event.date;
  els.tmFloodArea.textContent  = event._areaKm2 ? `${event._areaKm2} km²` : '…';
  els.tmSync.textContent       = event.severity;
}

/* ----------------------------------------------------------
   TIMELINE SLIDER
   ---------------------------------------------------------- */
els.slider.addEventListener('input', e => {
  const idx = parseInt(e.target.value, 10);
  showEvent(idx);
});

// Keyboard shortcut: left/right arrow keys to move slider
document.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    const next = Math.min(currentEventIndex + 1, FLOOD_EVENTS.length - 1);
    els.slider.value = next;
    showEvent(next);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    const prev = Math.max(currentEventIndex - 1, 0);
    els.slider.value = prev;
    showEvent(prev);
  }
});

/* ----------------------------------------------------------
   INIT: Wait for all GeoJSON to load, then show event 0
   ---------------------------------------------------------- */
Promise.allSettled(loadPromises).then(() => {
  showEvent(0);
  console.log('All flood layers loaded.');
});
