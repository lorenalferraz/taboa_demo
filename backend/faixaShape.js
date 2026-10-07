/**
 * Shape oficial dos municípios (backend/shape/municipios.geojson), reprojetado para WGS84.
 */
const fs = require('fs');
const path = require('path');
const proj4pkg = require('proj4');
const proj4 = typeof proj4pkg === 'function' ? proj4pkg : (proj4pkg && proj4pkg.default) || proj4pkg;
const { normalizeFaixaShapeGeoJSON } = require('./municipiosNormalize');

const MUNICIPIOS_FILE = 'municipios.geojson';

(function registerProj4Defs() {
  const utmS = (z) => `+proj=utm +zone=${z} +south +ellps=GRS80 +units=m +no_defs`;
  const utmN = (z) => `+proj=utm +zone=${z} +ellps=GRS80 +units=m +no_defs`;
  const S = { 31978: 18, 31979: 19, 31980: 20, 31981: 21, 31982: 22, 31983: 23, 31984: 24 };
  const W84S = { 32718: 18, 32719: 19, 32720: 20, 32721: 21, 32722: 22, 32723: 23, 32724: 24 };
  const W84N = { 32618: 18, 32619: 19, 32620: 20, 32621: 21, 32622: 22, 32623: 23, 32624: 24 };
  Object.entries(S).forEach(([c, z]) => { try { proj4.defs('EPSG:' + c, utmS(z)); } catch (_) {} });
  Object.entries(W84S).forEach(([c, z]) => { try { proj4.defs('EPSG:' + c, utmS(z)); } catch (_) {} });
  Object.entries(W84N).forEach(([c, z]) => { try { proj4.defs('EPSG:' + c, utmN(z)); } catch (_) {} });
})();

function parseCrsFromGeoJSON(g) {
  const c = g?.crs?.properties?.name || g?.crs?.name || '';
  if (/CRS84/i.test(c)) return 'EPSG:4326';
  const m = c.match(/EPSG[:\s]*(\d+)/i) || c.match(/(\d{4,5})/);
  return m ? 'EPSG:' + m[1] : null;
}

function sampleFirstCoordinate(g) {
  const coords = g?.features?.[0]?.geometry?.coordinates;
  if (!coords) return null;
  function dig(c) {
    if (Array.isArray(c) && typeof c[0] === 'number') return c;
    if (Array.isArray(c) && c.length) return dig(c[0]);
    return null;
  }
  return dig(coords);
}

function inferCrsFromCoordinates(g) {
  const s = sampleFirstCoordinate(g);
  if (!s) return null;
  const [x, y] = s;
  if (x >= -180 && x <= 180 && y >= -90 && y <= 90) return 'EPSG:4326';
  if (x >= 100000 && x <= 1000000 && y >= 7000000 && y <= 9500000)
    return 'EPSG:' + (31978 + (y > 8500000 ? 6 : y > 8000000 ? 5 : y > 7500000 ? 4 : 3));
  return null;
}

function utmZoneFromEpsg(code) {
  const n = Number(String(code || '').replace(/\D/g, ''));
  const south = { 31978: 18, 31979: 19, 31980: 20, 31981: 21, 31982: 22, 31983: 23, 31984: 24, 32718: 18, 32719: 19, 32720: 20, 32721: 21, 32722: 22, 32723: 23, 32724: 24 };
  const north = { 32618: 18, 32619: 19, 32620: 20, 32621: 21, 32622: 22, 32623: 23, 32624: 24 };
  if (south[n]) return { zone: south[n], south: true };
  if (north[n]) return { zone: north[n], south: false };
  return { zone: 24, south: true };
}

/** UTM → WGS84 sem proj4. A Vercel às vezes não aplica o proj4 empacotado. */
function utmToLonLat(easting, northing, zone, south) {
  const a = 6378137.0;
  const f = 1 / 298.257222101;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  let y = northing;
  if (south) y -= 10000000;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * Math.pow(e2, 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const fp = mu
    + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
    + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
    + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(fp) * Math.cos(fp);
  const T1 = Math.tan(fp) * Math.tan(fp);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(fp) * Math.sin(fp));
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(fp) * Math.sin(fp), 1.5);
  const D = x / (N1 * k0);
  const lat = fp - (N1 * Math.tan(fp) / R1) * (
    D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720
  );
  const lon = lon0 + (
    D
    - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120
  ) / Math.cos(fp);
  return [lon * 180 / Math.PI, lat * 180 / Math.PI];
}

function reprojectToWGS84(geojson, sourceCrs) {
  if (!geojson?.features) return geojson;
  const fromCrs = sourceCrs || parseCrsFromGeoJSON(geojson) || 'EPSG:31984';
  const geoGraphic = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979']);
  if (geoGraphic.has(fromCrs)) return geojson;
  const zone = utmZoneFromEpsg(fromCrs);
  function asLonLat(x, y) {
    let out = null;
    try {
      if (typeof proj4 === 'function') {
        const p = proj4(fromCrs, 'EPSG:4326', [x, y]);
        out = Array.isArray(p) ? p : [p.x, p.y];
      }
    } catch (_) {
      out = null;
    }
    if (!out || Math.abs(out[0]) > 180 || Math.abs(out[1]) > 90) {
      out = utmToLonLat(x, y, zone.zone, zone.south);
    }
    return out;
  }
  function transformCoord(c) {
    if (Array.isArray(c) && typeof c[0] === 'number') return asLonLat(c[0], c[1]);
    return c.map(transformCoord);
  }
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => {
      const fc = JSON.parse(JSON.stringify(f));
      if (fc.geometry?.coordinates) fc.geometry.coordinates = transformCoord(fc.geometry.coordinates);
      return fc;
    })
  };
}

function prepareShapeFC(raw) {
  if (!raw) return null;
  let fg = JSON.parse(JSON.stringify(raw));
  if (fg.type === 'Feature') fg = { type: 'FeatureCollection', features: [fg] };
  else if (fg.type === 'Polygon' || fg.type === 'MultiPolygon')
    fg = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: fg, properties: {} }] };
  if (!fg.features || fg.features.length === 0) return null;
  const sourceCrs = parseCrsFromGeoJSON(fg) || inferCrsFromCoordinates(fg);
  const geoGraphic = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979']);
  const needsReproject = sourceCrs && !geoGraphic.has(sourceCrs);
  if (needsReproject) fg = reprojectToWGS84(fg, sourceCrs);
  const normalized = normalizeFaixaShapeGeoJSON(fg);
  if (normalized?.features?.length) return normalized;
  const sample = sampleFirstCoordinate(fg);
  const inDegrees = sample && Math.abs(sample[0]) <= 180 && Math.abs(sample[1]) <= 90;
  if (inDegrees && fg?.features?.length) return fg;
  const err = new Error(`faixa-v3 sem feições (origem ${raw?.features?.length || 0}, amostra ${JSON.stringify(sample)})`);
  throw err;
}

async function loadFaixaShapeFromDir() {
  const filePath = path.join(__dirname, 'shape', MUNICIPIOS_FILE);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const fc = prepareShapeFC(raw);
  if (!fc?.features?.length) return null;
  return {
    faixaName: MUNICIPIOS_FILE,
    geojson: fc,
    source: 'local',
  };
}

exports.loadFaixaShapeFromDir = loadFaixaShapeFromDir;
