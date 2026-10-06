'use strict';

/**
 * Camada local de assentamentos — backend/shape/assentamentos.geojson.
 */
const {
  loadAssentamentosFeatures,
  filterFeaturesByBbox,
  ASSENTAMENTOS_FILE,
} = require('./localShapeLoader');

function normStr(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function filterIncraFeaturesByMunicipio(features, municipioNome) {
  const target = normStr(municipioNome);
  if (!target) return features;
  const keys = ['municipio', 'nm_municip', 'nm_municipio', 'nom_municip'];
  return features.filter((f) => {
    const p = f.properties || {};
    for (const k of keys) {
      const v = p[k];
      if (v != null && normStr(v) === target) return true;
      if (v != null && normStr(v).includes(target)) return true;
    }
    return false;
  });
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const LOCAL_INCRA_LAYERS = {
  assentamentos: { load: loadAssentamentosFeatures, file: ASSENTAMENTOS_FILE },
};

const KNOWN_LAYERS = new Set(Object.keys(LOCAL_INCRA_LAYERS));

/** @type {Map<string, { data: object, expiresAt: number }>} */
const _cache = new Map();

function cacheKey(layerBase, uf, bbox, municipioNome) {
  const bb = (bbox || []).map((n) => Number(n).toFixed(3)).join(',');
  const mun = municipioNome ? municipioNome.toLowerCase().trim() : '';
  return `incra:${layerBase}:${String(uf || '').toLowerCase()}:${bb}:${mun}`;
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchIncraLayerByBbox(layerBase, uf, bbox, opts = {}) {
  if (!KNOWN_LAYERS.has(layerBase)) {
    return { ok: false, error: `Camada desconhecida: ${layerBase}` };
  }
  if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: 'bbox inválido (west,south,east,north)' };
  }

  const cfg = LOCAL_INCRA_LAYERS[layerBase];
  const municipioNome = String(opts.municipioNome || '').trim();
  const key = cacheKey(layerBase, uf, bbox, municipioNome);
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    let features = filterFeaturesByBbox(await cfg.load(), bbox);
    const totalRaw = features.length;
    if (municipioNome) {
      features = filterIncraFeaturesByMunicipio(features, municipioNome);
    }
    const result = {
      ok: true,
      typeName: `local:${cfg.file}`,
      geojson: { type: 'FeatureCollection', features },
      total: features.length,
      totalRaw,
      truncated: false,
      filterMode: municipioNome ? 'bbox+municipio' : 'bbox',
      source: 'local',
    };
    cacheSet(key, result);
    return result;
  } catch (e) {
    return { ok: false, error: e.message || `Falha ao carregar ${cfg.file}`, typeName: `local:${cfg.file}` };
  }
}

/** Alias usado pelos consumidores existentes. */
const fetchIncraWfsByBbox = fetchIncraLayerByBbox;

exports.fetchIncraLayerByBbox = fetchIncraLayerByBbox;
exports.fetchIncraWfsByBbox = fetchIncraWfsByBbox;
exports.KNOWN_LAYERS = [...KNOWN_LAYERS];
exports.LOCAL_INCRA_LAYERS = Object.keys(LOCAL_INCRA_LAYERS);
