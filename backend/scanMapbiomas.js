'use strict';

const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');
const proj4 = require('proj4');

const MAPBIOMAS_ALERT_COLLECTION_GQL = `
  alertCode
  areaHa
  detectedAt
  publishedAt
  crossedBiomes
  sources
  deforestationClasses
  geometryWkt
  coordenates { latitude longitude }
  alertGeometry { simplifiedPoints { xCoord yCoord } }
`;

const MAPBIOMAS_URL = 'https://plataforma.alerta.mapbiomas.org/api/v2/graphql';
const MAPBIOMAS_GRAPHQL_TIMEOUT_MS = 180000;
const MAPBIOMAS_MAX_RETRIES = 5;
const MAPBIOMAS_RETRY_BASE_MS = 2000;
const MAPBIOMAS_PAGE_LIMIT_FAIXA = 800;

const { resolveRegiaoByNome, resolveRegiaoByIbge } = require('./municipios');
const { normalizeFaixaShapeGeoJSON } = require('./municipiosNormalize');
const { buildMunFeatureIndex, filterAlertsInMunIndex } = require('./municipiosGeomFilter');
const { getScanFromFileCache, putScanInFileCache } = require('./scanCacheFile');
const {
  isScanCachePayloadValid,
  scanPipelineCacheSuffix,
  enrichScanPayload,
  compactScanPayload,
} = require('./scanPipeline');
const {
  loadGeoJsonFile,
  MUNICIPIOS_FILE,
} = require('./localShapeLoader');

const SCAN_ROOT = path.join(__dirname);
const MUN_SCAN_CONCURRENCY = 2;

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

function resolveRegiaoPlanejamento(nomMun, ibgeId) {
  const byIbge = ibgeId != null ? resolveRegiaoByIbge(ibgeId) : '';
  if (byIbge) return byIbge;
  return resolveRegiaoByNome(nomMun);
}

function tagFeaturesRegiaoTaboa(geojson) {
  for (const f of geojson.features || []) {
    if (!f.properties) f.properties = {};
    const ibge = f.properties.codMun ?? f.properties.cd_mun ?? f.properties.codigo ?? f.properties.codarea;
    const nm = f.properties.nomMun || f.properties.nm_mun || f.properties.NM_MUN || f.properties.municipio || '';
    f.properties._regiaoTaboa = f.properties._regiaoTaboa || resolveRegiaoPlanejamento(nm, ibge);
  }
}

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

function reprojectToWGS84(geojson, sourceCrs) {
  if (!geojson?.features) return geojson;
  const fromCrs = sourceCrs || parseCrsFromGeoJSON(geojson) || 'EPSG:31984';
  const geoGraphic = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979']);
  if (geoGraphic.has(fromCrs)) return geojson;
  function transformCoord(c) {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      try {
        const p = proj4(fromCrs, 'EPSG:4326', [c[0], c[1]]);
        return Array.isArray(p) ? p : [p.x, p.y];
      } catch (_) { return c; }
    }
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
  fg = normalizeFaixaShapeGeoJSON(fg);
  if (!fg?.features?.length) return null;
  return fg;
}

function wktToGeoJSON(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim();
  if (!s) return null;
  try {
    const u = s.toUpperCase();
    if (u.startsWith('POLYGON')) {
      const m = s.match(/POLYGON\s*\(\(\s*([\d\s.,\-eE+]+)\s*\)\)/i);
      if (!m) return null;
      const ring = m[1].trim().split(',').map((ps) => {
        const p = ps.trim().split(/\s+/).map(Number);
        return [p[0], p[1]];
      }).filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
      if (ring.length < 3) return null;
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
        ring.push([ring[0][0], ring[0][1]]);
      return { type: 'Polygon', coordinates: [ring] };
    }
    if (u.startsWith('MULTIPOLYGON')) {
      const acc = [];
      let rest = s.replace(/^MULTIPOLYGON\s*\(\s*/i, '');
      while (rest.length) {
        const open = rest.indexOf('((');
        if (open < 0) break;
        let depth = 0;
        let end = -1;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '(') depth++;
          else if (rest[i] === ')') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end < 0) break;
        const chunk = rest.slice(open + 1, end);
        const m2 = chunk.match(/\(\s*([\d\s.,\-eE+]+)\s*\)/);
        if (m2) {
          const ring = m2[1].trim().split(',').map((ps) => {
            const p = ps.trim().split(/\s+/).map(Number);
            return [p[0], p[1]];
          }).filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
          if (ring.length >= 3) {
            if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
              ring.push([ring[0][0], ring[0][1]]);
            acc.push([ring]);
          }
        }
        rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
      }
      if (acc.length === 0) return null;
      return { type: 'MultiPolygon', coordinates: acc };
    }
  } catch (_) {}
  return null;
}

function simplifiedPointsToPolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const ring = points.map((p) => {
    const x = p?.xCoord != null ? Number(p.xCoord) : NaN;
    const y = p?.yCoord != null ? Number(p.yCoord) : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return [x, y];
  }).filter(Boolean);
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { type: 'Polygon', coordinates: [ring] };
}

function geomCenter(geojson) {
  if (!geojson || !geojson.coordinates) return null;
  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  const visit = (c) => {
    if (typeof c[0] === 'number') { lonSum += c[0]; latSum += c[1]; n++; }
    else c.forEach(visit);
  };
  visit(geojson.coordinates);
  return n ? [latSum / n, lonSum / n] : null;
}

function alertGeometryAndPoint(alert) {
  let geojson = alert.geometryGeojson || null;
  if (!geojson && alert.geometryWkt) geojson = wktToGeoJSON(alert.geometryWkt);
  if (!geojson && alert.alertGeometry?.simplifiedPoints?.length)
    geojson = simplifiedPointsToPolygon(alert.alertGeometry.simplifiedPoints);
  let lat = alert.coordenates?.latitude;
  let lng = alert.coordenates?.longitude;
  if ((lat == null || lng == null) && geojson) {
    const c = geomCenter(geojson);
    if (c) { lat = c[0]; lng = c[1]; }
  }
  return { geojson, point: (lat != null && lng != null) ? [lat, lng] : null };
}

function alertRoughBbox(alert) {
  const { geojson, point } = alertGeometryAndPoint(alert);
  try {
    if (geojson) return turf.bbox(geojson);
    if (point) return [point[1], point[0], point[1], point[0]];
  } catch (_) {}
  return null;
}

/**
 * Retorna a primeira coordenada de um anel (exterior) da geometria.
 * Usado no fallback de vértices para evitar re-parse completo.
 */
function firstRing(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates?.[0] ?? null;
  if (geom.type === 'MultiPolygon') return geom.coordinates?.[0]?.[0] ?? null;
  return null;
}

/**
 * Amostra até `maxSamples` vértices de um anel e verifica se algum está dentro de `poly`.
 * Fallback robusto para geometrias com winding order errado ou levemente inválidas.
 */
function sampleVerticesInsidePoly(ring, poly, maxSamples) {
  if (!ring || ring.length < 2) return false;
  const step = Math.max(1, Math.floor(ring.length / (maxSamples || 8)));
  for (let i = 0; i < ring.length; i += step) {
    try {
      if (turf.booleanPointInPolygon(turf.point(ring[i]), poly)) return true;
    } catch (_) {}
  }
  return false;
}

/** Bbox da faixa inteira para descartar alertas sem interseção antes do loop por município. */
function alertHitsFaixaPlanningArea(alert, faixaFC, faixaUnionBbox) {
  const feats = faixaFC?.features || [];
  if (!feats.length) return true;
  const ab = alertRoughBbox(alert);
  if (ab && faixaUnionBbox) {
    if (ab[2] < faixaUnionBbox[0] || ab[0] > faixaUnionBbox[2] || ab[3] < faixaUnionBbox[1] || ab[1] > faixaUnionBbox[3])
      return false;
  }
  const { geojson, point } = alertGeometryAndPoint(alert);
  if (!geojson && !point) return false;

  let alertFeat = null;
  let pt = null;
  try { alertFeat = geojson ? turf.feature(geojson) : null; } catch (_) {}
  try { pt = point ? turf.point([point[1], point[0]]) : null; } catch (_) {}

  for (const f of feats) {
    if (!f.geometry) continue;
    try {
      const fb = turf.bbox(f.geometry);
      if (ab && (ab[2] < fb[0] || ab[0] > fb[2] || ab[3] < fb[1] || ab[1] > fb[3])) continue;
    } catch (_) {}

    let poly = null;
    try { poly = turf.feature(f.geometry); } catch (_) {}
    if (!poly) continue;

    if (alertFeat) {
      try { if (turf.booleanIntersects(alertFeat, poly) || turf.booleanWithin(alertFeat, poly)) return true; } catch (_) {}
      /** Vertex sampling — cobre alertas cuja geometria tem winding order inválido. */
      try {
        const ring = firstRing(geojson);
        if (ring && sampleVerticesInsidePoly(ring, poly)) return true;
        const fRing = firstRing(f.geometry);
        if (fRing && sampleVerticesInsidePoly(fRing, alertFeat)) return true;
      } catch (_) {}
    }
    if (pt) {
      try { if (turf.booleanPointInPolygon(pt, poly)) return true; } catch (_) {}
    }
  }
  return false;
}

function delayMapbiomas(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Erros de autenticação/credenciais — retentar não ajuda e confunde o usuário. */
function isMapbiomasNonRetryableError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return (
    m.includes('usuário ou senha incorretos') ||
    m.includes('usuario ou senha incorretos') ||
    m.includes('senha incorret') ||
    m.includes('invalid password') ||
    m.includes('invalid credentials') ||
    m.includes('token de acesso inválido') ||
    m.includes('unauthorized') ||
    m.includes('unauthenticated')
  );
}

async function graphql(query, variables, token, send) {
  const headers = { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) };
  let lastErr;
  for (let attempt = 0; attempt < MAPBIOMAS_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), MAPBIOMAS_GRAPHQL_TIMEOUT_MS);
    try {
      const res = await fetch(MAPBIOMAS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) {
        throw new Error(`MapBiomas: resposta não-JSON (HTTP ${res.status}).`);
      }
      if (!res.ok) {
        const msg = json?.errors?.[0]?.message || text.slice(0, 200);
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      if (json.errors) throw new Error(json.errors[0]?.message || 'Erro GraphQL');
      return json.data;
    } catch (e) {
      lastErr = e;
      if (isMapbiomasNonRetryableError(e)) throw e;
      if (attempt < MAPBIOMAS_MAX_RETRIES - 1) {
        const hint = String(e.message || e).slice(0, 100);
        if (send) send({ type: 'status', message: `MapBiomas instável · tentativa ${attempt + 2}/${MAPBIOMAS_MAX_RETRIES}… (${hint})`, warn: true });
        await delayMapbiomas(MAPBIOMAS_RETRY_BASE_MS * Math.pow(2, attempt));
      }
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr;
}

async function signIn(email, password, send) {
  const data = await graphql(
    `mutation signIn($email: String!, $password: String!) { signIn(email: $email, password: $password) { token } }`,
    { email, password },
    null,
    send
  );
  return data.signIn.token;
}

async function fetchAlertsPage(token, { page, limit, startDate, endDate, boundingBox, territoryIds, territoryCategory }, send) {
  const useTerritory = Array.isArray(territoryIds) && territoryIds.length > 0 && territoryCategory;
  const vars = {
    page,
    limit: Math.min(Number(limit) || 500, 2000),
    startDate: startDate || '2020-01-01',
    endDate: endDate || new Date().toISOString().slice(0, 10),
    dateType: 'DetectedAt',
    statusName: 'published',
    territoryIds: useTerritory ? territoryIds.map((id) => Number(id)).filter((n) => Number.isFinite(n)) : [],
    territoryCategory: useTerritory ? territoryCategory : null,
    boundingBox: !useTerritory && boundingBox && boundingBox.length === 4 ? boundingBox : []
  };
  const data = await graphql(
    `query alerts($page:Int,$limit:Int,$startDate:BaseDate,$endDate:BaseDate,$dateType:DateTypes,$statusName:String,$territoryIds:[Int!],$territoryCategory:String,$boundingBox:[Float!]){
      alerts(page:$page,limit:$limit,startDate:$startDate,endDate:$endDate,dateType:$dateType,statusName:$statusName,territoryIds:$territoryIds,territoryCategory:$territoryCategory,boundingBox:$boundingBox){
        collection{ ${MAPBIOMAS_ALERT_COLLECTION_GQL} }
        metadata{ totalCount }
      }
    }`,
    vars,
    token,
    send
  );
  return data.alerts;
}

async function fetchAllAlerts(token, opts, onProgress, send) {
  const limit = Math.min(Number(opts.limit) || 500, 2000);
  const all = [];
  let page = 1;
  let totalCount = null;
  const maxPages = 100;
  let lastPageError = null;
  let lastColLength = 0;
  while (page <= maxPages) {
    if (onProgress) onProgress({ page, totalCount, fetched: all.length, partial: !!lastPageError });
    try {
      const res = await fetchAlertsPage(token, { ...opts, page, limit }, send);
      const col = res.collection || [];
      lastColLength = col.length;
      all.push(...col);
      const meta = res.metadata || {};
      if (totalCount == null) totalCount = meta.totalCount ?? 0;
      if (col.length < limit || (totalCount > 0 && all.length >= totalCount)) break;
      page++;
    } catch (e) {
      lastPageError = e;
      break;
    }
  }
  const hitPageCap = page > maxPages;
  const incompleteByTotal = totalCount > 0 && all.length < totalCount;
  const mayHaveMorePages = lastColLength === limit && !lastPageError;
  const partial = !!lastPageError || incompleteByTotal || (hitPageCap && mayHaveMorePages);
  return {
    collection: all,
    metadata: {
      totalCount: totalCount ?? all.length,
      partial,
      lastError: lastPageError ? String(lastPageError.message || lastPageError) : null
    }
  };
}

function defaultStartDateMonthsAgo(months = 12) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** MapBiomas por território IBGE + filtro geométrico nos limites municipais do shape. */
async function fetchAlertsForMunicipio(token, opts, onProgress, send) {
  const { ibgeId, munBbox, munFeats, startDate, endDate } = opts;
  const base = { startDate, endDate, limit: MAPBIOMAS_PAGE_LIMIT_FAIXA };
  const munIndex = buildMunFeatureIndex(munFeats || []);
  const filterInMun = (col) => filterAlertsInMunIndex(col, munIndex, alertGeometryAndPoint);

  if (ibgeId) {
    const byTerritory = await fetchAllAlerts(token, {
      ...base,
      territoryIds: [Number(ibgeId)],
      territoryCategory: 'municipality',
      boundingBox: null,
    }, onProgress, send);
    const rawCol = byTerritory.collection || [];
    const filtered = filterInMun(rawCol);
    if (filtered.length > 0) {
      return { ...byTerritory, collection: filtered, filterMode: 'territory+mun_geom' };
    }
    /** API retornou dados mas nenhum cai no polígono — não refaz bbox (evita chamada dupla). */
    if (rawCol.length > 0) {
      return { ...byTerritory, collection: filtered, filterMode: 'territory+mun_geom_empty' };
    }
  }
  const byBbox = await fetchAllAlerts(token, {
    ...base,
    territoryIds: [],
    territoryCategory: null,
    boundingBox: munBbox,
  }, onProgress, send);
  const filtered = filterInMun(byBbox.collection);
  return { ...byBbox, collection: filtered, filterMode: 'bbox+mun_geom' };
}

function pickShapeFilename(filenames) {
  if (!filenames?.length) return null;
  const low = (s) => String(s).toLowerCase();
  const named = filenames.find((n) => low(n) === MUNICIPIOS_FILE.toLowerCase());
  if (named) return named;
  if (filenames.length === 1) return filenames[0];
  return null;
}

function groupFaixaFeaturesByMunicipio(features) {
  const { normMunNome } = require('./municipios');
  const byKey = new Map();
  for (const feat of features || []) {
    const ibge = feat.properties?.codMun ?? feat.properties?.cd_mun ?? feat.properties?.codigo;
    const nm = feat.properties?.nomMun ?? feat.properties?.nm_mun ?? feat.properties?.NM_MUN ?? '';
    const key = ibge ? String(ibge) : normMunNome(nm);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        ibgeId: ibge != null && ibge !== '' ? Number(ibge) : null,
        munNome: feat.properties?.nomMun || feat.properties?.nm_mun || String(nm).trim() || `Município ${key}`,
        regiaoTaboa: feat.properties?._regiaoTaboa || '',
        feats: [],
      });
    }
    byKey.get(key).feats.push(feat);
  }
  const out = [];
  for (const g of byKey.values()) {
    try {
      g.munBbox = turf.bbox(turf.featureCollection(g.feats));
    } catch (_) {
      continue;
    }
    out.push(g);
  }
  out.sort((a, b) => a.munNome.localeCompare(b.munNome, 'pt-BR'));
  return out;
}

function listGeojsonFiles(shapeDir) {
  const files = [];
  if (!fs.existsSync(shapeDir)) return files;
  for (const f of fs.readdirSync(shapeDir)) {
    if (f.toLowerCase().endsWith('.geojson')) files.push(f);
  }
  return files;
}

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadFaixaShapeFromDir(_shapeDir) {
  return loadFaixaShapeFromSource();
}

async function loadFaixaShapeFromSource() {
  const raw = await loadGeoJsonFile(MUNICIPIOS_FILE);
  const fc = prepareShapeFC(raw);
  if (!fc?.features?.length) return null;
  return {
    faixaName: MUNICIPIOS_FILE,
    geojson: fc,
    source: 'local',
  };
}

/** Cache em memória: chave = startDate|endDate|sha256(email). TTL = 30 min. */
const SCAN_CACHE_TTL_MS = 30 * 60 * 1000;
const scanCache = new Map();

function scanCacheKey(startDate, endDate, email) {
  const s = String(startDate || '').trim();
  const e = String(endDate || '').trim();
  const u = String(email || '').trim().toLowerCase();
  return `${s}|${e}|${u}|${scanPipelineCacheSuffix()}`;
}

function acceptCachedPayload(payload) {
  if (!isScanCachePayloadValid(payload)) return null;
  return payload;
}

/**
 * Busca resultado em cache: memória → arquivo.
 * Retorna null se não encontrado (ou forceRefresh=true).
 */
async function getScanFromCache(startDate, endDate, email, forceRefresh) {
  if (forceRefresh) return null;
  const key = scanCacheKey(startDate, endDate, email);

  const row = scanCache.get(key);
  if (row) {
    if (Date.now() <= row.expiresAt) {
      const hit = acceptCachedPayload(row.payload);
      if (hit) return hit;
    }
    scanCache.delete(key);
  }

  const fromFile = getScanFromFileCache(SCAN_ROOT, key, false);
  if (fromFile) {
    const hit = acceptCachedPayload(fromFile);
    if (hit) {
      scanCache.set(key, { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, payload: hit });
      return hit;
    }
  }

  return null;
}

async function putScanInCache(startDate, endDate, email, payload) {
  const key = scanCacheKey(startDate, endDate, email);
  const compact = compactScanPayload(payload);

  scanCache.set(key, { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, payload: compact });
  putScanInFileCache(SCAN_ROOT, key, compact);
}

/** Limpa entradas expiradas periodicamente para não acumular memória. */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of scanCache.entries()) {
    if (now > v.expiresAt) scanCache.delete(k);
  }
}, 5 * 60 * 1000);

/**
 * @param {object} body - email, password, startDate, endDate, selectedIndices?: number[]
 * @param {(ev: object) => void} send - emite eventos SSE (serializáveis JSON)
 */
async function runScan(shapeDir, body, send) {
  const email = String(body.email || '').trim();
  const password = body.password;
  const startDate = body.startDate || '2020-01-01';
  const endDate = body.endDate || new Date().toISOString().slice(0, 10);
  const forceRefresh = !!body.forceRefresh;

  if (!email || !password) {
    send({ type: 'error', message: 'Email e palavra-passe são obrigatórios.' });
    return;
  }

  const cached = await getScanFromCache(startDate, endDate, email, forceRefresh);
  if (cached) {
    const mb = cached.mapbiomasCount ?? cached.alerts?.length ?? 0;
    send({
      type: 'status',
      message: `Resultado em cache (${mb} alerta(s) MapBiomas). Clique em Atualizar para forçar nova varredura.`,
      warn: false,
    });
    send({ type: 'result', payload: cached });
    return;
  }

  send({ type: 'status', message: 'A carregar faixa (Supabase)…' });

  let faixaLoaded;
  try {
    faixaLoaded = await loadFaixaShapeFromSource();
  } catch (loadErr) {
    send({ type: 'error', message: `Erro ao carregar faixa: ${String(loadErr.message || loadErr)}` });
    return;
  }
  if (!faixaLoaded?.geojson?.features?.length) {
    send({ type: 'error', message: `GeoJSON da faixa (${MUNICIPIOS_FILE}) não encontrado em backend/shape/.` });
    return;
  }

  const faixaName = faixaLoaded.faixaName;
  let faixaFC = faixaLoaded.geojson;
  const allFeatures = [];
  const resultSelectedIndices = [];

  send({ type: 'status', message: `Servidor: a autenticar no MapBiomas e a varrer ${groupFaixaFeaturesByMunicipio(faixaFC.features).length} municípios (até ${MUN_SCAN_CONCURRENCY} em paralelo)…` });

  const token = await signIn(email, password, send);

  const alertsByPolygon = {};
  let currentAlertsNaFaixaPlanejamento = [];
  let faixaBboxAggregateCount = null;
  let faixaGeometryContainedCount = null;

  tagFeaturesRegiaoTaboa(faixaFC);
  const municipios = groupFaixaFeaturesByMunicipio(faixaFC.features);
  const nMunicipios = municipios.length;

  const seenFaixa = new Set();
  const alertByCode = new Map();

  function mergeMunicipioAlerts(result, regiaoTaboa, munNome) {
    for (const a of result.collection || []) {
      if (!a._regiaoTaboa) a._regiaoTaboa = regiaoTaboa;
      if (!Array.isArray(a._munNomesInFaixa)) a._munNomesInFaixa = [];
      if (!a._munNomesInFaixa.includes(munNome)) a._munNomesInFaixa.push(munNome);

      if (seenFaixa.has(a.alertCode)) {
        const existing = alertByCode.get(a.alertCode);
        if (existing) {
          if (!Array.isArray(existing._munNomesInFaixa)) existing._munNomesInFaixa = [];
          if (!existing._munNomesInFaixa.includes(munNome)) existing._munNomesInFaixa.push(munNome);
          if (!existing._regiaoTaboa && regiaoTaboa) existing._regiaoTaboa = regiaoTaboa;
          if (regiaoTaboa && existing._regiaoTaboa && existing._regiaoTaboa !== regiaoTaboa && existing._regiaoTaboa !== 'divisa') {
            existing._regiaoTaboa = 'divisa';
          }
        }
        continue;
      }
      seenFaixa.add(a.alertCode);
      alertByCode.set(a.alertCode, a);
      currentAlertsNaFaixaPlanejamento.push(a);
    }
  }

  // ── MapBiomas por município (worker pool) ─────────────────────────────────────
  let nextMunIdx = 0;
  let successMun = 0;
  async function scanMunicipioWorker() {
    while (nextMunIdx < nMunicipios) {
      const munIdx = nextMunIdx++;
      const { ibgeId, munNome, regiaoTaboa, munBbox, feats: munFeats } = municipios[munIdx];

      // Progresso por página não vai à pill (workers paralelos causavam contador a “voltar”).
      const onMunProgress = () => {};

      try {
        const mbResult = await fetchAlertsForMunicipio(token, {
          startDate,
          endDate,
          ibgeId,
          munBbox,
          munFeats,
        }, onMunProgress, send);
        mergeMunicipioAlerts(mbResult, regiaoTaboa, munNome);
        successMun += 1;
        send({
          type: 'progress',
          phase: 'municipio_ok',
          completed: successMun,
          nMunicipios,
          munNome,
          message: `MapBiomas ${successMun}/${nMunicipios}: ${munNome}`,
        });
      } catch (munErr) {
        send({
          type: 'status',
          message: `Aviso: falha em ${munNome} — ${String(munErr.message || munErr).slice(0, 120)}`,
          warn: true,
        });
      }
    }
  }

  const workers = Math.min(MUN_SCAN_CONCURRENCY, nMunicipios);
  await Promise.all(Array.from({ length: workers }, () => scanMunicipioWorker()));

  const mapbiomasCount = currentAlertsNaFaixaPlanejamento.length;

  faixaBboxAggregateCount = currentAlertsNaFaixaPlanejamento.length;
  /** Alertas já passaram filtro municipal — re-filtrar ×62 polígonos é redundante e lento. */
  faixaGeometryContainedCount = currentAlertsNaFaixaPlanejamento.length;

  send({
    type: 'status',
    message: `${mapbiomasCount} alerta(s) MapBiomas na faixa 05/06/07.`,
  });

  const resultPayload = enrichScanPayload({
    alerts: currentAlertsNaFaixaPlanejamento,
    alertsByPolygon: {},
    useFaixaSweep: true,
    faixaBboxAggregateCount,
    faixaGeometryContainedCount,
    faixaFilename: faixaName,
    faixaSource: 'shape_oficial',
    selectedIndices: resultSelectedIndices,
    mapbiomasCount,
  });
  putScanInCache(startDate, endDate, email, resultPayload)
    .catch((e) => console.warn('[runScan] Erro ao salvar cache:', e.message));
  send({ type: 'result', payload: resultPayload });
}

module.exports = { runScan, loadFaixaShapeFromDir };
