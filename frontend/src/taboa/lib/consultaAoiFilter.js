/**
 * Filtro de alertas na AOI da Consulta — bbox prefilter + yields para não travar a UI.
 */
import * as turf from '@turf/turf';
import { alertBelongsToResolvedAoi, alertGeometryAndPoint, alertRoughBbox } from './alertsIntersect.js';
import { yieldToMain } from './yieldToMain.js';

const YIELD_EVERY = 60;

function bboxesOverlap(a, b) {
  if (!a || !b) return true;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** Bbox WGS84 da AOI resolvida (com margem). */
export function aoiFilterBbox(resolvedOrAoi, padRatio = 0.02) {
  const resolved = resolvedOrAoi?.aoi
    ? resolvedOrAoi
    : resolvedOrAoi?.geometry
      ? { aoi: resolvedOrAoi }
      : null;
  if (!resolved?.aoi?.geometry) return null;
  try {
    const bb = turf.bbox(resolved.aoi);
    const latPad = Math.max((bb[3] - bb[1]) * padRatio, 0.0005);
    const lngPad = Math.max((bb[2] - bb[0]) * padRatio, 0.0005);
    return [bb[0] - lngPad, bb[1] - latPad, bb[2] + lngPad, bb[3] + latPad];
  } catch (_) {
    return null;
  }
}

function alertMayIntersectAoiBbox(alert, aoiBb) {
  if (!aoiBb) return true;
  const ab = alertRoughBbox(alert);
  if (ab && bboxesOverlap(ab, aoiBb)) return true;
  const { point } = alertGeometryAndPoint(alert);
  if (point) {
    const lng = point[1];
    const lat = point[0];
    if (lng >= aoiBb[0] && lng <= aoiBb[2] && lat >= aoiBb[1] && lat <= aoiBb[3]) return true;
  }
  return false;
}

function normalizeResolved(resolvedOrAoi) {
  return resolvedOrAoi?.aoi
    ? resolvedOrAoi
    : { aoi: resolvedOrAoi, containing: [], prioritizedHits: [] };
}

/**
 * Filtro síncrono (legado) — preferir filterAlertsInAoiAsync em listas grandes.
 */
export function filterAlertsInAoi(alerts, resolvedOrAoi) {
  const resolved = normalizeResolved(resolvedOrAoi);
  if (!resolved?.aoi?.geometry) return [];
  const aoiBb = aoiFilterBbox(resolved);
  const out = [];
  const seen = new Set();
  for (const a of alerts || []) {
    if (!a?.alertCode || seen.has(a.alertCode)) continue;
    if (!alertMayIntersectAoiBbox(a, aoiBb)) continue;
    if (!alertBelongsToResolvedAoi(a, resolved)) continue;
    seen.add(a.alertCode);
    out.push(a);
  }
  return out;
}

/**
 * Filtro assíncrono com pré-bbox e yield periódico.
 * @param {() => boolean} [shouldCancel] — retorna true para abortar.
 */
export async function filterAlertsInAoiAsync(alerts, resolvedOrAoi, shouldCancel) {
  const resolved = normalizeResolved(resolvedOrAoi);
  if (!resolved?.aoi?.geometry) return [];
  const aoiBb = aoiFilterBbox(resolved);
  const out = [];
  const seen = new Set();
  const list = alerts || [];
  let i = 0;
  for (const a of list) {
    if (shouldCancel?.()) return out;
    if (i > 0 && i % YIELD_EVERY === 0) await yieldToMain();
    i += 1;
    if (!a?.alertCode || seen.has(a.alertCode)) continue;
    if (!alertMayIntersectAoiBbox(a, aoiBb)) continue;
    if (!alertBelongsToResolvedAoi(a, resolved)) continue;
    seen.add(a.alertCode);
    out.push(a);
  }
  return out;
}
