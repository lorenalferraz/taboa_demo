/**
 * Detecta o CRS de um KML/XML e converte coordenadas para WGS84 (EPSG:4326).
 */
import proj4 from 'proj4';
import { registerProj4Defs } from '../proj4Defs.js';
import { FAIXA_BBOX } from './faixaShapeNormalize.js';

const DEGREE_CRS = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979', 'EPSG:4269', 'EPSG:4618', 'EPSG:4225']);
const IDENTITY_CRS = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979']);
const BRAZIL_BBOX = [-74.0, -33.85, -28.5, 5.3];
const BAHIA_BBOX = [-46.7, -18.4, -37.15, -8.4];

const CRS_LABELS = {
  'EPSG:4326': 'WGS84',
  'EPSG:4674': 'SIRGAS 2000',
  'EPSG:4618': 'SAD69',
  'EPSG:4225': 'Córrego Alegre',
  'EPSG:3857': 'Web Mercator',
  'EPSG:900913': 'Web Mercator',
  'EPSG:5880': 'SIRGAS 2000 / Policônica',
  'EPSG:29101': 'SAD69 / Policônica',
};

let defsReady = false;

export function ensureKmlProj4() {
  if (defsReady) return;
  registerProj4Defs(proj4);
  defsReady = true;
}

export function crsDisplayName(code) {
  if (!code) return '';
  if (CRS_LABELS[code]) return CRS_LABELS[code];
  const m = String(code).match(/^EPSG:(\d+)$/i);
  if (!m) return code;
  const n = Number(m[1]);
  const zoneSirgas = n >= 31978 && n <= 31985 ? n - 31960 : 0;
  const zoneWgsS = n >= 32718 && n <= 32725 ? n - 32700 : 0;
  const zoneSadA = n >= 29168 && n <= 29175 ? n - 29150 : 0;
  const zoneSadB = n >= 29188 && n <= 29195 ? n - 29170 : 0;
  const z = zoneSirgas || zoneWgsS || zoneSadA || zoneSadB;
  if (z) {
    const datum = zoneSadA || zoneSadB ? 'SAD69' : zoneWgsS ? 'WGS84' : 'SIRGAS 2000';
    return `${datum} / UTM ${z}S`;
  }
  return code;
}

function inBbox(lng, lat, b) {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

export function looksGeographic(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90;
}

export function looksUtmMeters(x, y) {
  return x >= 100000 && x <= 900000 && y >= 6500000 && y <= 10000000;
}

export function looksPolyconic(x, y) {
  return x >= 3000000 && x <= 8500000 && y >= 6000000 && y <= 12000000;
}

export function looksWebMercator(x, y) {
  return Math.abs(x) > 200000 && Math.abs(x) < 20037508.34
    && Math.abs(y) < 20037508.34
    && !looksUtmMeters(x, y);
}

function parseEpsgToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/CRS84|OGC:CRS84/i.test(s)) return 'EPSG:4326';
  const urn = s.match(/urn:ogc:def:crs:EPSG::(\d{4,5})/i);
  if (urn) return `EPSG:${urn[1]}`;
  const epsg = s.match(/EPSG[:\s_-]*(\d{4,5})/i);
  if (epsg) return `EPSG:${epsg[1]}`;
  if (/^\d{4,5}$/.test(s)) return `EPSG:${s}`;
  return null;
}

function utmCodeFromZone(zone, { south = true, sad69 = false, wgs84 = false } = {}) {
  const z = Number(zone);
  if (!Number.isInteger(z) || z < 18 || z > 25) return null;
  if (!south) return `EPSG:${32600 + z}`;
  if (sad69) return `EPSG:${29150 + z}`;
  if (wgs84) return `EPSG:${32700 + z}`;
  return `EPSG:${31960 + z}`;
}

export function detectCrsFromKmlText(text, doc = null) {
  const t = String(text || '');
  if (doc?.querySelectorAll) {
    const els = doc.querySelectorAll('[srsName], [crs], [srsname]');
    for (const el of els) {
      const code = parseEpsgToken(el.getAttribute('srsName') || el.getAttribute('srsname') || el.getAttribute('crs'));
      if (code) return code;
    }
  }

  const urn = t.match(/urn:ogc:def:crs:EPSG::(\d{4,5})/i);
  if (urn) return `EPSG:${urn[1]}`;

  const srsAttr = t.match(/srsName\s*=\s*["']([^"']+)["']/i);
  if (srsAttr) {
    const code = parseEpsgToken(srsAttr[1]);
    if (code) return code;
  }

  const epsg = t.match(/EPSG\s*[:_\-\s]\s*(\d{4,5})/i);
  if (epsg) return `EPSG:${epsg[1]}`;

  if (/3857|900913|web\s*mercator|pseudo[-\s]?mercator/i.test(t)) return 'EPSG:3857';
  if (/5880|polic[oó]nica|polyconic/i.test(t)) return 'EPSG:5880';

  const sad69 = /sad\s*-?\s*69/i.test(t);
  const wgs84 = /wgs\s*-?\s*84/i.test(t);
  const utm = t.match(
    /(?:UTM|fuso|zona|zone)\s*(?:zone|fuso|zona)?\s*(\d{1,2})\s*([SNsn]|sul|norte|south|north)?/i,
  );
  if (utm) {
    const south = !utm[2] || /s|sul|south/i.test(utm[2]);
    const code = utmCodeFromZone(utm[1], { south, sad69, wgs84: wgs84 && !sad69 });
    if (code) return code;
  }

  if (sad69) return 'EPSG:4618';
  if (/sirgas(?:\s*2000)?/i.test(t)) return 'EPSG:4674';
  if (wgs84) return 'EPSG:4326';
  return null;
}

export function transformXy(x, y, fromCrs) {
  ensureKmlProj4();
  if (!fromCrs || IDENTITY_CRS.has(fromCrs)) return [x, y];
  try {
    const p = proj4(fromCrs, 'EPSG:4326', [x, y]);
    const lng = Array.isArray(p) ? p[0] : p.x;
    const lat = Array.isArray(p) ? p[1] : p.y;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  } catch (_) {
    return null;
  }
}

function scoreWgs84(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return -1;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return -1;
  let s = 0;
  if (inBbox(lng, lat, FAIXA_BBOX)) s += 100;
  if (inBbox(lng, lat, BAHIA_BBOX)) s += 40;
  if (inBbox(lng, lat, BRAZIL_BBOX)) s += 20;
  if (lng >= -82 && lng <= -34 && lat >= -56 && lat <= 13) s += 10;
  return s;
}

function samplePairs(pairs, limit = 6) {
  if (!pairs?.length) return [];
  if (pairs.length <= limit) return pairs;
  const step = Math.max(1, Math.floor(pairs.length / limit));
  const out = [];
  for (let i = 0; i < pairs.length && out.length < limit; i += step) out.push(pairs[i]);
  return out;
}

function scoreCrs(pairs, crs) {
  const samples = samplePairs(pairs);
  if (!samples.length) return -1;
  let total = 0;
  let n = 0;
  for (const [x, y] of samples) {
    const wgs = crs && !IDENTITY_CRS.has(crs) ? transformXy(x, y, crs) : [x, y];
    if (!wgs) return -1;
    const sc = scoreWgs84(wgs[0], wgs[1]);
    if (sc < 0) return -1;
    total += sc;
    n += 1;
  }
  return n ? total / n : -1;
}

function candidatesForSample(x, y) {
  if (looksGeographic(x, y)) return ['EPSG:4326', 'EPSG:4674'];
  if (looksUtmMeters(x, y)) {
    return [
      'EPSG:31984', 'EPSG:31983', 'EPSG:31985',
      'EPSG:32724', 'EPSG:32723',
      'EPSG:29174', 'EPSG:29173', 'EPSG:29194', 'EPSG:29193',
    ];
  }
  if (looksPolyconic(x, y)) return ['EPSG:5880', 'EPSG:29101'];
  if (looksWebMercator(x, y)) return ['EPSG:3857'];
  return [
    'EPSG:31984', 'EPSG:31983', 'EPSG:32724', 'EPSG:3857', 'EPSG:5880',
  ];
}

export function inferCrsFromPairs(pairs) {
  const first = pairs?.find((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
  if (!first) return null;
  let best = null;
  let bestScore = 15;
  for (const crs of candidatesForSample(first[0], first[1])) {
    const sc = scoreCrs(pairs, crs);
    if (sc > bestScore) {
      bestScore = sc;
      best = crs;
    }
  }
  return best;
}

export function maybeSwapLonLat(lng, lat) {
  if (scoreWgs84(lng, lat) >= 20) return [lng, lat];
  if (scoreWgs84(lat, lng) > scoreWgs84(lng, lat)) return [lat, lng];
  return [lng, lat];
}

/**
 * Converte pares [x, y] para [lng, lat] WGS84.
 * @returns {{ ok: true, pairs: number[][], crsFrom: string } | { ok: false, error: string }}
 */
export function pairsToWgs84(pairs, declaredCrs) {
  ensureKmlProj4();
  const clean = (pairs || []).filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
  if (!clean.length) return { ok: false, error: 'Nenhuma coordenada numérica no KML.' };

  const [x0, y0] = clean[0];
  let crs = declaredCrs || null;

  if (crs && DEGREE_CRS.has(crs) && !looksGeographic(x0, y0)) crs = null;
  if (crs && !DEGREE_CRS.has(crs) && looksGeographic(x0, y0)) crs = 'EPSG:4326';
  if (!crs) crs = inferCrsFromPairs(clean) || (looksGeographic(x0, y0) ? 'EPSG:4326' : null);
  if (!crs) {
    return { ok: false, error: 'Não foi possível identificar o sistema de coordenadas do KML.' };
  }

  const out = [];
  for (const [x, y] of clean) {
    const wgs = IDENTITY_CRS.has(crs) ? [x, y] : transformXy(x, y, crs);
    if (!wgs) {
      return { ok: false, error: `Falha ao converter ${crsDisplayName(crs)} para WGS84.` };
    }
    out.push(maybeSwapLonLat(wgs[0], wgs[1]));
  }

  const [lng, lat] = out[0];
  if (scoreWgs84(lng, lat) < 0) {
    return { ok: false, error: 'As coordenadas do KML ficaram inválidas após a conversão.' };
  }

  return { ok: true, pairs: out, crsFrom: crs };
}
