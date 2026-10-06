'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const turf = require('@turf/turf');

const SHAPE_DIR = path.join(__dirname, 'shape');
const MUNICIPIOS_FILE = 'municipios.geojson';
const ASSENTAMENTOS_FILE = 'assentamentos.geojson';
const ALERTAS_FILE = 'alertas.geojson';
/** Acima disso o JSON.parse em string única estoura o limite do V8 (~512 MB). */
const STREAM_BYTES = 320 * 1024 * 1024;
const HEAVY_SHAPE_FILES = new Set(['app.geojson', 'reserva_legal.geojson', 'imoveis_rurais.geojson']);

/** @type {Map<string, object>} */
const _cache = new Map();
/** @type {Map<string, Promise<object>>} */
const _loadPromises = new Map();

function shapePath(filename) {
  return path.join(SHAPE_DIR, filename);
}

function shouldStreamFile(filename) {
  const fp = shapePath(filename);
  if (!fs.existsSync(fp)) return false;
  if (HEAVY_SHAPE_FILES.has(filename)) return true;
  return fs.statSync(fp).size >= STREAM_BYTES;
}

function bboxesOverlap(a, b) {
  if (!a || !b) return true;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function geomBbox(geom) {
  if (!geom?.coordinates) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (c) => {
    if (!c) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const x = c[0];
      const y = c[1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    for (let i = 0; i < c.length; i++) walk(c[i]);
  };
  try { walk(geom.coordinates); } catch (_) { return null; }
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function normalizeFeatureCollection(raw) {
  return raw.type === 'FeatureCollection'
    ? raw
    : { type: 'FeatureCollection', features: raw.features || [] };
}

function readLocalGeoJsonFileSync(filename) {
  const fp = shapePath(filename);
  if (!fs.existsSync(fp)) {
    throw new Error(`Arquivo shape não encontrado: ${filename}`);
  }
  return normalizeFeatureCollection(JSON.parse(fs.readFileSync(fp, 'utf8')));
}

/**
 * Percorre features de um GeoJSON grande sem montar o arquivo inteiro em uma string.
 * `onFeature` pode devolver `false` para interromper.
 */
function iterateGeoJsonFeatures(filename, onFeature) {
  const fp = shapePath(filename);
  if (!fs.existsSync(fp)) {
    return Promise.reject(new Error(`Arquivo shape não encontrado: ${filename}`));
  }
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fp, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
    let buf = '';
    let stage = 0;
    let depth = 0;
    let inString = false;
    let escape = false;
    let objStart = -1;
    let stopped = false;

    const finish = (err) => {
      if (stopped) return;
      stopped = true;
      stream.destroy();
      if (err) reject(err);
      else resolve();
    };

    const processBuf = () => {
      if (stage === 0) {
        const m = buf.match(/"features"\s*:\s*\[/);
        if (!m) {
          if (buf.length > 20000) buf = buf.slice(-2000);
          return;
        }
        buf = buf.slice(m.index + m[0].length);
        stage = 1;
      }

      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (inString) {
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') {
          if (depth === 0) objStart = i;
          depth += 1;
          continue;
        }
        if (ch !== '}') continue;
        depth -= 1;
        if (depth !== 0 || objStart < 0) continue;
        const raw = buf.slice(objStart, i + 1);
        let feat;
        try {
          feat = JSON.parse(raw);
        } catch (e) {
          finish(e);
          return;
        }
        buf = buf.slice(i + 1);
        objStart = -1;
        i = -1;
        try {
          if (onFeature(feat) === false) {
            finish();
            return;
          }
        } catch (e) {
          finish(e);
          return;
        }
      }

      if (depth > 0 && objStart >= 0) {
        buf = buf.slice(objStart);
        objStart = 0;
      } else if (depth === 0 && buf.length > 16) {
        buf = buf.slice(-16);
      }
    };

    stream.on('data', (chunk) => {
      if (stopped) return;
      buf += chunk;
      try {
        processBuf();
      } catch (e) {
        finish(e);
      }
    });
    stream.on('end', () => {
      if (!stopped) {
        stopped = true;
        resolve();
      }
    });
    stream.on('error', (err) => {
      if (stopped) return;
      stopped = true;
      reject(err);
    });
  });
}

/** @type {Map<string, { n: number, bboxes: Float64Array, offsets: BigUint64Array, ndjsonPath: string, fd: number|null }>} */
const _heavyIndex = new Map();

function heavyCacheDir(filename) {
  return path.join(SHAPE_DIR, '.cache', filename.replace(/\.geojson$/i, ''));
}

function heavyIndexFresh(filename) {
  const dir = heavyCacheDir(filename);
  const metaFp = path.join(dir, 'meta.json');
  const srcFp = shapePath(filename);
  if (!fs.existsSync(metaFp) || !fs.existsSync(srcFp)) return false;
  if (!fs.existsSync(path.join(dir, 'features.ndjson'))) return false;
  if (!fs.existsSync(path.join(dir, 'features.map.ndjson'))) return false;
  if (!fs.existsSync(path.join(dir, 'bboxes.f64'))) return false;
  if (!fs.existsSync(path.join(dir, 'offsets.u64'))) return false;
  if (!fs.existsSync(path.join(dir, 'offsets.map.u64'))) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(metaFp, 'utf8'));
    const st = fs.statSync(srcFp);
    return Number(meta.version) >= 2 && Number(meta.size) === st.size;
  } catch (_) {
    return false;
  }
}

function buildHeavyIndex(filename) {
  const script = path.join(__dirname, 'indexHeavyGeojson.py');
  const dir = heavyCacheDir(filename);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Indexando ${filename} (arquivo grande)…`);
  const r = spawnSync('python3', [script, shapePath(filename), dir], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || `falha ao indexar ${filename}`).trim());
  }
  if (r.stdout) console.log(String(r.stdout).trim());
}

function asFloat64(buf) {
  return new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
}

function asBigUint64(buf) {
  return new BigUint64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
}

function loadHeavyIndex(filename) {
  if (_heavyIndex.has(filename)) return _heavyIndex.get(filename);
  if (!heavyIndexFresh(filename)) buildHeavyIndex(filename);
  const dir = heavyCacheDir(filename);
  const bboxBuf = fs.readFileSync(path.join(dir, 'bboxes.f64'));
  const offBuf = fs.readFileSync(path.join(dir, 'offsets.u64'));
  const mapOffBuf = fs.readFileSync(path.join(dir, 'offsets.map.u64'));
  const idx = {
    n: Math.floor(offBuf.byteLength / 8),
    bboxes: asFloat64(bboxBuf),
    offsets: asBigUint64(offBuf),
    mapOffsets: asBigUint64(mapOffBuf),
    ndjsonPath: path.join(dir, 'features.ndjson'),
    mapNdjsonPath: path.join(dir, 'features.map.ndjson'),
    fd: null,
    mapFd: null,
  };
  _heavyIndex.set(filename, idx);
  return idx;
}

function readIndexedFeature(idx, i, forMap = false) {
  const ndjsonPath = forMap && idx.mapNdjsonPath ? idx.mapNdjsonPath : idx.ndjsonPath;
  const offsets = forMap && idx.mapOffsets ? idx.mapOffsets : idx.offsets;
  const fdKey = forMap ? 'mapFd' : 'fd';
  if (idx[fdKey] == null) idx[fdKey] = fs.openSync(ndjsonPath, 'r');
  const fd = idx[fdKey];
  const start = Number(offsets[i]);
  const end = i + 1 < idx.n ? Number(offsets[i + 1]) : fs.fstatSync(fd).size;
  const len = Math.max(0, end - start);
  if (!len) return null;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  const text = buf.toString('utf8').replace(/\n$/, '');
  return JSON.parse(text);
}

function queryHeavyIndex(filename, queryBbox, cap, opts = {}) {
  const idx = loadHeavyIndex(filename);
  const forMap = !!opts.map;
  const unlimited = !Number.isFinite(cap);
  const out = [];
  let total = 0;
  for (let i = 0; i < idx.n; i++) {
    const fb = [
      idx.bboxes[i * 4],
      idx.bboxes[i * 4 + 1],
      idx.bboxes[i * 4 + 2],
      idx.bboxes[i * 4 + 3],
    ];
    if (queryBbox && !bboxesOverlap(fb, queryBbox)) continue;
    total += 1;
    if (out.length < cap) {
      const f = readIndexedFeature(idx, i, forMap);
      if (f) out.push(f);
    } else if (!unlimited) {
      break;
    }
    if (!unlimited && out.length >= cap) break;
  }
  return {
    type: 'FeatureCollection',
    features: out,
    truncated: unlimited ? false : (total > out.length || out.length >= cap),
    total: Math.max(total, out.length),
  };
}

async function streamFeaturesByBbox(filename, queryBbox, cap) {
  const out = [];
  let total = 0;
  const unlimited = !Number.isFinite(cap);
  await iterateGeoJsonFeatures(filename, (f) => {
    if (!f?.geometry) return true;
    const fb = geomBbox(f.geometry);
    if (queryBbox && (!fb || !bboxesOverlap(fb, queryBbox))) return true;
    total += 1;
    if (out.length < cap) out.push(f);
    if (!unlimited && out.length >= cap) return false;
    return true;
  });
  return {
    type: 'FeatureCollection',
    features: out,
    truncated: unlimited ? false : (total > out.length || out.length >= cap),
    total: Math.max(total, out.length),
  };
}

async function loadGeoJsonFile(filename) {
  if (_cache.has(filename)) return _cache.get(filename);
  if (_loadPromises.has(filename)) return _loadPromises.get(filename);

  const promise = (async () => {
    if (shouldStreamFile(filename)) {
      throw new Error(`Arquivo grande demais para carga completa: ${filename}`);
    }
    const fc = readLocalGeoJsonFileSync(filename);
    _cache.set(filename, fc);
    return fc;
  })();

  _loadPromises.set(filename, promise);
  try {
    return await promise;
  } finally {
    _loadPromises.delete(filename);
  }
}

async function loadFaixaShapeGeoJson() {
  return loadGeoJsonFile(MUNICIPIOS_FILE);
}

async function loadAssentamentosFeatures() {
  return (await loadGeoJsonFile(ASSENTAMENTOS_FILE)).features || [];
}

function parseLatLng(lat, lng) {
  const la = Number(String(lat ?? '').replace(',', '.'));
  const lo = Number(String(lng ?? '').replace(',', '.'));
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    return { ok: false, error: 'Latitude e longitude inválidas.' };
  }
  if (la < -90 || la > 90 || lo < -180 || lo > 180) {
    return { ok: false, error: 'Coordenada fora dos limites WGS84.' };
  }
  return { ok: true, lat: la, lng: lo };
}

async function municipioPorCoordenadaForApi(lat, lng) {
  const parsed = parseLatLng(lat, lng);
  if (!parsed.ok) return parsed;
  const fc = await loadFaixaShapeGeoJson();
  let pt;
  try {
    pt = turf.point([parsed.lng, parsed.lat]);
  } catch (_) {
    return { ok: false, error: 'Coordenada inválida.' };
  }
  for (const f of fc.features || []) {
    if (!f?.geometry) continue;
    try {
      if (!turf.booleanPointInPolygon(pt, f)) continue;
    } catch (_) {
      continue;
    }
    const p = f.properties || {};
    const ibgeId = Number(p.codMun || p.cd_mun);
    const nome = String(p.nomMun || p.nm_mun || '').trim();
    return {
      ok: true,
      lat: parsed.lat,
      lng: parsed.lng,
      ibgeId: Number.isFinite(ibgeId) ? ibgeId : null,
      codarea: Number.isFinite(ibgeId) ? String(ibgeId) : null,
      nome,
      municipio: nome,
      uf: String(p.sigla_uf || 'BA').toUpperCase(),
      ufId: 29,
      fonte: 'municipios.geojson',
    };
  }
  return { ok: false, error: 'Coordenada fora da faixa TABOA.', lat: parsed.lat, lng: parsed.lng };
}

async function municipiosPorCoordenadasForApi(points) {
  if (!Array.isArray(points)) return { ok: false, error: 'points deve ser uma lista.' };
  const clipped = points.slice(0, 20);
  const results = await Promise.all(clipped.map(async (p, idx) => {
    const id = p?.id ?? idx;
    const out = await municipioPorCoordenadaForApi(
      p?.lat ?? p?.latitude,
      p?.lng ?? p?.lon ?? p?.longitude,
    );
    return { id, index: idx, ...out };
  }));
  return { ok: true, results };
}

function filterFeaturesByBbox(features, bbox) {
  if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return features || [];
  }
  const queryBbox = bbox.map(Number);
  const out = [];
  for (const f of features || []) {
    if (!f?.geometry) continue;
    let fb = f._bbox;
    if (!fb) {
      try { fb = turf.bbox(f.geometry); f._bbox = fb; } catch (_) {}
    }
    if (fb && !bboxesOverlap(fb, queryBbox)) continue;
    out.push(f);
  }
  return out;
}

function foldSearch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** @type {object[] | null} */
let _imoveisCatalog = null;
/** @type {Promise<object[]> | null} */
let _imoveisCatalogPromise = null;

function imoveisCatalogCachePath(idx) {
  return path.join(path.dirname(idx.ndjsonPath), 'imoveis.catalog.json');
}

function catalogCacheFresh(cachePath, idx) {
  if (!fs.existsSync(cachePath)) return false;
  try {
    const cacheM = fs.statSync(cachePath).mtimeMs;
    const srcM = Math.max(
      fs.existsSync(idx.mapNdjsonPath) ? fs.statSync(idx.mapNdjsonPath).mtimeMs : 0,
      fs.existsSync(idx.ndjsonPath) ? fs.statSync(idx.ndjsonPath).mtimeMs : 0,
    );
    return cacheM >= srcM;
  } catch (_) {
    return false;
  }
}

function buildImoveisCatalogFromNdjson(idx) {
  return new Promise((resolve, reject) => {
    const src = idx.mapNdjsonPath && fs.existsSync(idx.mapNdjsonPath)
      ? idx.mapNdjsonPath
      : idx.ndjsonPath;
    const items = [];
    const stream = fs.createReadStream(src, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let i = 0;
    rl.on('line', (line) => {
      const lineIndex = i++;
      if (!line) return;
      try {
        const f = JSON.parse(line);
        const p = f.properties || {};
        const car = String(p.NUMERO_CAR || '').trim();
        if (!car) return;
        const nome = String(p.DENOMINACA || '').trim().replace(/^["']+|["']+$/g, '');
        const mun = String(p.MUNICIPIO || '').trim();
        items.push({
          i: lineIndex,
          car,
          nome,
          mun,
          ide: p.IDE_IMOVEL != null ? String(p.IDE_IMOVEL).trim() : '',
          search: foldSearch(`${car} ${nome} ${mun}`),
          munFold: foldSearch(mun),
        });
      } catch (_) {}
    });
    rl.on('close', () => resolve(items));
    rl.on('error', reject);
  });
}

async function ensureImoveisCatalog() {
  if (_imoveisCatalog) return _imoveisCatalog;
  if (_imoveisCatalogPromise) return _imoveisCatalogPromise;
  _imoveisCatalogPromise = (async () => {
    const idx = loadHeavyIndex('imoveis_rurais.geojson');
    const cachePath = imoveisCatalogCachePath(idx);
    if (catalogCacheFresh(cachePath, idx)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (Array.isArray(parsed) && parsed.length) {
          _imoveisCatalog = parsed;
          return parsed;
        }
      } catch (_) {}
    }
    const items = await buildImoveisCatalogFromNdjson(idx);
    try {
      fs.writeFileSync(cachePath, JSON.stringify(items));
    } catch (_) {}
    _imoveisCatalog = items;
    return items;
  })();
  try {
    return await _imoveisCatalogPromise;
  } catch (err) {
    _imoveisCatalogPromise = null;
    throw err;
  }
}

async function searchImoveisRurais({ q = '', municipio = '', limit = 40 } = {}) {
  const items = await ensureImoveisCatalog();
  const query = foldSearch(q);
  const munFold = foldSearch(municipio);
  const cap = Math.min(80, Math.max(1, Number(limit) || 40));
  const out = [];
  for (const it of items) {
    if (munFold && it.munFold && !it.munFold.includes(munFold)) continue;
    if (query && !(it.search.includes(query) || foldSearch(it.car).includes(query))) continue;
    out.push({
      i: it.i,
      car: it.car,
      nome: it.nome,
      mun: it.mun,
      ide: it.ide,
      label: it.nome ? `${it.car} — ${it.nome}` : it.car,
    });
    if (out.length >= cap) break;
  }
  return { items: out, total: items.length };
}

function getImovelByIndex(i, opts = {}) {
  const idx = loadHeavyIndex('imoveis_rurais.geojson');
  const n = Number(i);
  if (!Number.isFinite(n) || n < 0 || n >= idx.n) return null;
  return readIndexedFeature(idx, n, !!opts.map);
}

async function loadFeaturesByBbox(filename, bbox, limit = 0, opts = {}) {
  const capRaw = Number(limit);
  const unlimited = !Number.isFinite(capRaw) || capRaw <= 0;
  const cap = unlimited ? Infinity : Math.max(1, capRaw);
  const queryBbox = (bbox && bbox.length === 4 && !bbox.some((n) => !Number.isFinite(n)))
    ? bbox.map(Number)
    : null;

  if (shouldStreamFile(filename)) {
    try {
      return queryHeavyIndex(filename, queryBbox, cap, opts);
    } catch (err) {
      console.warn(`índice ${filename}:`, err.message || err);
      return streamFeaturesByBbox(filename, queryBbox, cap);
    }
  }

  const fc = await loadGeoJsonFile(filename);
  const filtered = filterFeaturesByBbox(fc.features || [], queryBbox);
  return {
    type: 'FeatureCollection',
    features: unlimited ? filtered : filtered.slice(0, cap),
    truncated: unlimited ? false : filtered.length > cap,
    total: filtered.length,
  };
}

module.exports = {
  SHAPE_DIR,
  MUNICIPIOS_FILE,
  ASSENTAMENTOS_FILE,
  ALERTAS_FILE,
  loadGeoJsonFile,
  loadFaixaShapeGeoJson,
  loadAssentamentosFeatures,
  filterFeaturesByBbox,
  loadFeaturesByBbox,
  municipioPorCoordenadaForApi,
  municipiosPorCoordenadasForApi,
  ensureImoveisCatalog,
  searchImoveisRurais,
  getImovelByIndex,
};
