/**
 * Cliente HTTP — município IBGE por coordenada WGS84.
 */
import { getApiBase } from './config.js';

const TIMEOUT_MS = 45000;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, { expiresAt: number, data: object }>} */
const coordCache = new Map();

function cacheKey(lat, lng) {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

function getCached(lat, lng) {
  const row = coordCache.get(cacheKey(lat, lng));
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    coordCache.delete(cacheKey(lat, lng));
    return null;
  }
  return row.data;
}

function setCached(lat, lng, data) {
  coordCache.set(cacheKey(lat, lng), { expiresAt: Date.now() + CACHE_TTL_MS, data });
}

/**
 * @param {number} lat WGS84
 * @param {number} lng WGS84
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchMunicipioPorCoordenada(lat, lng, opts = {}) {
  const cached = getCached(lat, lng);
  if (cached) return { ...cached };

  const base = getApiBase();
  if (!base) throw new Error('Backend local necessário (npm start em DEPLOY/).');

  const q = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  const ctrl = opts.signal
    ? { signal: opts.signal }
    : typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(TIMEOUT_MS) }
      : {};
  const res = await fetch(`${base}/api/ibge/municipio-por-coordenada?${q}`, ctrl);
  const json = await res.json().catch(() => ({}));
  if (!json.ok && !json.error) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  if (json.ok) setCached(lat, lng, json);
  return json;
}

/**
 * Resolve várias coordenadas em uma chamada backend, mantendo cache local por ponto.
 * @param {Array<{id?: string|number, lat: number, lng: number}>} points
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function fetchMunicipiosPorCoordenadas(points, opts = {}) {
  const rows = (Array.isArray(points) ? points : [])
    .map((p, index) => ({ id: p.id ?? index, lat: p.lat, lng: p.lng, index }))
    .filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));

  const results = [];
  const pending = [];
  for (const p of rows) {
    const cached = getCached(p.lat, p.lng);
    if (cached) {
      results.push({ id: p.id, index: p.index, ...cached });
    } else {
      pending.push(p);
    }
  }

  if (!pending.length) return { ok: true, results };

  const base = getApiBase();
  if (!base) throw new Error('Backend local necessário (npm start em DEPLOY/).');

  const ctrl = opts.signal
    ? { signal: opts.signal }
    : typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(TIMEOUT_MS) }
      : {};
  const res = await fetch(`${base}/api/consulta/localidades`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: pending }),
    ...ctrl,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok && !json.error) return { ok: false, error: `HTTP ${res.status}`, results };

  for (const item of json.results || []) {
    if (item.ok) setCached(item.lat, item.lng, item);
    results.push(item);
  }
  return { ...json, results };
}
