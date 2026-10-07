/**
 * PRODES de desmatamento anual (INPE / TerraBrasilis), bioma Mata Atlântica.
 * Os polígonos vêm ao vivo do WFS, em GeoJSON (EPSG:4674). Entram só os
 * desmates de 2020 em diante, recortados no contorno dos municípios.
 * A cor é a mesma dos alertas do MapBiomas.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { ALERT_STYLE } from './constants.js';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { getMunicipioFeatures, loadIbgeMunicipios } from './ibgeMunicipios.js';
import { applyLayerOrder, paneName } from './layerOrder.js';

const WFS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/prodes-mata-atlantica-nb/wfs';
const TYPE_NAME = 'prodes-mata-atlantica-nb:yearly_deforestation';
const PAGE = 8000;
const MIN_YEAR = 2020;

let group = null;
let canvas = null;
let coverage = null;
let loading = null;
let moveHandler = null;
let reqSeq = 0;
let loadedBounds = null;
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
  return acc?.geometry ? acc : null;
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
  const view = map.getBounds().pad(0.05);
  const lim = coverage.bounds;
  const south = Math.max(view.getSouth(), lim.getSouth());
  const north = Math.min(view.getNorth(), lim.getNorth());
  const west = Math.max(view.getWest(), lim.getWest());
  const east = Math.min(view.getEast(), lim.getEast());
  if (!(south < north && west < east)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function covers(bounds) {
  if (!loadedBounds) return false;
  return loadedBounds.contains(bounds.getNorthWest()) && loadedBounds.contains(bounds.getSouthEast());
}

function featureUrl(bounds, count, startIndex) {
  const cql = `year >= ${MIN_YEAR} AND BBOX(geom,${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()},'EPSG:4674')`;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: TYPE_NAME,
    outputFormat: 'application/json',
    srsName: 'EPSG:4674',
    CQL_FILTER: cql,
    count: String(count),
    startIndex: String(startIndex),
  });
  return `${WFS_URL}?${params}`;
}

function clipToMunicipios(feat) {
  const year = Number(feat?.properties?.year);
  if (!Number.isFinite(year) || year < MIN_YEAR || !feat?.geometry) return null;
  let hit;
  try {
    hit = turf.intersect(turf.featureCollection([feat, coverage.feature]));
  } catch (_) {
    return null;
  }
  if (!hit?.geometry) return null;
  hit.properties = feat.properties;
  return hit;
}

async function fetchGeoJson(url, seq) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
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
  if (String(el.textContent || '').startsWith('Carregando os polígonos do PRODES')) el.hidden = true;
}

function ensureGroup(map) {
  if (!group) {
    if (!map.getPane(paneName('prodes'))) map.createPane(paneName('prodes'));
    canvas = L.canvas({ pane: paneName('prodes'), padding: 0.5 });
    group = L.geoJSON({ type: 'FeatureCollection', features: [] }, {
      pane: paneName('prodes'),
      renderer: canvas,
      interactive: true,
      style: () => ({ ...ALERT_STYLE }),
      onEachFeature(feat, lyr) {
        lyr.bindPopup(popupHtml(feat?.properties || {}), { maxWidth: 360, autoPan: false });
      },
    });
  }
  if (!attributionOn && map.attributionControl) {
    map.attributionControl.addAttribution('PRODES &copy; INPE / TerraBrasilis');
    attributionOn = true;
  }
  return group;
}

function enableCanvasClick() {
  const el = canvas?._container;
  if (el) el.style.pointerEvents = 'auto';
}

async function loadBounds(bounds, seq) {
  group.clearLayers();
  const first = await fetchGeoJson(featureUrl(bounds, PAGE, 0), seq);
  if (!first || seq !== reqSeq) return false;
  const matched = Number(first.numberMatched ?? first.totalFeatures ?? first.features?.length ?? 0);
  const pages = Math.max(1, Math.ceil(matched / PAGE));
  let drawn = 0;

  const addPage = async (data) => {
    const features = (data?.features || []).map(clipToMunicipios).filter(Boolean);
    if (seq !== reqSeq) return;
    if (features.length) group.addData({ type: 'FeatureCollection', features });
    drawn += features.length;
    showNote(`Carregando os polígonos do PRODES… ${drawn.toLocaleString('pt-BR')}`);
    enableCanvasClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await addPage(first);
  let next = 1;
  async function worker() {
    while (next < pages) {
      const page = next;
      next += 1;
      if (seq !== reqSeq) return;
      const data = await fetchGeoJson(featureUrl(bounds, PAGE, page * PAGE), seq);
      if (!data || seq !== reqSeq) return;
      await addPage(data);
    }
  }
  const workers = Math.min(3, Math.max(0, pages - 1));
  if (workers) await Promise.all(Array.from({ length: workers }, () => worker()));
  if (seq !== reqSeq) return false;
  loadedBounds = bounds;
  hideNote();
  enableCanvasClick();
  return true;
}

async function refresh(map) {
  const seq = ++reqSeq;
  const bounds = viewSlice(map);
  if (!bounds) {
    if (group) group.clearLayers();
    loadedBounds = null;
    hideNote();
    return true;
  }
  if (covers(bounds) && group.getLayers().length) return true;
  showNote('Carregando os polígonos do PRODES…');
  return loadBounds(bounds, seq);
}

function detach(map) {
  reqSeq += 1;
  loadedBounds = null;
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
    enableCanvasClick();
    if (!shown && !loadedBounds && reqSeq === before + 1) {
      detach(map);
      throw new Error('Falha ao baixar o PRODES.');
    }
  } catch (err) {
    if (!loadedBounds) detach(map);
    throw err;
  }
}
