/**
 * Cliente de camadas INCRA locais via backend.
 */
import { getApiBase } from './config.js';

const TIMEOUT_MS = 300000;

/**
 * @param {string} layerId
 * @param {string} uf
 * @param {number[]} bbox — [west, south, east, north]
 * @param {{ municipio?: string }} [opts]
 */
export async function fetchIncraLocalLayer(layerId, uf, bbox, opts = {}) {
  const base = getApiBase();
  if (!base) throw new Error('Backend local necessário para camadas INCRA.');
  const q = bbox.map((n) => Number(n).toFixed(5)).join(',');
  const params = new URLSearchParams({
    layer: layerId,
    uf,
    bbox: q,
  });
  if (opts.municipio) params.set('municipio', opts.municipio);
  const ctrl = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? { signal: AbortSignal.timeout(TIMEOUT_MS) }
    : {};
  const url = `${base}/api/local/incra?${params.toString()}`;
  const res = await fetch(url, ctrl);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

/** Alias usado pelo preload do mapa. */
export const fetchIncraWfsLayer = fetchIncraLocalLayer;
