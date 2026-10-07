/**
 * Aba Consulta: coordenadas, KML (ponto/polígono), clique/desenho no mapa,
 * buffer do ponto pela área da propriedade e relatório de cruzamento com alertas MapBiomas.
 */
import L from 'leaflet';
import { parseDMSCoord } from './registros.js';
import { extractConsultaGeometryFromKml } from './kmlGeometry.js';
import { buildConsultaAoi, parseHectares } from './consultaAoi.js';
import { buildConsultaReportHtml, buildConsultaPdfPayload, kindLabelPt, sourceLabelPt } from './consultaReport.js';
import { formatHaPtBr } from './formatPtBr.js';
import { getApiBase } from './config.js';
import { filterAlertsInAoiAsync } from './consultaAoiFilter.js';
import { resolveAlertClipInShape, alertGeometryAndPoint } from './alertsIntersect.js';
import { yieldToMain } from './yieldToMain.js';
import * as turf from '@turf/turf';
import { FAIXA_BBOX } from './faixaShapeNormalize.js';

const AOI_STYLE = { color: '#0284c7', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.18, interactive: false };
const IMOVEL_STYLE = { color: '#ca8a04', weight: 2, fillColor: '#facc15', fillOpacity: 0.16, interactive: false };
const APP_STYLE = { color: '#0e7490', weight: 1.6, fillColor: '#67e8f9', fillOpacity: 0.35, interactive: false };
const RL_STYLE = { color: '#166534', weight: 1.6, fillColor: '#86efac', fillOpacity: 0.35, interactive: false };
const DRAW_STYLE = { color: '#0284c7', weight: 2.2, dashArray: '10 7', fill: false, className: 'consulta-draw-line', interactive: false };
const RUBBER_STYLE = { color: '#38bdf8', weight: 2, dashArray: '7 6', fill: false, className: 'consulta-draw-rubber', interactive: false };
const CLOSE_STYLE = { color: '#0ea5e9', weight: 2, dashArray: '5 5', fill: false, className: 'consulta-draw-close', interactive: false };
const GHOST_STYLE = { color: '#0284c7', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12, dashArray: '6 4', className: 'consulta-draw-ghost', interactive: false };
const CLIP_STYLE = { color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.35, interactive: false };
const VERTEX_STYLE = { radius: 5, color: '#0c4a6e', weight: 2, fillColor: '#38bdf8', fillOpacity: 1, interactive: false };
const VERTEX_START_STYLE = { radius: 6, color: '#0369a1', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false };
const SNAP_PX = 22;
const DBLCLICK_MS = 240;

function compactGeom(input, maxPts = 360) {
  if (!input) return null;
  try {
    let feat = input.type === 'Feature' ? input : turf.feature(input);
    feat = turf.truncate(feat, { precision: 6, mutate: false });
    let n = 0;
    turf.coordEach(feat, () => { n += 1; });
    if (n > maxPts) {
      feat = turf.simplify(feat, { tolerance: 0.00012, highQuality: false, mutate: false });
    }
    return feat.geometry || null;
  } catch (_) {
    return input.geometry || (input.type && input.coordinates ? input : null);
  }
}

function unionOverlapHa(clips, fallbackHa) {
  try {
    const feats = (clips || [])
      .map((g) => {
        try {
          return turf.feature(g);
        } catch (_) {
          return null;
        }
      })
      .filter((f) => f?.geometry);
    if (!feats.length) return 0;
    if (feats.length === 1) return turf.area(feats[0]) / 10000;
    const u = turf.union(turf.featureCollection(feats));
    return u ? turf.area(u) / 10000 : fallbackHa;
  } catch (_) {
    return fallbackHa;
  }
}

function esc(s) {
  return String(s ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCoord(n) {
  if (!Number.isFinite(n)) return '';
  return n.toFixed(6);
}

function formatCpfInput(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function cadastroPessoa() {
  return {
    nome: (document.getElementById('consultaNome')?.value || '').trim(),
    cpf: (document.getElementById('consultaCpf')?.value || '').trim(),
    propriedadeHa: parseHectares(document.getElementById('consultaAreaHa')?.value),
  };
}

function formatMetros(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '';
  const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${String(rounded).replace('.', ',')} m`;
}

async function fetchShapeInBbox(file, bbox) {
  const base = getApiBase();
  if (!base || !bbox) return [];
  const q = new URLSearchParams({
    file,
    bbox: bbox.join(','),
    limit: '0',
    map: '0',
  });
  const res = await fetch(`${String(base).replace(/\/$/, '')}/api/shape/features?${q}`, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return data?.geojson?.features || [];
}

function cruzaAoi(feat, aoi) {
  if (!feat?.geometry || !aoi) return false;
  try {
    return turf.booleanIntersects(aoi, feat);
  } catch (_) {
    return false;
  }
}

/**
 * Imóvel sob o ponto, ou o imóvel da APP/reserva legal que cruza o buffer.
 * APP e RL devolvidas são as que cruzam a área de análise, para desenhar no mapa.
 */
async function findTerritorioConsulta(built, geom) {
  const empty = { imoveis: [], apps: [], rls: [] };
  if (!built?.aoi || !geom) return empty;
  let bbox;
  try {
    bbox = turf.bbox(built.aoi);
  } catch (_) {
    return empty;
  }
  const [imoveis, apps, rls] = await Promise.all([
    fetchShapeInBbox('imoveis_rurais.geojson', bbox),
    fetchShapeInBbox('app.geojson', bbox),
    fetchShapeInBbox('reserva_legal.geojson', bbox),
  ]);
  const appsHit = apps.filter((f) => cruzaAoi(f, built.aoi));
  const rlsHit = rls.filter((f) => cruzaAoi(f, built.aoi));
  const ides = new Set();
  for (const f of [...appsHit, ...rlsHit]) {
    const ide = String(f.properties?.IDE_IMOVEL ?? '').trim();
    if (ide) ides.add(ide);
  }
  let imoveisHit = [];
  if (geom.kind === 'point' && Number.isFinite(geom.lat) && Number.isFinite(geom.lng)) {
    const pt = turf.point([geom.lng, geom.lat]);
    imoveisHit = imoveis.filter((f) => {
      if (!f?.geometry) return false;
      try {
        return turf.booleanPointInPolygon(pt, f);
      } catch (_) {
        return false;
      }
    });
  } else {
    imoveisHit = imoveis.filter((f) => cruzaAoi(f, built.aoi));
  }
  if (!imoveisHit.length && ides.size) {
    imoveisHit = imoveis.filter((f) => ides.has(String(f.properties?.IDE_IMOVEL ?? '').trim()));
  }
  return { imoveis: imoveisHit, apps: appsHit, rls: rlsHit };
}

function nowPtBr() {
  try {
    return new Date().toLocaleString('pt-BR');
  } catch (_) {
    return new Date().toISOString();
  }
}

/**
 * @param {object} ctx
 * @param {() => import('leaflet').Map | null} [ctx.getMap]
 * @param {import('leaflet').Map} [ctx.map]
 * @param {() => object[]} ctx.getAlerts
 * @param {() => boolean} ctx.isScanInFlight
 * @param {(msg: string, isError?: boolean) => void} ctx.setStatus
 * @param {(msg: string) => void} ctx.showLoading
 * @param {(msg: string) => void} ctx.updateLoading
 * @param {() => void} ctx.hideLoading
 * @param {(lat: number, lng: number) => Promise<object>} [ctx.fetchMunicipio]
 */
export function setupConsultaTab(ctx) {
  const {
    getAlerts,
    isScanInFlight,
    setStatus,
    showLoading,
    updateLoading,
    hideLoading,
    fetchMunicipio,
    resetMapView,
    onImovelSelected,
    onImovelCleared,
  } = ctx;

  function liveMap() {
    return typeof ctx.getMap === 'function' ? ctx.getMap() : ctx.map;
  }

  const latIn = document.getElementById('consultaLat');
  const lngIn = document.getElementById('consultaLng');
  const nomeIn = document.getElementById('consultaNome');
  const cpfIn = document.getElementById('consultaCpf');
  const areaHaIn = document.getElementById('consultaAreaHa');

  function aoiOf(geom) {
    return buildConsultaAoi(geom, { hectares: parseHectares(areaHaIn?.value) });
  }
  const kmlIn = document.getElementById('consultaKml');
  const kmlFn = document.getElementById('consultaKmlFilename');
  const kmlErr = document.getElementById('consultaKmlErr');
  const geomStatus = document.getElementById('consultaGeomStatus');
  const mapHint = document.getElementById('consultaMapHint');
  const resultEl = document.getElementById('consultaResult');
  const btnRun = document.getElementById('btnConsultaExecutar');
  const btnClear = document.getElementById('btnConsultaLimpar');
  const btnReset = document.getElementById('btnConsultaResetar');
  const btnPoint = document.getElementById('btnConsultaPontoMapa');
  const btnDraw = document.getElementById('btnConsultaDesenhar');
  const munIn = document.getElementById('filterMunicipio');
  const imovelIn = document.getElementById('consultaImovel');

  if (!latIn || !lngIn || !resultEl) {
    return { syncExecutarButton() {}, cancelMapMode() {}, clearAll() {} };
  }

  /** @type {null | { kind: 'point'|'polygon', feature: object, lat?: number, lng?: number, source: string }} */
  let geometry = null;
  let mapMode = 'idle';
  let drawLatLngs = [];
  let drawCursor = null;
  let previewGroup = null;
  let resultGroup = null;
  let drawTemp = null;
  let polygonClickTimer = null;
  let runGeneration = 0;
  let lastPdfPayload = null;
  let pinIcon = null;

  function getPinIcon() {
    if (!pinIcon) {
      pinIcon = L.divIcon({
        className: 'leaflet-div-icon consulta-leaflet-pin',
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 24 32" aria-hidden="true"><path fill="#0ea5e9" stroke="#0c4a6e" stroke-width="1.2" d="M12 2C7.6 2 4 5.4 4 9.5c0 5.2 8 15.5 8 15.5s8-10.3 8-15.5C20 5.4 16.4 2 12 2z"/><circle fill="#fff" cx="12" cy="9.5" r="3.2"/></svg>',
        iconSize: [28, 36],
        iconAnchor: [14, 34],
      });
    }
    return pinIcon;
  }

  async function downloadConsultaPdf(payload) {
    const base = getApiBase();
    const res = await fetch(`${base}/api/consulta/relatorio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let msg = 'Falha ao gerar o relatório em PDF.';
      try {
        const j = await res.json();
        if (j?.error) msg = j.error;
      } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `consulta-taboa-${new Date().toISOString().slice(0, 10)}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function bindPdfButton(root) {
    const btn = root.querySelector('#btnConsultaPdf');
    const errEl = root.querySelector('#consultaPdfErr');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!lastPdfPayload) return;
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = '';
      }
      btn.disabled = true;
      const label = btn.querySelector('span');
      const prev = label?.textContent;
      if (label) label.textContent = 'Baixando…';
      try {
        await downloadConsultaPdf({ ...lastPdfPayload, ...cadastroPessoa() });
      } catch (e) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = e.message || String(e);
        }
        setStatus('Erro ao gerar o PDF: ' + (e.message || String(e)), true);
      } finally {
        if (label) label.textContent = prev || 'Baixar relatório';
        btn.disabled = false;
      }
    });
  }

  function setKmlLabel(name) {
    if (!kmlFn) return;
    const label = String(name || '').trim();
    kmlFn.textContent = label || 'Enviar Arquivo';
    kmlFn.closest('.consulta-upload')?.classList.toggle('is-filled', !!label);
  }

  function setKmlError(msg) {
    if (!kmlErr) return;
    if (msg) {
      kmlErr.hidden = false;
      kmlErr.textContent = msg;
    } else {
      kmlErr.hidden = true;
      kmlErr.textContent = '';
    }
  }

  function clearPreview() {
    const map = liveMap();
    if (drawTemp && map) {
      try { map.removeLayer(drawTemp); } catch (_) {}
      drawTemp = null;
    }
    if (previewGroup && map) {
      try { map.removeLayer(previewGroup); } catch (_) {}
      previewGroup = null;
    }
  }

  function clearResultLayers() {
    const map = liveMap();
    if (resultGroup && map) {
      try { map.removeLayer(resultGroup); } catch (_) {}
      resultGroup = null;
    }
  }

  function refLatLng() {
    if (geometry?.kind === 'point' && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)) {
      return { lat: geometry.lat, lng: geometry.lng };
    }
    const c = geometry?.feature?.geometry?.coordinates;
    if (geometry?.kind === 'point' && Array.isArray(c)) return { lat: c[1], lng: c[0] };
    try {
      const aoi = aoiOf(geometry);
      if (aoi.ok && aoi.point?.geometry?.coordinates) {
        const [lng, lat] = aoi.point.geometry.coordinates;
        return { lat, lng };
      }
    } catch (_) {}
    return { lat: NaN, lng: NaN };
  }

  function pointInFaixa(lat, lng) {
    return Number.isFinite(lat)
      && Number.isFinite(lng)
      && lng >= FAIXA_BBOX[0] && lng <= FAIXA_BBOX[2]
      && lat >= FAIXA_BBOX[1] && lat <= FAIXA_BBOX[3];
  }

  function coordsInvertidasMsg(lat, lng) {
    if (pointInFaixa(lat, lng)) return '';
    if (pointInFaixa(lng, lat)) {
      return 'Esse ponto está fora da área possível. Confira se latitude e longitude não foram invertidas.';
    }
    return '';
  }

  function updateGeomStatus() {
    if (!geomStatus) return;
    geomStatus.classList.remove('is-error', 'is-ok', 'is-loading');
    if (!geometry) {
      geomStatus.hidden = true;
      geomStatus.textContent = '';
      return;
    }
    const built = aoiOf(geometry);
    if (!built.ok) {
      geomStatus.hidden = false;
      geomStatus.classList.add('is-error');
      geomStatus.textContent = built.error;
      return;
    }
    if (geometry.kind === 'point' && geometry.source === 'coords') {
      const invertida = coordsInvertidasMsg(geometry.lat, geometry.lng);
      if (invertida) {
        geomStatus.hidden = false;
        geomStatus.classList.add('is-error');
        geomStatus.textContent = invertida;
        return;
      }
    }
    geomStatus.hidden = false;
    geomStatus.classList.add('is-ok');
    const ha = Number.isFinite(built.areaHa) && built.areaHa > 0
      ? formatHaPtBr(built.areaHa, 2)
      : '';
    if (geometry.kind === 'polygon' && ha) {
      geomStatus.textContent = `Área enviada: ${ha}`;
      return;
    }
    const extra = built.mode === 'buffer' && built.bufferMeters
      ? ` · buffer de ${formatMetros(built.bufferMeters)}`
      : '';
    geomStatus.textContent = ha
      ? `${kindLabelPt(geometry.kind)} (${sourceLabelPt(geometry.source)})${extra} · ${ha}`
      : `${kindLabelPt(geometry.kind)} (${sourceLabelPt(geometry.source)})${extra}.`;
  }

  function paintPreview({ fly = false } = {}) {
    clearPreview();
    const map = liveMap();
    if (!map || !geometry) return;
    const built = aoiOf(geometry);
    if (!built.ok) return;
    const layers = [];
    layers.push(L.geoJSON(built.aoi, { style: () => AOI_STYLE, interactive: false }));
    if (geometry.kind === 'point' && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)) {
      layers.push(L.marker([geometry.lat, geometry.lng], { icon: getPinIcon(), interactive: false }));
    }
    previewGroup = L.layerGroup(layers).addTo(map);
    try {
      const b = layers[0].getBounds?.();
      if (!b?.isValid()) return;
      if (fly) {
        try { map.stop(); } catch (_) {}
        if (
          geometry.kind === 'point'
          && Number.isFinite(geometry.lat)
          && Number.isFinite(geometry.lng)
          && typeof map.flyTo === 'function'
        ) {
          const zoom = Math.min(Math.max(map.getZoom?.() || 12, 15), 17);
          map.flyTo([geometry.lat, geometry.lng], zoom, { duration: 1.4, easeLinearity: 0.22 });
        } else if (typeof map.flyToBounds === 'function') {
          map.flyToBounds(b, { padding: [28, 28], maxZoom: 17, duration: 1.4, easeLinearity: 0.22 });
        } else {
          map.fitBounds(b, { padding: [28, 28], maxZoom: 17, animate: true });
        }
      } else {
        map.fitBounds(b, { padding: [28, 28], maxZoom: 17, animate: false });
      }
    } catch (_) {}
  }

  function setPointGeometry(lat, lng, source) {
    geometry = {
      kind: 'point',
      lat,
      lng,
      source,
      feature: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } },
    };
    if (latIn) latIn.value = fmtCoord(lat);
    if (lngIn) lngIn.value = fmtCoord(lng);
    updateGeomStatus();
    paintPreview({ fly: source === 'map-point' });
  }

  function setPolygonGeometry(feature, source, extra = {}) {
    geometry = { kind: 'polygon', feature, source, ...extra };
    if (latIn) latIn.value = '';
    if (lngIn) lngIn.value = '';
    updateGeomStatus();
    paintPreview({ fly: source === 'map-polygon' || source === 'imovel-car' });
  }

  function applyCoordsFromInputs() {
    const lat = parseDMSCoord(latIn.value?.trim());
    const lng = parseDMSCoord(lngIn.value?.trim());
    if (lat == null || lng == null) {
      if (geometry?.source === 'coords') {
        geometry = null;
        clearPreview();
        updateGeomStatus();
      }
      return;
    }
    setPointGeometry(lat, lng, 'coords');
  }

  function setMapHint(text, show) {
    if (!mapHint) return;
    mapHint.hidden = !show;
    mapHint.textContent = text || '';
  }

  function syncMapButtons() {
    const drawing = mapMode !== 'idle';
    const map = liveMap();
    const pointBtn = document.getElementById('btnConsultaPontoMapa');
    const drawBtn = document.getElementById('btnConsultaDesenhar');
    if (pointBtn) pointBtn.classList.toggle('is-active', mapMode === 'point');
    if (drawBtn) drawBtn.classList.toggle('is-active', mapMode === 'polygon');
    if (map?.getContainer()) {
      map.getContainer().classList.toggle('consulta-map-pick', drawing);
    }
  }

  function cancelMapMode() {
    const map = liveMap();
    mapMode = 'idle';
    drawLatLngs = [];
    drawCursor = null;
    if (polygonClickTimer) {
      clearTimeout(polygonClickTimer);
      polygonClickTimer = null;
    }
    if (drawTemp && map) {
      try { map.removeLayer(drawTemp); } catch (_) {}
      drawTemp = null;
    }
    try { map?.doubleClickZoom?.enable(); } catch (_) {}
    setMapHint('', false);
    syncMapButtons();
  }

  function nearestVertexIndex(latlng) {
    const map = liveMap();
    if (!map || !drawLatLngs.length) return { index: -1, distPx: Infinity };
    const pt = map.latLngToLayerPoint(latlng);
    let index = 0;
    let distPx = Infinity;
    drawLatLngs.forEach((ll, i) => {
      const d = pt.distanceTo(map.latLngToLayerPoint(ll));
      if (d < distPx) {
        distPx = d;
        index = i;
      }
    });
    return { index, distPx };
  }

  function refreshDrawTemp() {
    const map = liveMap();
    if (drawTemp && map) {
      try { map.removeLayer(drawTemp); } catch (_) {}
      drawTemp = null;
    }
    if (!map || mapMode !== 'polygon' || !drawLatLngs.length) return;

    const layers = [];
    if (drawLatLngs.length >= 2) {
      layers.push(L.polyline(drawLatLngs, DRAW_STYLE));
    }
    const last = drawLatLngs[drawLatLngs.length - 1];
    const nearStart = drawCursor && drawLatLngs.length >= 3
      ? nearestVertexIndex(drawCursor)
      : { index: -1, distPx: Infinity };
    const willClose = nearStart.index === 0 && nearStart.distPx <= SNAP_PX;

    if (drawCursor && last) {
      const rubberTo = willClose ? drawLatLngs[0] : drawCursor;
      layers.push(L.polyline([last, rubberTo], willClose ? CLOSE_STYLE : RUBBER_STYLE));
      if (drawLatLngs.length >= 2) {
        const ghost = willClose
          ? [...drawLatLngs, drawLatLngs[0]]
          : [...drawLatLngs, drawCursor];
        layers.push(L.polygon(ghost, GHOST_STYLE));
      }
    }

    drawLatLngs.forEach((ll, i) => {
      layers.push(L.circleMarker(ll, i === 0 ? VERTEX_START_STYLE : VERTEX_STYLE));
    });

    drawTemp = L.layerGroup(layers).addTo(map);
  }

  function enterMapMode(mode) {
    const map = liveMap();
    if (!map) {
      setStatus('O mapa ainda está carregando. Tente de novo em instantes.', true);
      return;
    }
    bindMapEvents(map);
    if (mapMode === mode) {
      cancelMapMode();
      return;
    }
    cancelMapMode();
    mapMode = mode;
    try { map.doubleClickZoom?.disable(); } catch (_) {}
    if (mode === 'point') {
      setMapHint('Clique no mapa para inserir o ponto. O buffer usa o tamanho da propriedade em hectares.', true);
    } else {
      setMapHint('Clique para marcar um vértice; a linha acompanha o cursor. Clique duplo adiciona o último vértice e fecha o polígono.', true);
    }
    syncMapButtons();
    setStatus(mode === 'point' ? 'Consulta: clique no mapa para o ponto.' : 'Consulta: desenhe o polígono no mapa.', false);
  }

  function finishPolygon(verts) {
    const pts = (verts || drawLatLngs).filter(Boolean);
    if (pts.length < 3) {
      setStatus('Desenhe pelo menos 3 vértices para o polígono.', true);
      return;
    }
    const ring = pts.map((ll) => [ll.lng, ll.lat]);
    ring.push([pts[0].lng, pts[0].lat]);
    let feature;
    try {
      feature = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      };
    } catch (_) {
      setStatus('Polígono inválido.', true);
      return;
    }
    cancelMapMode();
    if (kmlIn) kmlIn.value = '';
    setKmlLabel('');
    setKmlError('');
    setPolygonGeometry(feature, 'map-polygon');
    setStatus('Polígono definido. Clique em Consultar para cruzar com os alertas.', false);
  }

  function sameVertex(a, b) {
    if (!a || !b) return false;
    const map = liveMap();
    if (!map) {
      return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7;
    }
    try {
      return map.latLngToLayerPoint(a).distanceTo(map.latLngToLayerPoint(b)) <= SNAP_PX;
    } catch (_) {
      return false;
    }
  }

  function finishPolygonAtClick(latlng) {
    if (mapMode !== 'polygon') return;
    if (polygonClickTimer) {
      clearTimeout(polygonClickTimer);
      polygonClickTimer = null;
    }
    if (latlng) {
      const last = drawLatLngs[drawLatLngs.length - 1];
      if (!sameVertex(last, latlng)) drawLatLngs.push(latlng);
    }
    finishPolygon(drawLatLngs.slice());
  }

  function addPolygonVertex(latlng) {
    if (!latlng) return;
    if (drawLatLngs.length >= 3) {
      const { index, distPx } = nearestVertexIndex(latlng);
      if (index === 0 && distPx <= SNAP_PX) {
        finishPolygonAtClick(latlng);
        return;
      }
    }
    drawLatLngs.push(latlng);
    refreshDrawTemp();
    setMapHint(
      drawLatLngs.length < 3
        ? `${drawLatLngs.length} vértice(s). Continue clicando; a linha segue o cursor.`
        : `${drawLatLngs.length} vértice(s). Clique duplo adiciona o último vértice e fecha o polígono.`,
      true,
    );
    syncMapButtons();
  }

  function onDrawMove(e) {
    if (mapMode !== 'polygon' || !drawLatLngs.length || !e?.latlng) return;
    drawCursor = e.latlng;
    refreshDrawTemp();
  }

  function onMapClick(e) {
    if (mapMode === 'idle' || !e?.latlng) return;
    applyMapPick(e.latlng);
  }

  function applyMapPick(latlng) {
    if (!latlng || mapMode === 'idle') return;
    if (mapMode === 'point') {
      if (kmlIn) kmlIn.value = '';
      setKmlLabel('');
      setKmlError('');
      setPointGeometry(latlng.lat, latlng.lng, 'map-point');
      cancelMapMode();
      const built = aoiOf(geometry);
      setStatus(
        built.ok
          ? `Ponto inserido. Buffer de ${formatMetros(built.bufferMeters)}. Clique em Consultar.`
          : 'Ponto inserido. Informe o tamanho da propriedade em hectares para calcular o buffer.',
        !built.ok,
      );
      return;
    }
    if (mapMode !== 'polygon') return;
    if (polygonClickTimer) {
      clearTimeout(polygonClickTimer);
      polygonClickTimer = null;
      finishPolygonAtClick(latlng);
      return;
    }
    polygonClickTimer = setTimeout(() => {
      polygonClickTimer = null;
      addPolygonVertex(latlng);
    }, DBLCLICK_MS);
  }

  function syncExecutarButton() {
    if (!btnRun) return;
    const scanning = !!isScanInFlight?.();
    btnRun.disabled = scanning;
    btnRun.title = scanning
      ? 'Aguarde o fim da varredura de alertas (Aplicar filtros).'
      : 'Cruzar a área com os alertas MapBiomas';
  }

  async function runConsulta() {
    const myGen = ++runGeneration;
    if (isScanInFlight?.()) {
      resultEl.hidden = false;
      resultEl.innerHTML = '<p class="consulta-result-msg consulta-result-err">Varredura de alertas em andamento. Aguarde terminar e clique em <strong>Consultar</strong> novamente.</p>';
      setStatus('Consulta indisponível enquanto a varredura roda.', true);
      return;
    }
    applyCoordsFromInputs();
    const built = aoiOf(geometry);
    if (!built.ok) {
      resultEl.hidden = false;
      resultEl.innerHTML = `<p class="consulta-result-msg consulta-result-err">${esc(built.error)}</p>`;
      setStatus(built.error, true);
      return;
    }

    const alerts = getAlerts?.() || [];
    showLoading('Cruzando área com alertas MapBiomas…');
    updateLoading('Filtrando alertas na área');
    resultEl.hidden = false;
    resultEl.innerHTML = '<p class="consulta-result-msg">Cruzando a área de análise com os alertas MapBiomas…</p>';

    try {
      const inAoi = await filterAlertsInAoiAsync(alerts, { aoi: built.aoi }, () => myGen !== runGeneration);
      if (myGen !== runGeneration) return;

      const hits = [];
      const clips = [];
      const alertGeoms = [];
      let totalClipHa = 0;
      for (let i = 0; i < inAoi.length; i++) {
        if (i > 0 && i % 40 === 0) {
          if (myGen !== runGeneration) return;
          await yieldToMain();
        }
        const a = inAoi[i];
        const clip = resolveAlertClipInShape(a, built.aoi.geometry);
        if (!clip?.areaHa) continue;
        a._clippedAreaHa = clip.areaHa;
        a._clippedGeom = clip.geom || null;
        totalClipHa += clip.areaHa;
        hits.push(a);
        if (clip.geom) clips.push(clip.geom);
        const { geojson } = alertGeometryAndPoint(a);
        const full = geojson?.type === 'Feature' ? geojson.geometry : geojson;
        if (full?.type) alertGeoms.push(full);
      }
      if (myGen !== runGeneration) return;

      const { lat, lng } = refLatLng();
      let municipio = null;
      if (fetchMunicipio && Number.isFinite(lat) && Number.isFinite(lng)) {
        try {
          const res = await fetchMunicipio(lat, lng);
          if (res?.ok) municipio = res;
        } catch (_) {}
      }

      const overlapHa = unionOverlapHa(clips, totalClipHa);
      const overlapPct = built.areaHa > 0
        ? Math.min(100, Math.max(0, (overlapHa / built.areaHa) * 100))
        : 0;

      const reportOpts = {
        source: geometry.source,
        kind: geometry.kind,
        mode: built.mode,
        areaHa: built.areaHa,
        municipio,
        alerts: hits,
        totalClipHa,
        overlapHa,
        overlapPct,
        lat,
        lng,
        generatedAt: nowPtBr(),
        aoi: compactGeom(built.aoi),
        clips: alertGeoms.map((g) => compactGeom(g)).filter(Boolean).slice(0, 40),
        point: geometry.kind === 'point' && Number.isFinite(geometry.lng) && Number.isFinite(geometry.lat)
          ? [geometry.lng, geometry.lat]
          : null,
        ...cadastroPessoa(),
        car: geometry.car || (imovelIn?.value || '').trim(),
      };
      lastPdfPayload = buildConsultaPdfPayload(reportOpts);
      resultEl.innerHTML = buildConsultaReportHtml({ noAlertsLoaded: !alerts.length });
      bindPdfButton(resultEl);

      clearPreview();
      clearResultLayers();
      const map = liveMap();
      let territorio = { imoveis: [], apps: [], rls: [] };
      try {
        territorio = await findTerritorioConsulta(built, geometry);
      } catch (_) {}
      if (myGen !== runGeneration) return;
      const layers = [L.geoJSON(built.aoi, { style: () => AOI_STYLE })];
      territorio.imoveis.forEach((feat) => {
        layers.push(L.geoJSON(feat, { style: () => IMOVEL_STYLE }));
      });
      territorio.rls.forEach((feat) => {
        layers.push(L.geoJSON(feat, { style: () => RL_STYLE }));
      });
      territorio.apps.forEach((feat) => {
        layers.push(L.geoJSON(feat, { style: () => APP_STYLE }));
      });
      alertGeoms.forEach((geom) => {
        layers.push(L.geoJSON(geom, { style: () => CLIP_STYLE }));
      });
      if (geometry.kind === 'point' && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)) {
        layers.push(L.marker([geometry.lat, geometry.lng], { icon: getPinIcon() }));
      }
      if (map) {
        resultGroup = L.layerGroup(layers).addTo(map);
        try {
          const frameFeats = [
            ...territorio.imoveis,
            ...territorio.rls,
            ...territorio.apps,
          ];
          const frame = frameFeats.length
            ? L.geoJSON({ type: 'FeatureCollection', features: frameFeats })
            : L.geoJSON(built.aoi);
          const b = frame.getBounds();
          if (b.isValid()) map.fitBounds(b, { maxZoom: 17, padding: [28, 28] });
        } catch (_) {}
      }

      const msg = hits.length
        ? `Consulta: ${hits.length} alerta(s) MapBiomas na área.`
        : (alerts.length ? 'Consulta: nenhum alerta na área.' : 'Consulta: os alertas ainda estão sendo carregados.');
      setStatus(msg, false);
    } catch (e) {
      resultEl.innerHTML = `<p class="consulta-result-err">${esc(e.message || e)}</p>`;
      setStatus('Erro na consulta: ' + (e.message || String(e)), true);
    } finally {
      hideLoading();
    }
  }

  function clearAll() {
    runGeneration += 1;
    geometry = null;
    lastPdfPayload = null;
    cancelMapMode();
    clearPreview();
    clearResultLayers();
    if (latIn) latIn.value = '';
    if (lngIn) lngIn.value = '';
    if (nomeIn) nomeIn.value = '';
    if (cpfIn) cpfIn.value = '';
    if (areaHaIn) areaHaIn.value = '';
    if (kmlIn) kmlIn.value = '';
    if (munIn) munIn.value = '';
    if (imovelIn) {
      imovelIn.value = '';
      delete imovelIn.dataset.index;
      delete imovelIn.dataset.car;
    }
    if (typeof onImovelCleared === 'function') onImovelCleared();
    setKmlLabel('');
    setKmlError('');
    resultEl.hidden = true;
    resultEl.innerHTML = '';
    updateGeomStatus();
    setStatus('', false);
  }

  areaHaIn?.addEventListener('input', () => {
    if (geometry?.kind !== 'point') return;
    updateGeomStatus();
    paintPreview({ fly: false });
  });
  latIn.addEventListener('input', () => applyCoordsFromInputs());
  lngIn.addEventListener('input', () => applyCoordsFromInputs());
  latIn.addEventListener('blur', () => applyCoordsFromInputs());
  lngIn.addEventListener('blur', () => applyCoordsFromInputs());
  cpfIn?.addEventListener('input', () => {
    const next = formatCpfInput(cpfIn.value);
    if (cpfIn.value !== next) cpfIn.value = next;
  });

  kmlIn?.addEventListener('change', async () => {
    setKmlError('');
    const file = kmlIn.files?.[0];
    if (!file) {
      setKmlLabel('');
      return;
    }
    const name = file.name || '';
    setKmlLabel(name);
    if (/\.kmz$/i.test(name) || file.type === 'application/vnd.google-earth.kmz') {
      setKmlError('KMZ não é aceito. Exporte como KML.');
      kmlIn.value = '';
      setKmlLabel('');
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (_) {
      setKmlError('Não foi possível ler o arquivo.');
      return;
    }
    const parsed = extractConsultaGeometryFromKml(text);
    if (!parsed.ok) {
      setKmlError(parsed.error);
      return;
    }
    cancelMapMode();
    if (parsed.kind === 'point') {
      setPointGeometry(parsed.lat, parsed.lng, 'kml');
    } else {
      setPolygonGeometry(parsed.feature, 'kml');
    }
    const crsNote = parsed.crsFrom && parsed.crsFrom !== 'EPSG:4326'
      ? ` (${parsed.crsLabel || parsed.crsFrom} → WGS84)`
      : '';
    setStatus(`KML carregado${crsNote}. Clique em Consultar para cruzar com os alertas.`, false);
  });

  document.addEventListener('click', (ev) => {
    const el = ev.target instanceof Element ? ev.target : null;
    if (!el) return;
    if (el.closest('#btnConsultaPontoMapa')) {
      ev.preventDefault();
      enterMapMode('point');
    } else if (el.closest('#btnConsultaDesenhar')) {
      ev.preventDefault();
      enterMapMode('polygon');
    }
  });
  btnRun?.addEventListener('click', () => {
    runConsulta().catch((e) => setStatus('Erro na consulta: ' + (e.message || e), true));
  });
  btnClear?.addEventListener('click', () => clearAll());
  btnReset?.addEventListener('click', () => {
    cancelMapMode();
    clearPreview();
    clearResultLayers();
    if (typeof resetMapView === 'function') resetMapView();
    setStatus('Mapa restaurado ao estado inicial.', false);
  });

  function positionComboboxList(ul, input) {
    if (!ul || !input) return;
    if (ul.parentElement !== document.body) document.body.appendChild(ul);
    const rect = input.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const maxH = Math.max(160, Math.min(280, spaceBelow));
    ul.style.position = 'fixed';
    ul.style.left = `${Math.round(rect.left)}px`;
    ul.style.width = `${Math.round(rect.width)}px`;
    ul.style.right = 'auto';
    ul.style.top = `${Math.round(rect.bottom + gap)}px`;
    ul.style.bottom = 'auto';
    ul.style.zIndex = '4000';
    ul.style.maxHeight = `${maxH}px`;
    ul.hidden = false;
  }

  function setupImovelCombobox() {
    const input = imovelIn;
    const ul = document.getElementById('imoveisDropdown');
    const toggle = document.getElementById('btnImovelToggle');
    if (!input || !ul) return;
    let timer = 0;
    let lastItems = [];
    let seq = 0;

    function munFilter() {
      return (munIn?.value || '').trim();
    }

    async function applyImovel(item) {
      if (!item) return;
      input.value = item.label || item.car || '';
      input.dataset.index = String(item.i);
      input.dataset.car = item.car || '';
      ul.hidden = true;
      const base = getApiBase();
      if (!base) return;
      try {
        const res = await fetch(`${String(base).replace(/\/$/, '')}/api/shape/imovel?i=${encodeURIComponent(item.i)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        const feat = data?.feature;
        if (!feat?.geometry) {
          setStatus('Não foi possível carregar o polígono do imóvel.', true);
          return;
        }
        cancelMapMode();
        setPolygonGeometry(feat, 'imovel-car', { car: item.car || '' });
        if (typeof onImovelSelected === 'function') onImovelSelected(feat);
        setStatus('Imóvel rural selecionado. Clique em Consultar.', false);
      } catch (e) {
        setStatus('Erro ao carregar o imóvel: ' + (e.message || e), true);
      }
    }

    function renderList(items, emptyText) {
      lastItems = items || [];
      if (!lastItems.length) {
        ul.innerHTML = `<li class="filter-combobox-empty">${emptyText || 'Nenhum resultado'}</li>`;
        return;
      }
      ul.innerHTML = lastItems.map((it) => (
        `<li data-index="${it.i}" data-car="${String(it.car || '').replace(/"/g, '&quot;')}">${String(it.label || it.car || '').replace(/</g, '&lt;')}</li>`
      )).join('');
      ul.querySelectorAll('li[data-index]').forEach((li) => {
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const item = lastItems.find((it) => String(it.i) === li.dataset.index);
          applyImovel(item);
        });
      });
    }

    async function refresh(open) {
      const q = input.value.trim();
      const mun = munFilter();
      if (q.length < 2 && !mun) {
        renderList([], 'Digite o CAR ou selecione o município');
        if (open) positionComboboxList(ul, input);
        return;
      }
      const base = getApiBase();
      if (!base) return;
      const my = ++seq;
      const params = new URLSearchParams({ q, limit: '40' });
      if (mun) params.set('municipio', mun);
      try {
        const res = await fetch(`${String(base).replace(/\/$/, '')}/api/shape/imoveis?${params}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (my !== seq) return;
        renderList(data?.items || [], 'Nenhum imóvel encontrado');
        const matched = Number(data?.matched);
        if (matched > (data?.items || []).length) {
          const more = document.createElement('li');
          more.className = 'filter-combobox-empty';
          more.textContent = `Mostrando ${data.items.length} de ${matched}. Digite o CAR ou o nome para localizar.`;
          ul.appendChild(more);
        }
        if (open) positionComboboxList(ul, input);
      } catch (_) {
        if (my !== seq) return;
        renderList([], 'Falha ao buscar imóveis');
        if (open) positionComboboxList(ul, input);
      }
    }

    input.addEventListener('focus', () => refresh(true));
    input.addEventListener('input', () => {
      delete input.dataset.index;
      clearTimeout(timer);
      timer = setTimeout(() => refresh(true), 220);
    });
    toggle?.addEventListener('click', () => {
      if (ul.hidden) refresh(true);
      else ul.hidden = true;
    });
    input.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; }, 160));
    input.closest('.filter-tab-content')?.addEventListener('scroll', () => { ul.hidden = true; }, { passive: true });
    window.addEventListener('resize', () => { ul.hidden = true; });
    document.addEventListener('pointerdown', (ev) => {
      if (ul.hidden) return;
      const t = ev.target;
      if (ul.contains(t) || input.contains(t) || toggle?.contains(t)) return;
      ul.hidden = true;
    }, true);
    munIn?.addEventListener('input', () => {
      if (input.dataset.index) {
        input.value = '';
        delete input.dataset.index;
        delete input.dataset.car;
        if (geometry?.source === 'imovel-car') {
          geometry = null;
          clearPreview();
          updateGeomStatus();
        }
        if (typeof onImovelCleared === 'function') onImovelCleared();
      }
    });
  }

  setupImovelCombobox();

  let dragging = false;
  let boundMap = null;
  let boundEl = null;
  let lastPickAt = 0;

  function notePick() {
    const now = Date.now();
    if (now - lastPickAt < 80) return false;
    lastPickAt = now;
    return true;
  }

  function onMapDragStart() { dragging = true; }
  function onMapDragEnd() { setTimeout(() => { dragging = false; }, 80); }

  function onLeafletClick(e) {
    if (mapMode === 'idle' || !e?.latlng || dragging) return;
    if (!notePick()) return;
    try { L.DomEvent.stop(e); } catch (_) {}
    applyMapPick(e.latlng);
  }

  function onDomPick(ev) {
    if (mapMode === 'idle') return;
    if (ev.target?.closest?.('.leaflet-control, .leaflet-popup, .sidebar, .topbar, .analytics-wrap')) return;
    const map = liveMap();
    if (!map) return;
    if (dragging) {
      dragging = false;
      return;
    }
    let latlng = null;
    try { latlng = map.mouseEventToLatLng(ev); } catch (_) {}
    if (!latlng) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (!notePick()) return;
    applyMapPick(latlng);
  }

  function onDomDblClick(ev) {
    if (mapMode !== 'polygon') return;
    if (ev.target?.closest?.('.leaflet-control, .leaflet-popup, .sidebar, .topbar, .analytics-wrap')) return;
    ev.preventDefault();
    ev.stopPropagation();
    const map = liveMap();
    if (!map) return;
    let latlng = null;
    try { latlng = map.mouseEventToLatLng(ev); } catch (_) {}
    finishPolygonAtClick(latlng);
  }

  function unbindMapEvents() {
    if (boundEl) {
      try {
        boundEl.removeEventListener('click', onDomPick, true);
        boundEl.removeEventListener('dblclick', onDomDblClick, true);
      } catch (_) {}
      boundEl = null;
    }
    if (boundMap) {
      try {
        boundMap.off('dragstart', onMapDragStart);
        boundMap.off('dragend', onMapDragEnd);
        boundMap.off('mousemove', onDrawMove);
        boundMap.off('click', onLeafletClick);
      } catch (_) {}
      boundMap = null;
    }
  }

  function bindMapEvents(map) {
    if (!map) return;
    const el = map.getContainer?.();
    if (boundMap === map && boundEl === el) return;
    unbindMapEvents();
    boundMap = map;
    boundEl = el || null;
    map.on('dragstart', onMapDragStart);
    map.on('dragend', onMapDragEnd);
    map.on('mousemove', onDrawMove);
    map.on('click', onLeafletClick);
    if (boundEl) {
      boundEl.addEventListener('click', onDomPick, true);
      boundEl.addEventListener('dblclick', onDomDblClick, true);
    }
  }

  bindMapEvents(liveMap());

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && mapMode !== 'idle') {
      cancelMapMode();
    }
  });

  updateGeomStatus();
  syncExecutarButton();
  syncMapButtons();

  return { syncExecutarButton, cancelMapMode, clearAll };
}
