/**
 * PRODES de desmatamento anual (INPE / TerraBrasilis), bioma Mata Atlântica.
 * Os polígonos vêm ao vivo do WFS, em GeoJSON (EPSG:4674). Nada fica gravado
 * no sistema. Cada pedido cobre a tela atual, dentro da área dos municípios.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { getMunicipioFeatures, loadIbgeMunicipios } from './ibgeMunicipios.js';
import { applyLayerOrder, paneName, rendererFor } from './layerOrder.js';

const WFS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/prodes-mata-atlantica-nb/wfs';
const TYPE_NAME = 'prodes-mata-atlantica-nb:yearly_deforestation';
const MAX_FEATURES = 2500;

let group = null;
let coverage = null;
let loading = null;
let moveHandler = null;
let reqSeq = 0;
let loadedKey = '';
let attributionOn = false;

function unionFeatures(features) {
  const list = features.filter((f) => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
  if (!list.length) return null;
  let acc = turf.feature(list[0].geometry);
  for (let i = 1; i < list.length; i += 1) {
    try {
      const next = turf.union(turf.featureCollection([acc, turf.feature(list[i].geometry)]));
      if (next?.geometry) acc = next;
    } catch (_) {}
  }
  if (!acc?.geometry) return null;
  return turf.simplify(acc, { tolerance: 0.001, highQuality: false });
}

async function municipioFeatures() {
  let feats = getMunicipioFeatures();
  if (!feats.length) {
    await loadIbgeMunicipios().catch(() => {});
    feats = getMunicipioFeatures();
  }
  if (feats.length) return feats;
  let resp;
  try {
    resp = await fetchFaixaGeoJson();
  } catch (_) {
    throw new Error('Não foi possível ler a área dos municípios.');
  }
  return resp?.geojson?.features || [];
}

async function ensureCoverage() {
  if (coverage) return coverage;
  if (!loading) {
    loading = (async () => {
      const feats = await municipioFeatures();
      const geom = unionFeatures(feats);
      if (!geom?.geometry) throw new Error('Não foi possível ler a área dos municípios.');
      const [minLng, minLat, maxLng, maxLat] = turf.bbox(geom);
      coverage = {
        feature: geom,
        bounds: L.latLngBounds([minLat, minLng], [maxLat, maxLng]),
      };
      return coverage;
    })();
  }
  try {
    return await loading;
  } catch (err) {
    loading = null;
    throw err;
  }
}

function viewSlice(map) {
  const view = map.getBounds().pad(0.15);
  const lim = coverage.bounds;
  const south = Math.max(view.getSouth(), lim.getSouth());
  const north = Math.min(view.getNorth(), lim.getNorth());
  const west = Math.max(view.getWest(), lim.getWest());
  const east = Math.min(view.getEast(), lim.getEast());
  if (!(south < north && west < east)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function featureUrl(bounds, count) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'application/json',
    srsName: 'EPSG:4674',
    bbox: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()},EPSG:4674`,
  });
  if (count) params.set('count', String(count));
  return `${WFS_URL}?${params}`;
}

async function fetchGeoJson(url, seq) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error('Falha ao baixar o PRODES.');
    const data = await resp.json();
    if (seq !== reqSeq) return null;
    if (data?.exceptions || data?.type === 'ExceptionReport') {
      throw new Error('Falha ao baixar o PRODES.');
    }
    return data;
  } catch (err) {
    if (seq !== reqSeq) return null;
    if (err?.name === 'AbortError') throw new Error('O INPE demorou para responder o PRODES.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function yearColor(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return '#f59e0b';
  const t = Math.min(1, Math.max(0, (y - 2004) / 21));
  const r = Math.round(253 - t * 55);
  const g = Math.round(214 - t * 130);
  const b = Math.round(48 - t * 20);
  return `rgb(${r},${g},${b})`;
}

function esc(value) {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function areaHa(props) {
  const km = Number(props?.area_km);
  if (!Number.isFinite(km)) return '—';
  return `${(km * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

function popupHtml(props) {
  const year = props?.year ?? '—';
  const rows = [
    ['Ano', year],
    ['Área', areaHa(props)],
    ['Classe', props?.main_class || 'Desmatamento'],
    ['Imagem', props?.image_date || '—'],
    ['Estado', props?.state || '—'],
    ['Satélite', [props?.satellite, props?.sensor].filter(Boolean).join(' ') || '—'],
    ['Fonte', 'PRODES / INPE'],
  ];
  const body = rows
    .map(([label, value]) => `<div class="popup-row">${esc(label)}: ${esc(value)}</div>`)
    .join('');
  return `<div class="popup-title">Desmatamento ${esc(year)}</div>${body}`;
}

function enableClick(lyr) {
  if (lyr._path) lyr._path.style.pointerEvents = 'auto';
  if (typeof lyr.eachLayer === 'function') {
    lyr.eachLayer((child) => enableClick(child));
  }
}

function showNote(text) {
  const el = document.getElementById('status');
  if (!el) return;
  el.hidden = false;
  el.className = 'status-pill';
  el.textContent = text;
}

function hideNote() {
  const el = document.getElementById('status');
  if (!el) return;
  if (String(el.textContent || '').startsWith('Aproxime o mapa')) el.hidden = true;
}

function insideFaixa(feat) {
  if (!feat?.geometry) return false;
  try {
    return turf.booleanIntersects(feat, coverage.feature);
  } catch (_) {
    return false;
  }
}

function ensureGroup(map) {
  if (!group) {
    if (!map.getPane(paneName('prodes'))) map.createPane(paneName('prodes'));
    group = L.geoJSON({ type: 'FeatureCollection', features: [] }, {
      pane: paneName('prodes'),
      renderer: rendererFor(map, 'prodes'),
      interactive: true,
      style(feat) {
        const color = yearColor(feat?.properties?.year);
        return { color, weight: 1.15, opacity: 0.95, fillColor: color, fillOpacity: 0.55 };
      },
      onEachFeature(feat, lyr) {
        lyr.bindPopup(popupHtml(feat?.properties || {}), { maxWidth: 360, autoPan: false });
        lyr.on('add', () => enableClick(lyr));
      },
    });
  }
  if (!attributionOn && map.attributionControl) {
    map.attributionControl.addAttribution('PRODES &copy; INPE / TerraBrasilis');
    attributionOn = true;
  }
  return group;
}

function drawFeatures(features) {
  group.clearLayers();
  if (features.length) group.addData({ type: 'FeatureCollection', features });
  group.eachLayer((lyr) => enableClick(lyr));
}

async function refresh(map) {
  const seq = ++reqSeq;
  const bounds = viewSlice(map);
  if (!bounds) {
    if (group) group.clearLayers();
    hideNote();
    return true;
  }
  const key = [
    map.getZoom(),
    bounds.getWest().toFixed(3),
    bounds.getSouth().toFixed(3),
    bounds.getEast().toFixed(3),
    bounds.getNorth().toFixed(3),
  ].join(',');
  if (key === loadedKey) return true;

  const probe = await fetchGeoJson(featureUrl(bounds, 1), seq);
  if (!probe || seq !== reqSeq) return false;
  const matched = Number(probe.numberMatched ?? probe.totalFeatures ?? probe.features?.length ?? 0);
  if (matched > MAX_FEATURES) {
    group.clearLayers();
    loadedKey = key;
    showNote(`Aproxime o mapa para ver os polígonos do PRODES (${matched.toLocaleString('pt-BR')} nesta área).`);
    return true;
  }

  const data = matched <= 1 ? probe : await fetchGeoJson(featureUrl(bounds), seq);
  if (!data || seq !== reqSeq) return false;
  const features = (data.features || []).filter(insideFaixa);
  drawFeatures(features);
  loadedKey = key;
  hideNote();
  return true;
}

function detach(map) {
  reqSeq += 1;
  loadedKey = '';
  hideNote();
  if (moveHandler) {
    map.off('moveend', moveHandler);
    moveHandler = null;
  }
  if (group && map.hasLayer(group)) {
    try { map.removeLayer(group); } catch (_) {}
  }
  if (group) group.clearLayers();
}

export async function setProdesVisible(map, visible) {
  if (!map) return;
  if (!visible) {
    detach(map);
    return;
  }
  await ensureCoverage();
  ensureGroup(map);
  applyLayerOrder(map);
  if (!map.hasLayer(group)) group.addTo(map);
  if (!moveHandler) {
    moveHandler = () => {
      refresh(map).catch(() => {});
    };
    map.on('moveend', moveHandler);
  }
  const before = reqSeq;
  try {
    const shown = await refresh(map);
    applyLayerOrder(map);
    if (!shown && !loadedKey && reqSeq === before + 1) {
      detach(map);
      throw new Error('Falha ao baixar o PRODES.');
    }
  } catch (err) {
    if (!loadedKey) detach(map);
    throw err;
  }
}
