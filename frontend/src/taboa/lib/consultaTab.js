/**
 * Aba Consulta: coordenadas, KML (ponto/polígono), clique/desenho no mapa,
 * buffer do ponto pela área da propriedade e relatório de cruzamento com o PRODES.
 */
import L from 'leaflet';
import { parseDMSCoord } from './registros.js';
import { extractConsultaGeometryFromKml } from './kmlGeometry.js';
import { buildConsultaAoi, parseHectares } from './consultaAoi.js';
import { buildConsultaReportHtml, buildConsultaPdfPayload, kindLabelPt, sourceLabelPt } from './consultaReport.js';
import { formatHaPtBr } from './formatPtBr.js';
import { getApiBase } from './config.js';
import * as turf from '@turf/turf';
import { FAIXA_BBOX } from './faixaShapeNormalize.js';

const AOI_STYLE = { color: '#0284c7', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.18, interactive: false };
/** Limite do CAR de referência: amarelo atual, borda mais grossa, sem preenchimento. */
const IMOVEL_STYLE = {
  color: '#eab308',
  weight: 3.5,
  opacity: 1,
  fill: false,
  fillOpacity: 0,
  interactive: false,
};
const APP_STYLE = { color: '#0e7490', weight: 1.6, fillColor: '#67e8f9', fillOpacity: 0.35, interactive: false };
const RL_STYLE = { color: '#166534', weight: 1.6, fillColor: '#86efac', fillOpacity: 0.35, interactive: false };
const DRAW_STYLE = { color: '#0284c7', weight: 2.2, dashArray: '10 7', fill: false, className: 'consulta-draw-line', interactive: false };
const RUBBER_STYLE = { color: '#38bdf8', weight: 2, dashArray: '7 6', fill: false, className: 'consulta-draw-rubber', interactive: false };
const CLOSE_STYLE = { color: '#0ea5e9', weight: 2, dashArray: '5 5', fill: false, className: 'consulta-draw-close', interactive: false };
const GHOST_STYLE = { color: '#0284c7', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12, dashArray: '6 4', className: 'consulta-draw-ghost', interactive: false };
const PRODES_STYLE = { color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.35, interactive: false };
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

async function fetchProdesCruzamento(aoi) {
  const base = getApiBase();
  if (!base) throw new Error('O cruzamento com o PRODES precisa do servidor.');
  const res = await fetch(`${String(base).replace(/\/$/, '')}/api/prodes/cruzar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aoi }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(data?.error || 'Não foi possível consultar o PRODES.');
  return data;
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
    fetchShapeInBbox('imoveis_rurais.gpkg', bbox),
    fetchShapeInBbox('app.gpkg', bbox),
    fetchShapeInBbox('reserva_legal.gpkg', bbox),
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
 * @param {(msg: string, isError?: boolean) => void} ctx.setStatus
 * @param {(msg: string) => void} ctx.showLoading
 * @param {(msg: string) => void} ctx.updateLoading
 * @param {() => void} ctx.hideLoading
 * @param {(lat: number, lng: number) => Promise<object>} [ctx.fetchMunicipio]
 */
export function setupConsultaTab(ctx) {
  const {
    setStatus,
    showLoading,
    updateLoading,
    hideLoading,
    fetchMunicipio,
    resetMapView,
    clearSelectorMap,
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
  /** @type {null | { feature: object, car: string, source: string }} */
  let propertyRef = null;
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

  function isCarSource(source) {
    return source === 'imovel-car' || source === 'assentamento-car';
  }

  function geometryIsPropertyRef() {
    return !!(geometry && propertyRef && isCarSource(geometry.source));
  }

  function compactPropertyGeom() {
    if (!propertyRef?.feature) return null;
    return compactGeom(propertyRef.feature);
  }

  /** Cadastro da propriedade selecionada (CAR/assentamento), sem puxar vizinhos. */
  function selectedImovelPayload() {
    const feat = propertyRef?.feature || (geometryIsPropertyRef() ? geometry?.feature : null);
    if (!feat?.geometry) return null;
    const p = feat.properties || {};
    const source = propertyRef?.source || geometry?.source || '';
    const isAssent = source === 'assentamento-car';
    const car = String(
      propertyRef?.car
      || geometry?.car
      || p.numero_car
      || p.NUMERO_CAR
      || '',
    ).trim();
    const nome = String(
      p.denominaca || p.DENOMINACA || p.nome_projeto || p.nome_proje || '',
    ).trim().replace(/^["']+|["']+$/g, '');
    const ide = p.ide_imovel != null || p.IDE_IMOVEL != null
      ? String(p.ide_imovel ?? p.IDE_IMOVEL).trim()
      : '';
    const municipio = String(p.municipio || p.MUNICIPIO || p.nm_municip || '').trim();
    const areaRaw = Number(String(p.area_regis ?? p.AREA_REGIS ?? p.area_hectare_declarada ?? '').replace(',', '.'));
    const sipra = String(p.cod_sipra || p.cd_sipra || '').trim();
    const status = String(p.status || '').trim();
    const familiasRaw = Number(p.qtd_famili ?? p.num_familias);
    const modFiscaisRaw = Number(p.qtd_modfis);
    const dtAssenta = String(p.dt_assenta || p.data_de_criacao || '').trim();
    return {
      nome: nome || (car ? `CAR ${car}` : 'Propriedade selecionada'),
      car,
      ide,
      municipio,
      areaHa: Number.isFinite(areaRaw) && areaRaw > 0 ? areaRaw : null,
      pct: 100,
      geometry: compactGeom(feat),
      source,
      tipo: isAssent ? 'Assentamento' : 'Imóvel rural',
      sipra: sipra && sipra.toUpperCase() !== 'N/D' ? sipra : '',
      status,
      familias: Number.isFinite(familiasRaw) ? familiasRaw : null,
      modFiscais: Number.isFinite(modFiscaisRaw) ? modFiscaisRaw : null,
      dtAssenta,
    };
  }

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
    if (!geometry && propertyRef) {
      geomStatus.hidden = false;
      geomStatus.classList.add('is-ok');
      geomStatus.textContent = propertyRef.car
        ? `Propriedade de referência (CAR ${propertyRef.car}). Insira um ponto ou desenhe a área do projeto, ou consulte a propriedade inteira.`
        : 'Propriedade de referência no mapa. Insira um ponto ou desenhe a área do projeto, ou consulte a propriedade inteira.';
      return;
    }
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
    const refNote = propertyRef && !geometryIsPropertyRef()
      ? ' · CAR só como referência da propriedade'
      : '';
    if (geometry.kind === 'polygon' && ha) {
      geomStatus.textContent = `Área enviada: ${ha}${refNote}`;
      return;
    }
    const extra = built.mode === 'buffer' && built.bufferMeters
      ? ` · buffer de ${formatMetros(built.bufferMeters)}`
      : '';
    geomStatus.textContent = ha
      ? `${kindLabelPt(geometry.kind)} (${sourceLabelPt(geometry.source)})${extra} · ${ha}${refNote}`
      : `${kindLabelPt(geometry.kind)} (${sourceLabelPt(geometry.source)})${extra}${refNote}.`;
  }

  function paintPreview({ fly = false } = {}) {
    clearPreview();
    const map = liveMap();
    if (!map) return;
    const layers = [];
    let focusLayer = null;
    if (propertyRef?.feature) {
      const propLayer = L.geoJSON(propertyRef.feature, { style: () => IMOVEL_STYLE, interactive: false });
      layers.push(propLayer);
      if (geometryIsPropertyRef()) focusLayer = propLayer;
    }
    if (geometry && !geometryIsPropertyRef()) {
      const built = aoiOf(geometry);
      if (built.ok) {
        const aoiLayer = L.geoJSON(built.aoi, { style: () => AOI_STYLE, interactive: false });
        layers.push(aoiLayer);
        focusLayer = aoiLayer;
        if (geometry.kind === 'point' && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)) {
          layers.push(L.marker([geometry.lat, geometry.lng], { icon: getPinIcon(), interactive: false }));
        }
      }
    } else if (geometry && geometryIsPropertyRef()) {
      // Análise = propriedade: só o contorno amarelo (sem azul por cima).
      focusLayer = layers[0] || null;
    }
    if (!layers.length) return;
    previewGroup = L.layerGroup(layers).addTo(map);
    try {
      const b = (focusLayer || layers[0]).getBounds?.();
      if (!b?.isValid()) return;
      if (fly) {
        try { map.stop(); } catch (_) {}
        if (
          geometry?.kind === 'point'
          && !geometryIsPropertyRef()
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

  function setPropertyRef(feature, source, car) {
    propertyRef = feature?.geometry
      ? { feature, source, car: String(car || '').trim() }
      : null;
  }

  function setPointGeometry(lat, lng, source) {
    geometry = {
      kind: 'point',
      lat,
      lng,
      source,
      feature: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } },
      car: propertyRef?.car || '',
    };
    if (latIn) latIn.value = fmtCoord(lat);
    if (lngIn) lngIn.value = fmtCoord(lng);
    updateGeomStatus();
    paintPreview({ fly: source === 'map-point' });
  }

  function setPolygonGeometry(feature, source, extra = {}) {
    geometry = {
      kind: 'polygon',
      feature,
      source,
      car: propertyRef?.car || '',
      ...extra,
    };
    if (latIn) latIn.value = '';
    if (lngIn) lngIn.value = '';
    updateGeomStatus();
    paintPreview({
      fly: source === 'map-polygon' || isCarSource(source),
    });
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
    setStatus(
      propertyRef
        ? 'Polígono definido (área do projeto). O CAR permanece só como referência. Clique em Consultar.'
        : 'Polígono definido. Clique em Consultar para cruzar com o PRODES.',
      false,
    );
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
      const refHint = propertyRef ? ' O CAR permanece só como referência da propriedade.' : '';
      setStatus(
        built.ok
          ? `Ponto inserido. Buffer de ${formatMetros(built.bufferMeters)}. Clique em Consultar.${refHint}`
          : `Ponto inserido. Informe o tamanho da propriedade em hectares para calcular o buffer.${refHint}`,
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
    btnRun.disabled = false;
    btnRun.title = 'Cruzar a área com o PRODES';
  }

  async function runConsulta() {
    const myGen = ++runGeneration;
    applyCoordsFromInputs();
    const built = aoiOf(geometry);
    if (!built.ok) {
      resultEl.hidden = false;
      resultEl.innerHTML = `<p class="consulta-result-msg consulta-result-err">${esc(built.error)}</p>`;
      setStatus(built.error, true);
      return;
    }

    showLoading('Cruzando área com o PRODES…');
    updateLoading('Consultando o PRODES na área');
    resultEl.hidden = false;
    resultEl.innerHTML = '<p class="consulta-result-msg">Cruzando a área de análise com o PRODES…</p>';

    try {
      const aoi = compactGeom(built.aoi);
      let prodes = { hit: false, count: 0, areaHa: 0, pct: 0, itens: [] };
      let prodesError = '';
      try {
        updateLoading('Consultando o PRODES (INPE)…');
        prodes = await fetchProdesCruzamento(aoi);
      } catch (err) {
        // Terrabrasilis/WFS fora do ar não pode impedir o resto da consulta (CAR, APP, RL, PDF).
        prodesError = String(err?.message || err || 'PRODES indisponível');
        if (/fetch failed|Failed to fetch|NetworkError|abort|ConnectTimeout|inacessível/i.test(prodesError)) {
          prodesError = 'Serviço PRODES (INPE) inacessível nesta rede — falha da API do órgão, não do Tabôa';
        }
        updateLoading('PRODES indisponível — seguindo com CAR, APP e reserva legal…');
      }
      if (myGen !== runGeneration) return;
      const prodesGeoms = (prodes.itens || []).map((it) => it.geometry).filter((g) => g?.type);

      const { lat, lng } = refLatLng();
      let municipio = null;
      if (fetchMunicipio && Number.isFinite(lat) && Number.isFinite(lng)) {
        try {
          const res = await fetchMunicipio(lat, lng);
          if (res?.ok) municipio = res;
        } catch (_) {}
      }

      const carRef = propertyRef?.car || geometry.car || (imovelIn?.dataset?.car || '').trim()
        || (imovelIn?.value || '').trim();
      const propriedadeGeom = compactPropertyGeom();
      const analysisUsesProperty = geometryIsPropertyRef();
      // Sempre que houver CAR/assentamento selecionado, ele é a "propriedade" do relatório.
      const selectedImovel = propertyRef ? selectedImovelPayload() : null;
      lastPdfPayload = buildConsultaPdfPayload({
        source: geometry.source,
        kind: geometry.kind,
        mode: built.mode,
        areaHa: built.areaHa,
        municipio,
        lat,
        lng,
        generatedAt: nowPtBr(),
        aoi,
        point: geometry.kind === 'point' && Number.isFinite(geometry.lng) && Number.isFinite(geometry.lat)
          ? [geometry.lng, geometry.lat]
          : null,
        ...cadastroPessoa(),
        car: carRef,
        propriedadeGeom: analysisUsesProperty ? null : propriedadeGeom,
        propriedadeCar: analysisUsesProperty ? '' : (propertyRef?.car || ''),
        hasPropriedadeRef: !!(propertyRef && !analysisUsesProperty),
        selectedImovel,
      });
      resultEl.innerHTML = buildConsultaReportHtml();
      if (prodesError) {
        const warn = document.createElement('p');
        warn.className = 'consulta-result-msg consulta-result-err';
        warn.textContent = `${prodesError}. O restante da consulta (imóvel, APP, reserva legal e laudo) segue normalmente.`;
        resultEl.prepend(warn);
      }
      bindPdfButton(resultEl);

      clearPreview();
      clearResultLayers();
      const map = liveMap();
      let territorio = { imoveis: [], apps: [], rls: [] };
      try {
        // Com CAR selecionado como área de análise, não busca imóveis vizinhos
        // que só se sobrepõem (ex.: assentamento × imóveis rurais ao redor).
        territorio = analysisUsesProperty
          ? { imoveis: [], apps: [], rls: [] }
          : await findTerritorioConsulta(built, geometry);
      } catch (_) {}
      if (myGen !== runGeneration) return;
      const layers = [];
      if (propertyRef?.feature) {
        layers.push(L.geoJSON(propertyRef.feature, { style: () => IMOVEL_STYLE }));
      }
      if (!analysisUsesProperty) {
        layers.push(L.geoJSON(built.aoi, { style: () => AOI_STYLE }));
      }
      territorio.imoveis.forEach((feat) => {
        const car = String(feat.properties?.NUMERO_CAR || feat.properties?.numero_car || '').trim();
        if (propertyRef?.car && car && car.toLowerCase() === propertyRef.car.toLowerCase()) return;
        layers.push(L.geoJSON(feat, { style: () => IMOVEL_STYLE }));
      });
      territorio.rls.forEach((feat) => {
        layers.push(L.geoJSON(feat, { style: () => RL_STYLE }));
      });
      territorio.apps.forEach((feat) => {
        layers.push(L.geoJSON(feat, { style: () => APP_STYLE }));
      });
      prodesGeoms.forEach((geom) => {
        layers.push(L.geoJSON(geom, { style: () => PRODES_STYLE }));
      });
      if (geometry.kind === 'point' && Number.isFinite(geometry.lat) && Number.isFinite(geometry.lng)) {
        layers.push(L.marker([geometry.lat, geometry.lng], { icon: getPinIcon() }));
      }
      if (map) {
        resultGroup = L.layerGroup(layers).addTo(map);
        try {
          const focus = analysisUsesProperty && propertyRef?.feature
            ? L.geoJSON(propertyRef.feature)
            : L.geoJSON(built.aoi);
          const b = focus.getBounds();
          if (b.isValid()) map.fitBounds(b, { maxZoom: 17, padding: [28, 28] });
        } catch (_) {}
      }

      if (prodesError) {
        setStatus(`Consulta concluída. ${prodesError} — o cruzamento PRODES fica pendente.`, true);
      } else {
        setStatus(prodes.count
          ? `Consulta: ${prodes.count} desmatamento(s) PRODES na área.`
          : 'Consulta: nenhum desmatamento PRODES na área.', false);
      }
    } catch (e) {
      resultEl.innerHTML = `<p class="consulta-result-err">${esc(e.message || e)}</p>`;
      setStatus('Erro na consulta: ' + (e.message || String(e)), true);
    } finally {
      hideLoading();
    }
  }

  function clearDrawnAreaKeepProperty() {
    runGeneration += 1;
    lastPdfPayload = null;
    cancelMapMode();
    clearResultLayers();
    if (latIn) latIn.value = '';
    if (lngIn) lngIn.value = '';
    if (kmlIn) kmlIn.value = '';
    setKmlLabel('');
    setKmlError('');
    resultEl.hidden = true;
    resultEl.innerHTML = '';
    // Volta a área de análise para a propriedade selecionada e dá zoom nela.
    setPolygonGeometry(propertyRef.feature, propertyRef.source, { car: propertyRef.car || '' });
    setStatus(
      'Ponto/desenho removido. A propriedade (CAR) continua selecionada.',
      false,
    );
  }

  function clearAll() {
    // Com CAR + ponto/desenho: Limpar tira só a área inserida e volta o zoom à propriedade.
    if (propertyRef?.feature && geometry && !geometryIsPropertyRef()) {
      clearDrawnAreaKeepProperty();
      return;
    }
    runGeneration += 1;
    geometry = null;
    propertyRef = null;
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
    const carStatus = document.getElementById('consultaImovelStatus');
    if (carStatus) {
      carStatus.hidden = true;
      carStatus.textContent = '';
      carStatus.classList.remove('is-ok', 'is-error', 'is-loading');
    }
    if (typeof onImovelCleared === 'function') onImovelCleared();
    document.querySelectorAll('.filter-combobox-list').forEach((ul) => { ul.hidden = true; });
    if (typeof clearSelectorMap === 'function') clearSelectorMap();
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
    setStatus(`KML carregado${crsNote}. Clique em Consultar para cruzar com o PRODES.`, false);
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
    const statusEl = document.getElementById('consultaImovelStatus');
    if (!input) return;
    let timer = 0;
    let seq = 0;
    let applying = false;

    /** Formato SICAR BA: BA-#######-XXXX.XXXX.XXXX.XXXX.XXXX.XXXX.XXXX.XXXX (50 caracteres). */
    const CAR_FULL_LEN = 50;
    const CAR_COMPACT_LEN = 41;
    const CAR_PATTERN = /BA-\d{7}-[A-F0-9]{4}(?:\.[A-F0-9]{4}){7}/i;

    function compactCar(s) {
      return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
    }

    function formatCarFromCompact(compact) {
      const c = String(compact || '').toUpperCase();
      if (!/^BA\d{7}[A-F0-9]{32}$/.test(c)) return '';
      const mun = c.slice(2, 9);
      const hex = c.slice(9);
      const parts = [];
      for (let i = 0; i < 32; i += 4) parts.push(hex.slice(i, i + 4));
      return `BA-${mun}-${parts.join('.')}`;
    }

    /** Extrai e normaliza o CAR (trim, cola com texto extra, espaços). */
    function extractCar(raw) {
      const text = String(raw || '').trim();
      if (!text) return '';
      const fromPattern = text.match(CAR_PATTERN);
      if (fromPattern) return fromPattern[0].toUpperCase();
      const compact = compactCar(text);
      if (compact.length >= CAR_COMPACT_LEN) {
        const formatted = formatCarFromCompact(compact.slice(0, CAR_COMPACT_LEN));
        if (formatted) return formatted;
      }
      return text.replace(/\s+/g, '').toUpperCase();
    }

    function isCompleteCar(car) {
      return CAR_PATTERN.test(String(car || '')) && String(car).length === CAR_FULL_LEN;
    }

    function setCarStatus(text, tone = '') {
      if (!statusEl) return;
      const msg = String(text || '').trim();
      statusEl.hidden = !msg;
      statusEl.textContent = msg;
      statusEl.classList.remove('is-ok', 'is-error', 'is-loading');
      if (tone) statusEl.classList.add(tone);
    }

    async function applyImovel(item) {
      if (!item || applying) return;
      applying = true;
      input.value = item.car || '';
      input.dataset.index = String(item.i);
      input.dataset.car = item.car || '';
      const nome = String(item.nome || '').trim();
      setCarStatus(
        nome ? `CAR encontrado — ${nome}` : `CAR encontrado — ${item.car}`,
        'is-ok',
      );
      const base = getApiBase();
      if (!base) {
        applying = false;
        return;
      }
      try {
        const res = await fetch(`${String(base).replace(/\/$/, '')}/api/shape/imovel?i=${encodeURIComponent(item.i)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        const feat = data?.feature;
        if (!feat?.geometry) {
          setCarStatus('CAR encontrado, mas não foi possível carregar o polígono.', 'is-error');
          setStatus('Não foi possível carregar o polígono do imóvel.', true);
          return;
        }
        cancelMapMode();
        const fromAssent = item.source === 'assentamento-car' || String(item.i).startsWith('a:');
        const source = fromAssent ? 'assentamento-car' : 'imovel-car';
        const car = item.car || '';
        setPropertyRef(feat, source, car);
        setPolygonGeometry(feat, source, { car });
        if (typeof onImovelSelected === 'function') onImovelSelected(feat);
        setStatus(
          fromAssent
            ? 'Assentamento (CAR) no mapa como referência. Pode consultar a propriedade ou inserir ponto/desenhar a área do projeto.'
            : 'CAR no mapa como referência. Pode consultar a propriedade ou inserir ponto/desenhar a área do projeto.',
          false,
        );
      } catch (e) {
        setCarStatus('Falha ao carregar o CAR.', 'is-error');
        setStatus('Erro ao carregar o imóvel: ' + (e.message || e), true);
      } finally {
        applying = false;
      }
    }

    async function lookupFullCar(car) {
      const base = getApiBase();
      if (!base) return;
      const my = ++seq;
      setCarStatus('Buscando CAR…', 'is-loading');
      try {
        const params = new URLSearchParams({ q: car, limit: '5' });
        const res = await fetch(`${String(base).replace(/\/$/, '')}/api/shape/imoveis?${params}`, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (my !== seq) return;
        const items = data?.items || [];
        const target = compactCar(car);
        const exact = items.find((it) => compactCar(it.car) === target);
        if (exact) {
          const already = compactCar(input.dataset.car || '') === target;
          if (!already) await applyImovel(exact);
          else {
            setCarStatus(
              exact.nome ? `CAR encontrado — ${exact.nome}` : `CAR encontrado — ${exact.car}`,
              'is-ok',
            );
          }
          return;
        }
        setCarStatus('CAR não encontrado', 'is-error');
        delete input.dataset.index;
        delete input.dataset.car;
      } catch (_) {
        if (my !== seq) return;
        setCarStatus('Falha ao buscar o CAR.', 'is-error');
      }
    }

    function evaluateCarInput({ forceLookup = false } = {}) {
      if (applying) return;
      const extracted = extractCar(input.value);
      if (extracted && extracted !== input.value.trim()) {
        // Normaliza cola com espaços/texto extra sem disparar loop.
        applying = true;
        input.value = extracted;
        applying = false;
      }
      const value = String(input.value || '').trim();
      if (!value) {
        setCarStatus('');
        delete input.dataset.index;
        delete input.dataset.car;
        return;
      }
      if (isCompleteCar(value)) {
        if (forceLookup || compactCar(input.dataset.car || '') !== compactCar(value)) {
          lookupFullCar(value);
        }
        return;
      }
      const compact = compactCar(value);
      if (compact.length >= CAR_COMPACT_LEN && !isCompleteCar(value)) {
        const formatted = formatCarFromCompact(compact.slice(0, CAR_COMPACT_LEN));
        if (formatted) {
          applying = true;
          input.value = formatted;
          applying = false;
          lookupFullCar(formatted);
          return;
        }
      }
      const typed = value.length;
      const missing = Math.max(0, CAR_FULL_LEN - typed);
      if (typed < 8) {
        setCarStatus(`Digite ou cole o CAR completo (${CAR_FULL_LEN} caracteres).`, '');
      } else {
        setCarStatus(
          `CAR incompleto: ${typed} de ${CAR_FULL_LEN} caracteres${missing ? ` (faltam ${missing})` : ''}.`,
          '',
        );
      }
      delete input.dataset.index;
      // Não limpa dataset.car aqui se o valor ainda é prefixo do CAR já aplicado.
      if (input.dataset.car && !compactCar(input.dataset.car).startsWith(compact) && !compact.startsWith(compactCar(input.dataset.car))) {
        delete input.dataset.car;
      }
    }

    input.addEventListener('input', () => {
      if (applying) return;
      clearTimeout(timer);
      const extracted = extractCar(input.value);
      const completeNow = isCompleteCar(extracted)
        || compactCar(extracted).length >= CAR_COMPACT_LEN;
      // Ao atingir o tamanho de um CAR, filtra na hora.
      if (completeNow) {
        timer = setTimeout(() => evaluateCarInput({ forceLookup: true }), 60);
        return;
      }
      // Se parar de digitar, mostra validação da quantidade.
      timer = setTimeout(() => evaluateCarInput({ forceLookup: false }), 700);
    });

    input.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const pasted = ev.clipboardData?.getData('text') || '';
      const extracted = extractCar(pasted) || String(pasted || '').trim();
      applying = true;
      input.value = extracted;
      applying = false;
      clearTimeout(timer);
      timer = setTimeout(() => evaluateCarInput({ forceLookup: true }), 40);
    });

    input.addEventListener('blur', () => {
      clearTimeout(timer);
      evaluateCarInput({ forceLookup: isCompleteCar(extractCar(input.value)) });
    });

    munIn?.addEventListener('input', () => {
      if (input.dataset.index || input.dataset.car) {
        input.value = '';
        delete input.dataset.index;
        delete input.dataset.car;
        setCarStatus('');
        if (isCarSource(geometry?.source) || propertyRef) {
          geometry = null;
          propertyRef = null;
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
