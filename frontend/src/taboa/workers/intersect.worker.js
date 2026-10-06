/**
 * Web Worker — cálculo de interseção de alertas com assentamentos.
 *
 * Recebe via postMessage:
 *   { alerts: PreparedAlert[], features: PreparedFeature[] }
 *
 * PreparedAlert: { alertCode, geojson: GeoJSON|null, point: [lat,lng]|null, roughBbox: [x0,y0,x1,y1]|null }
 * PreparedFeature: { idx, geometry: GeoJSON geometry|null, bbox: [x0,y0,x1,y1]|null }
 *
 * Retorna via postMessage:
 *   { type: 'progress', processed, total }          (a cada 50 alertas)
 *   { type: 'result', alertsByPolygon, allAlertCodes }
 */

import * as turf from '@turf/turf';

function bboxOverlap(ab, fb) {
  return !(ab[2] < fb[0] || ab[0] > fb[2] || ab[3] < fb[1] || ab[1] > fb[3]);
}

/**
 * Amostra até `maxSamples` vértices de um anel poligonal e verifica se algum
 * está dentro de `poly`. Robusto contra falhas do booleanIntersects em
 * geometrias com problemas de winding order ou auto-interseção.
 */
function sampleVerticesInsidePoly(ring, poly, maxSamples = 8) {
  if (!ring || ring.length < 2) return false;
  const step = Math.max(1, Math.floor(ring.length / maxSamples));
  for (let i = 0; i < ring.length; i += step) {
    try {
      if (turf.booleanPointInPolygon(turf.point(ring[i]), poly)) return true;
    } catch (_) {}
  }
  return false;
}

function firstRing(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates?.[0] ?? null;
  if (geom.type === 'MultiPolygon') return geom.coordinates?.[0]?.[0] ?? null;
  return null;
}

function intersectsFeature(alertGeojson, alertPt, alertBbox, featGeometry, featBbox) {
  /** Bbox prefilter rápido */
  if (alertBbox && featBbox && !bboxOverlap(alertBbox, featBbox)) return false;

  if (alertGeojson && featGeometry) {
    try {
      const alertFeat = turf.feature(alertGeojson);
      const aoiFeat = turf.feature(featGeometry);
      if (turf.booleanIntersects(alertFeat, aoiFeat) || turf.booleanWithin(alertFeat, aoiFeat)) return true;
    } catch (_) {}

    /**
     * Fallback por vértices — mais robusto para geometrias com winding order
     * incorreto ou levemente inválidas, onde booleanIntersects falha silenciosamente.
     */
    try {
      const aoiFeat = turf.feature(featGeometry);
      const alertRing = firstRing(alertGeojson);
      if (alertRing && sampleVerticesInsidePoly(alertRing, aoiFeat)) return true;

      const alertFeatForVtx = turf.feature(alertGeojson);
      const featRing = firstRing(featGeometry);
      if (featRing && sampleVerticesInsidePoly(featRing, alertFeatForVtx)) return true;
    } catch (_) {}
  }

  if (alertPt && featGeometry) {
    try {
      const pt = turf.point([alertPt[1], alertPt[0]]);
      const aoiFeat = turf.feature(featGeometry);
      if (turf.booleanPointInPolygon(pt, aoiFeat)) return true;
    } catch (_) {}
  }

  return false;
}

function pointFallbackIndex(point, features) {
  if (!point) return -1;
  const pt = turf.point([point[1], point[0]]);
  for (const f of features) {
    if (!f.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, turf.feature(f.geometry))) return f.idx;
    } catch (_) {}
  }
  return -1;
}

self.onmessage = function (e) {
  const { alerts, features } = e.data;
  const alertsByPolygon = {};
  const allAlertCodes = [];
  const seenCodes = new Set();

  for (const f of features) alertsByPolygon[f.idx] = [];

  const total = alerts.length;

  for (let i = 0; i < total; i++) {
    const a = alerts[i];

    if (i % 50 === 0 && i > 0) {
      self.postMessage({ type: 'progress', processed: i, total });
    }

    if (!a.roughBbox && !a.point) continue;

    if (!a.roughBbox) {
      /** Sem bbox de alerta — usa fallback por ponto */
      const idx = pointFallbackIndex(a.point, features);
      if (idx >= 0) {
        alertsByPolygon[idx].push(a.alertCode);
        if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      }
      continue;
    }

    let matched = false;
    for (const f of features) {
      if (!intersectsFeature(a.geojson, a.point, a.roughBbox, f.geometry, f.bbox)) continue;
      alertsByPolygon[f.idx].push(a.alertCode);
      if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      matched = true;
    }

    if (!matched) {
      /** Fallback ponto para alertas sem match geométrico (borda, geometria inválida) */
      const idx = pointFallbackIndex(a.point, features);
      if (idx >= 0) {
        alertsByPolygon[idx].push(a.alertCode);
        if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      }
    }
  }

  self.postMessage({ type: 'result', alertsByPolygon, allAlertCodes });
};
