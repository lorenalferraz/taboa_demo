/**
 * PRODES Brasil (INPE / TerraBrasilis).
 * Cada vez que o mapa para, o navegador pede a imagem ao vivo no WMS.
 * Nada do PRODES fica gravado no sistema. O desenho só aparece dentro
 * dos municípios da faixa: a imagem do INPE entra num SVG e o recorte
 * é o contorno desses municípios.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { getMunicipioFeatures, loadIbgeMunicipios } from './ibgeMunicipios.js';
import { applyLayerOrder, paneName } from './layerOrder.js';

const WMS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/ows';
const WMS_LAYER = 'prodes-brasil-nb:prodes_brasil';
const WMS_STYLE = 'prodes-brasil-nb:prodes_brasil_pt-br';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

let overlay = null;
let svgImage = null;
let clipPathEl = null;
let coverage = null;
let loading = null;
let moveHandler = null;
let reqSeq = 0;
let loadedKey = '';

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
  return turf.simplify(acc, { tolerance: 0.003, highQuality: false });
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

function clipD(geom, bounds) {
  const west = bounds.getWest();
  const south = bounds.getSouth();
  const east = bounds.getEast();
  const north = bounds.getNorth();
  const dx = east - west || 1;
  const dy = north - south || 1;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const parts = [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (!ring?.length) continue;
      const cmds = ring.map(([lng, lat], i) => {
        const x = (lng - west) / dx;
        const y = (north - lat) / dy;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(4)} ${y.toFixed(4)}`;
      });
      cmds.push('Z');
      parts.push(cmds.join(' '));
    }
  }
  return parts.join(' ');
}

function ensureOverlay(map) {
  if (overlay) return overlay;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const clip = document.createElementNS(SVG_NS, 'clipPath');
  clip.setAttribute('id', 'taboa-prodes-clip');
  clip.setAttribute('clipPathUnits', 'objectBoundingBox');
  clipPathEl = document.createElementNS(SVG_NS, 'path');
  clipPathEl.setAttribute('clip-rule', 'evenodd');
  clip.appendChild(clipPathEl);
  defs.appendChild(clip);
  svgImage = document.createElementNS(SVG_NS, 'image');
  svgImage.setAttribute('x', '0');
  svgImage.setAttribute('y', '0');
  svgImage.setAttribute('width', '1');
  svgImage.setAttribute('height', '1');
  svgImage.setAttribute('preserveAspectRatio', 'none');
  svgImage.setAttribute('clip-path', 'url(#taboa-prodes-clip)');
  svg.appendChild(defs);
  svg.appendChild(svgImage);
  if (!map.getPane(paneName('prodes'))) map.createPane(paneName('prodes'));
  overlay = L.svgOverlay(svg, coverage.bounds, {
    pane: paneName('prodes'),
    opacity: 0,
    interactive: false,
    attribution: 'PRODES &copy; INPE / TerraBrasilis',
  });
  return overlay;
}

function viewSlice(map) {
  const view = map.getBounds().pad(0.35);
  const lim = coverage.bounds;
  const south = Math.max(view.getSouth(), lim.getSouth());
  const north = Math.min(view.getNorth(), lim.getNorth());
  const west = Math.max(view.getWest(), lim.getWest());
  const east = Math.min(view.getEast(), lim.getEast());
  if (!(south < north && west < east)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function pixelSize(map, bounds) {
  const nw = map.latLngToContainerPoint(bounds.getNorthWest());
  const se = map.latLngToContainerPoint(bounds.getSouthEast());
  let width = Math.abs(se.x - nw.x);
  let height = Math.abs(se.y - nw.y);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width *= dpr;
  height *= dpr;
  const scale = Math.min(1, 1024 / Math.max(width, height, 1));
  return {
    width: Math.max(64, Math.round(width * scale)),
    height: Math.max(64, Math.round(height * scale)),
  };
}

function wmsUrl(bounds, width, height) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: WMS_LAYER,
    styles: WMS_STYLE,
    format: 'image/png',
    transparent: 'true',
    srs: 'EPSG:4326',
    width: String(width),
    height: String(height),
    bbox: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
  });
  return `${WMS_URL}?${params}`;
}

function loadImage(url, seq) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('O INPE demorou para responder o PRODES.')), 28000);
    const finish = (err) => {
      clearTimeout(timer);
      svgImage.removeEventListener('load', onOk);
      svgImage.removeEventListener('error', onErr);
      if (seq !== reqSeq) resolve(false);
      else if (err) reject(err);
      else resolve(true);
    };
    const onOk = () => finish(null);
    const onErr = () => finish(new Error('Falha ao baixar o PRODES.'));
    svgImage.addEventListener('load', onOk);
    svgImage.addEventListener('error', onErr);
    svgImage.setAttribute('href', url);
    svgImage.setAttributeNS(XLINK_NS, 'href', url);
  });
}

async function refresh(map) {
  const seq = ++reqSeq;
  const bounds = viewSlice(map);
  if (!bounds) {
    overlay.setOpacity(0);
    return false;
  }
  const key = [
    map.getZoom(),
    bounds.getWest().toFixed(3),
    bounds.getSouth().toFixed(3),
    bounds.getEast().toFixed(3),
    bounds.getNorth().toFixed(3),
  ].join(',');
  if (key === loadedKey) return true;
  const { width, height } = pixelSize(map, bounds);
  overlay.setBounds(bounds);
  clipPathEl.setAttribute('d', clipD(coverage.feature.geometry, bounds));
  const ok = await loadImage(wmsUrl(bounds, width, height), seq);
  if (!ok || seq !== reqSeq) return false;
  loadedKey = key;
  overlay.setOpacity(1);
  return true;
}

function detach(map) {
  reqSeq += 1;
  loadedKey = '';
  if (moveHandler) {
    map.off('moveend', moveHandler);
    moveHandler = null;
  }
  if (overlay && map.hasLayer(overlay)) {
    try { map.removeLayer(overlay); } catch (_) {}
  }
  if (overlay) overlay.setOpacity(0);
}

export async function setProdesVisible(map, visible) {
  if (!map) return;
  if (!visible) {
    detach(map);
    return;
  }
  await ensureCoverage();
  ensureOverlay(map);
  applyLayerOrder(map);
  if (!map.hasLayer(overlay)) overlay.addTo(map);
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
