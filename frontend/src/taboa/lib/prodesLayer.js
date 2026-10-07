/**
 * PRODES Brasil (INPE / TerraBrasilis).
 * A base original cobre o país. Cada pedaço é recortado no navegador
 * para aparecer só dentro dos municípios da faixa.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { getMunicipioFeatures, loadIbgeMunicipios } from './ibgeMunicipios.js';
import { applyLayerOrder, paneName } from './layerOrder.js';

const WMS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/ows';
const WMS_LAYER = 'prodes-brasil-nb:prodes_brasil';
const WMS_STYLE = 'prodes-brasil-nb:prodes_brasil_pt-br';
const ORIGIN = 20037508.342789244;

let layer = null;
let coverage = null;
let loading = null;

function to3857(lng, lat) {
  const x = (lng * ORIGIN) / 180;
  const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) * ORIGIN) / Math.PI;
  return [x, y];
}

function tileBox(coords, size) {
  const span = (ORIGIN * 2) / (2 ** coords.z);
  const minX = -ORIGIN + coords.x * span;
  const maxX = minX + span;
  const maxY = ORIGIN - coords.y * span;
  const minY = maxY - span;
  return { minX, minY, maxX, maxY, size };
}

function project(lng, lat, box) {
  const [x, y] = to3857(lng, lat);
  const px = ((x - box.minX) / (box.maxX - box.minX)) * box.size;
  const py = ((box.maxY - y) / (box.maxY - box.minY)) * box.size;
  return [px, py];
}

function traceGeometry(ctx, geom, box) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  ctx.beginPath();
  for (const poly of polys) {
    for (const ring of poly) {
      ring.forEach(([lng, lat], i) => {
        const [px, py] = project(lng, lat, box);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
    }
  }
}

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
  return turf.simplify(acc, { tolerance: 0.002, highQuality: false });
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

function wmsUrl(box) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: WMS_LAYER,
    styles: WMS_STYLE,
    format: 'image/png',
    transparent: 'true',
    srs: 'EPSG:3857',
    width: String(box.size),
    height: String(box.size),
    bbox: `${box.minX},${box.minY},${box.maxX},${box.maxY}`,
  });
  return `${WMS_URL}?${params}`;
}

function buildLayer(cov) {
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize().x;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const box = tileBox(coords, size);
      const img = new Image();
      img.onload = () => {
        try {
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = '#fff';
          traceGeometry(ctx, cov.feature.geometry, box);
          ctx.fill('evenodd');
        } catch (_) {}
        done(null, canvas);
      };
      img.onerror = () => done(new Error('Falha ao baixar o PRODES'), canvas);
      img.src = wmsUrl(box);
      return canvas;
    },
  });
  return new Layer({
    tileSize: 256,
    opacity: 1,
    updateWhenIdle: true,
    keepBuffer: 1,
    bounds: cov.bounds,
    pane: paneName('prodes'),
    attribution: 'PRODES &copy; INPE / TerraBrasilis',
  });
}

export async function setProdesVisible(map, visible) {
  if (!map) return;
  if (!visible) {
    if (layer) {
      try { map.removeLayer(layer); } catch (_) {}
    }
    return;
  }
  const cov = await ensureCoverage();
  applyLayerOrder(map);
  if (!map.getPane(paneName('prodes'))) map.createPane(paneName('prodes'));
  if (!layer) layer = buildLayer(cov);
  if (!map.hasLayer(layer)) layer.addTo(map);
  applyLayerOrder(map);
}
