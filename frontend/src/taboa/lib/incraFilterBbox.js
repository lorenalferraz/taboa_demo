/**
 * Bbox WGS84 [west, south, east, north] da faixa em municipios.geojson.
 * O seletor de município só faz zoom no mapa — não restringe esta bbox.
 */
import * as turf from '@turf/turf';
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';

/** @type {object | null} */
let faixaFcCache = null;
/** @type {number[] | null} */
let faixaBboxCache = null;

function padBbox(bb, ratio = 0.02) {
  const [w, s, e, n] = bb;
  const latPad = Math.max((n - s) * ratio, 0.01);
  const lngPad = Math.max((e - w) * ratio, 0.01);
  return [w - lngPad, s - latPad, e + lngPad, n + latPad];
}

async function loadFaixaFc() {
  if (faixaFcCache) return faixaFcCache;
  const resp = await fetchFaixaGeoJson();
  if (!resp?.ok || !resp.geojson?.features?.length) {
    throw new Error(resp?.error || 'Faixa municipal não encontrada.');
  }
  faixaFcCache = resp.geojson;
  try { faixaBboxCache = turf.bbox(faixaFcCache); } catch (_) { faixaBboxCache = null; }
  return faixaFcCache;
}

/**
 * @returns {Promise<{ bbox: number[] | null, label: string, uf: string, municipio: string, ibgeId: number | null }>}
 */
export async function resolveFilterBbox() {
  await loadFaixaFc();
  return {
    bbox: faixaBboxCache ? padBbox(faixaBboxCache, 0.005) : null,
    label: 'Faixa TABOA',
    uf: 'BA',
    municipio: '',
    ibgeId: null,
  };
}
