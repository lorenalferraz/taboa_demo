/**
 * PRODES de desmatamento anual (INPE / TerraBrasilis), bioma Mata Atlântica.
 * A tela pede a imagem ao vivo no WMS, só de 2020 em diante, recortada no
 * contorno dos municípios. O clique consulta o polígono naquele ponto.
 * Contorno vermelho, no mesmo tom do seletor da camada.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { PRODES_STYLE } from './constants.js';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { getMunicipioFeatures, loadIbgeMunicipios } from './ibgeMunicipios.js';
import { applyLayerOrder, paneName } from './layerOrder.js';

const WMS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/ows';
const WFS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/prodes-mata-atlantica-nb/wfs';
const LAYER = 'prodes-mata-atlantica-nb:yearly_deforestation';
const MIN_YEAR = 2020;
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
let attributionOn = false;

// Simplificar antes de unir: a união dos contornos completos (~56 mil vértices)
// trava a página por uns 4 s na abertura.
function unionFeatures(features) {
  const list = features
    .filter((f) => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    .map((f) => turf.simplify(turf.feature(f.geometry), { tolerance: 0.0008, highQuality: false }));
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  try {
    const all = turf.union(turf.featureCollection(list));
    if (all?.geometry) return all;
  } catch (_) {}
  let acc = list[0];
  for (let i = 1; i < list.length; i += 1) {
    try {
      const next = turf.union(turf.featureCollection([acc, list[i]]));
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
  const view = map.getBounds().pad(0.08);
  const lim = coverage.bounds;
  const south = Math.max(view.getSouth(), lim.getSouth());
  const north = Math.min(view.getNorth(), lim.getNorth());
  const west = Math.max(view.getWest(), lim.getWest());
  const east = Math.min(view.getEast(), lim.getEast());
  if (!(south < north && west < east)) return null;
  return L.latLngBounds([south, west], [north, east]);
}

function sldBody() {
  const fill = PRODES_STYLE.fillColor || '#ef4444';
  const opacity = PRODES_STYLE.fillOpacity ?? 0.12;
  const stroke = PRODES_STYLE.color || '#ef4444';
  const weight = PRODES_STYLE.weight ?? 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld">
  <NamedLayer>
    <Name>${LAYER}</Name>
    <UserStyle>
      <FeatureTypeStyle>
        <Rule>
          <PolygonSymbolizer>
            <Fill>
              <CssParameter name="fill">${fill}</CssParameter>
              <CssParameter name="fill-opacity">${opacity}</CssParameter>
            </Fill>
            <Stroke>
              <CssParameter name="stroke">${stroke}</CssParameter>
              <CssParameter name="stroke-width">${weight}</CssParameter>
            </Stroke>
          </PolygonSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>`;
}

function wmsUrl(bounds, width, height) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: LAYER,
    format: 'image/png',
    transparent: 'true',
    srs: 'EPSG:4326',
    width: String(width),
    height: String(height),
    bbox: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
    CQL_FILTER: `year >= ${MIN_YEAR}`,
    // Sem TIME o INPE corta a imagem no fim de 2024 e esconde os anos novos.
    TIME: `${MIN_YEAR}-01-01/2100-01-01`,
    sld_body: sldBody(),
  });
  return `${WMS_URL}?${params}`;
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

function pixelSize(map, bounds) {
  const nw = map.latLngToContainerPoint(bounds.getNorthWest());
  const se = map.latLngToContainerPoint(bounds.getSouthEast());
  let width = Math.abs(se.x - nw.x);
  let height = Math.abs(se.y - nw.y);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width *= dpr;
  height *= dpr;
  const scale = Math.min(1, 1280 / Math.max(width, height, 1));
  return {
    width: Math.max(64, Math.round(width * scale)),
    height: Math.max(64, Math.round(height * scale)),
  };
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
    interactive: true,
    attribution: 'PRODES &copy; INPE / TerraBrasilis',
  });
  overlay.on('click', (ev) => {
    if (ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
    openAt(map, ev.latlng).catch(() => {});
  });
  return overlay;
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
  const { width, height } = pixelSize(map, bounds);
  overlay.setBounds(bounds);
  clipPathEl.setAttribute('d', clipD(coverage.feature.geometry, bounds));
  const el = overlay.getElement();
  if (el) el.style.pointerEvents = 'auto';
  const ok = await loadImage(wmsUrl(bounds, width, height), seq);
  if (!ok || seq !== reqSeq) return false;
  loadedKey = key;
  overlay.setOpacity(1);
  if (!attributionOn && map.attributionControl) {
    map.attributionControl.addAttribution('PRODES &copy; INPE / TerraBrasilis');
    attributionOn = true;
  }
  return true;
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

function clickRadius() {
  const el = overlay?.getElement();
  const bounds = overlay?.getBounds?.();
  if (!el || !bounds) return 0.003;
  const rect = el.getBoundingClientRect();
  const dLng = Math.abs(bounds.getEast() - bounds.getWest()) / Math.max(rect.width, 1);
  const dLat = Math.abs(bounds.getNorth() - bounds.getSouth()) / Math.max(rect.height, 1);
  return Math.max(0.003, Math.min(0.04, Math.max(dLng, dLat) * 2));
}

function pickHit(features, pt, radius) {
  let nearest = null;
  let nearestD = Infinity;
  for (const feat of features) {
    const year = Number(feat?.properties?.year);
    if (!Number.isFinite(year) || year < MIN_YEAR || !feat?.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, feat)) return feat;
    } catch (_) {}
    const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
    for (const poly of polys || []) {
      for (const coord of poly?.[0] || []) {
        const d = Math.hypot(coord[0] - pt[0], coord[1] - pt[1]);
        if (d < nearestD) {
          nearestD = d;
          nearest = feat;
        }
      }
    }
  }
  return nearest && nearestD <= radius ? nearest : null;
}

async function openAt(map, latlng) {
  if (!latlng || !coverage?.feature) return;
  const pt = [latlng.lng, latlng.lat];
  try {
    if (!turf.booleanPointInPolygon(pt, coverage.feature)) return;
  } catch (_) {
    return;
  }
  const d = clickRadius();
  const cql = `year >= ${MIN_YEAR} AND BBOX(geom,${latlng.lng - d},${latlng.lat - d},${latlng.lng + d},${latlng.lat + d},'EPSG:4674')`;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeName: LAYER,
    outputFormat: 'application/json',
    srsName: 'EPSG:4674',
    CQL_FILTER: cql,
    count: '40',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let data;
  try {
    const resp = await fetch(`${WFS_URL}?${params}`, { signal: ctrl.signal });
    if (!resp.ok) return;
    data = await resp.json();
  } catch (_) {
    return;
  } finally {
    clearTimeout(timer);
  }
  const hit = pickHit(data?.features || [], pt, d);
  if (!hit) return;
  L.popup({ maxWidth: 360, autoPan: false })
    .setLatLng(latlng)
    .setContent(popupHtml(hit.properties || {}))
    .openOn(map);
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
  const el = overlay.getElement();
  if (el) el.style.pointerEvents = 'auto';
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
