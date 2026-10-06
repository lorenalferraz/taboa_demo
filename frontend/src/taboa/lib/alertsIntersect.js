import * as turf from '@turf/turf';
import { geomCenter } from './geoCore.js';
import { wktToGeoJSON, simplifiedPointsToPolygon } from './wktParse.js';

/** Retorna o anel exterior de uma geometria. */
function firstRing(geom) {
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates?.[0] ?? null;
  if (geom.type === 'MultiPolygon') return geom.coordinates?.[0]?.[0] ?? null;
  return null;
}

/**
 * Fallback robusto: amostra até `maxSamples` vértices do anel e verifica se
 * algum está dentro de `poly`. Captura casos de winding order inválido ou
 * geometria levemente malformada que turf.booleanIntersects falha silenciosamente.
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

export function alertGeometryAndPoint(alert) {
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

export function alertRoughBbox(alert) {
  const { geojson, point } = alertGeometryAndPoint(alert);
  try {
    if (geojson) return turf.bbox(geojson);
    if (point) return [point[1], point[0], point[1], point[0]];
  } catch (_) {}
  return null;
}

export function alertPointFallbackAssentamentoIndex(alert, allFeatures) {
  if (!allFeatures?.length) return -1;
  const { point } = alertGeometryAndPoint(alert);
  if (!point) return -1;
  const pt = turf.point([point[1], point[0]]);
  for (let i = 0; i < allFeatures.length; i++) {
    const f = allFeatures[i];
    if (!f?.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, turf.feature(f.geometry))) return i;
    } catch (_) {}
  }
  return -1;
}

/**
 * Retorna true se o alerta intersecta qualquer polígono da faixa de planejamento.
 * Fix: a verificação por ponto (fallback) é sempre executada, não apenas quando
 * alertFeat é nulo — isso evita omitir alertas em bordas de município.
 */
export function alertHitsFaixaPlanningArea(alert, faixaFC) {
  const feats = faixaFC?.features || [];
  if (!feats.length) return true;
  const { geojson, point } = alertGeometryAndPoint(alert);
  if (!geojson && !point) return false;

  let alertFeat = null;
  let pt = null;
  try { alertFeat = geojson ? turf.feature(geojson) : null; } catch (_) {}
  try { pt = point ? turf.point([point[1], point[0]]) : null; } catch (_) {}

  for (const f of feats) {
    if (!f.geometry) continue;
    let poly = null;
    try { poly = turf.feature(f.geometry); } catch (_) {}
    if (!poly) continue;

    if (alertFeat) {
      try { if (turf.booleanIntersects(alertFeat, poly) || turf.booleanWithin(alertFeat, poly)) return true; } catch (_) {}
      try {
        const ring = firstRing(geojson);
        if (ring && sampleVerticesInsidePoly(ring, poly)) return true;
        const fRing = firstRing(f.geometry);
        if (fRing && sampleVerticesInsidePoly(fRing, alertFeat)) return true;
      } catch (_) {}
    }
    /** Sempre testa ponto — cobre alertas na borda cujo polígono não intersecta formalmente. */
    if (pt) {
      try { if (turf.booleanPointInPolygon(pt, poly)) return true; } catch (_) {}
    }
  }
  return false;
}

/**
 * Resolve a região de planejamento (litoral_sul | baixo_sul | extremo_sul | '') do alerta.
 * Fix: o fallback por ponto agora é executado mesmo quando alertFeat existe,
 * garantindo que alertas com geometria mas na borda do município sejam classificados.
 */
export function resolveRegiaoForAlertFromFaixa(alert, faixaFeatures) {
  if (!faixaFeatures || !faixaFeatures.length) return '';
  const { geojson, point } = alertGeometryAndPoint(alert);
  if (!geojson && !point) return '';

  let alertFeat = null;
  let pt = null;
  try { alertFeat = geojson ? turf.feature(geojson) : null; } catch (_) {}
  try { pt = point ? turf.point([point[1], point[0]]) : null; } catch (_) {}

  for (const f of faixaFeatures) {
    if (!f.geometry) continue;
    const reg = f.properties?._regiaoTaboa || '';
    if (reg !== 'litoral_sul' && reg !== 'baixo_sul' && reg !== 'extremo_sul') continue;

    let poly = null;
    try { poly = turf.feature(f.geometry); } catch (_) {}
    if (!poly) continue;

    if (alertFeat) {
      try { if (turf.booleanIntersects(alertFeat, poly) || turf.booleanWithin(alertFeat, poly)) return reg; } catch (_) {}
      try {
        const ring = firstRing(geojson);
        if (ring && sampleVerticesInsidePoly(ring, poly)) return reg;
        const fRing = firstRing(f.geometry);
        if (fRing && sampleVerticesInsidePoly(fRing, alertFeat)) return reg;
      } catch (_) {}
    }
    /** Ponto sempre testado — fix para Litoral Sul e outros alertas de borda. */
    if (pt) {
      try { if (turf.booleanPointInPolygon(pt, poly)) return reg; } catch (_) {}
    }
  }
  return '';
}

/**
 * Retorna true se alertGeom / fallbackPoint intersecta algum assentamento.
 * Usa pré-filtro de bbox antes de chamar turf para performance.
 */
export function alertIntersectsAssentamentos(alertGeom, assentamentosFeatures, fallbackPoint) {
  if (!assentamentosFeatures || assentamentosFeatures.length === 0) return true;

  let alertBbox = null;
  if (alertGeom) {
    try { alertBbox = turf.bbox(alertGeom); } catch (_) {}
  }

  if (alertGeom) {
    let alertFeat = null;
    try { alertFeat = turf.feature(alertGeom); } catch (_) {}

    for (const f of assentamentosFeatures) {
      if (!f.geometry) continue;
      if (alertBbox) {
        try {
          const fb = turf.bbox(f.geometry);
          if (alertBbox[2] < fb[0] || alertBbox[0] > fb[2] || alertBbox[3] < fb[1] || alertBbox[1] > fb[3]) continue;
        } catch (_) {}
      }
      let aoiFeat = null;
      try { aoiFeat = turf.feature(f.geometry); } catch (_) {}
      if (!aoiFeat) continue;

      if (alertFeat) {
        try { if (turf.booleanIntersects(alertFeat, aoiFeat) || turf.booleanWithin(alertFeat, aoiFeat)) return true; } catch (_) {}
        /** Vertex sampling — fallback para winding order inválido. */
        try {
          const ring = firstRing(alertGeom);
          if (ring && sampleVerticesInsidePoly(ring, aoiFeat)) return true;
          const featRing = firstRing(f.geometry);
          if (featRing && sampleVerticesInsidePoly(featRing, alertFeat)) return true;
        } catch (_) {}
      }
    }
  }

  if (fallbackPoint && fallbackPoint.length >= 2) {
    const lon = fallbackPoint[1];
    const lat = fallbackPoint[0];
    let pt = null;
    try { pt = turf.point([lon, lat]); } catch (_) {}
    if (pt) {
      for (const f of assentamentosFeatures) {
        if (!f.geometry) continue;
        try {
          const aoiFeat = turf.feature(f.geometry);
          if (turf.booleanPointInPolygon(pt, aoiFeat)) return true;
        } catch (_) {}
      }
    }
  }
  return false;
}

export function getAssentamentoNamesForAlert(alertGeom, assentamentosFeatures, fallbackPoint) {
  const names = [];
  if (!assentamentosFeatures) return names;
  const addName = (f) => {
    const n = f.properties?.nome_proje || f.properties?.denominaca || 'Área';
    const m = f.properties?.municipio ? ` (${f.properties.municipio})` : '';
    if (!names.includes(n + m)) names.push(n + m);
  };

  if (alertGeom) {
    let alertFeat = null;
    try { alertFeat = turf.feature(alertGeom); } catch (_) {}

    for (const f of assentamentosFeatures) {
      if (!f.geometry) continue;
      let aoiFeat = null;
      try { aoiFeat = turf.feature(f.geometry); } catch (_) {}
      if (!aoiFeat) continue;

      if (alertFeat) {
        try { if (turf.booleanIntersects(alertFeat, aoiFeat) || turf.booleanWithin(alertFeat, aoiFeat)) { addName(f); continue; } } catch (_) {}
        /** Vertex sampling — captura sobreposições que turf falha silenciosamente. */
        try {
          const ring = firstRing(alertGeom);
          if (ring && sampleVerticesInsidePoly(ring, aoiFeat)) { addName(f); continue; }
          const featRing = firstRing(f.geometry);
          if (featRing && sampleVerticesInsidePoly(featRing, alertFeat)) { addName(f); continue; }
        } catch (_) {}
      }
    }
  }

  if (names.length === 0 && fallbackPoint && fallbackPoint.length >= 2) {
    const lon = fallbackPoint[1];
    const lat = fallbackPoint[0];
    let pt = null;
    try { pt = turf.point([lon, lat]); } catch (_) {}
    if (pt) {
      for (const f of assentamentosFeatures) {
        if (!f.geometry) continue;
        try {
          const aoiFeat = turf.feature(f.geometry);
          if (turf.booleanPointInPolygon(pt, aoiFeat)) addName(f);
        } catch (_) {}
      }
    }
  }
  return names;
}

export function alertIntersectsGeoFeature(alert, feature) {
  if (!feature?.geometry) return false;
  const { geojson, point } = alertGeometryAndPoint(alert);
  const fallback = point ? [point[0], point[1]] : null;
  return alertIntersectsAssentamentos(geojson, [feature], fallback);
}

export function alertBelongsToFeature(alert, singleFeature) {
  return alertIntersectsGeoFeature(alert, singleFeature);
}

/**
 * Verifica interseção do alerta com a AOI resolvida (polígono prioritário ou
 * qualquer polígono que contenha o ponto).
 * @param {object} alert
 * @param {{ aoi?: import('geojson').Feature, containing?: import('geojson').Feature[], prioritizedHits?: { feature: import('geojson').Feature }[] }} resolved
 */
export function alertBelongsToResolvedAoi(alert, resolved) {
  if (!resolved?.aoi?.geometry) return false;
  const { geojson, point } = alertGeometryAndPoint(alert);
  const fallback = point ? [point[0], point[1]] : null;
  const hits = [{ geometry: resolved.aoi.geometry }];
  return alertIntersectsAssentamentos(geojson, hits, fallback);
}

/**
 * Área recortada do alerta dentro do shape, com fallbacks (areaHa da API, área total).
 * @returns {{ areaHa: number, geom: import('geojson').Geometry|null }|null}
 */
export function resolveAlertClipInShape(alertObj, shapeGeometry) {
  if (!shapeGeometry) return null;
  const clipped = computeClippedResult(alertObj, shapeGeometry);
  if (clipped?.areaHa > 0) return clipped;
  const apiArea = Number(alertObj?.areaHa);
  if (Number.isFinite(apiArea) && apiArea > 0) {
    const { geojson } = alertGeometryAndPoint(alertObj);
    return { areaHa: apiArea, geom: geojson || null };
  }
  const { geojson } = alertGeometryAndPoint(alertObj);
  if (geojson) {
    try {
      const areaHa = turf.area(turf.feature(geojson)) / 10000;
      if (areaHa > 0) return { areaHa, geom: geojson };
    } catch (_) {}
  }
  return null;
}

/** Interseção de polígonos (@turf/turf v7 exige FeatureCollection). */
export function intersectPolygonFeatures(featA, featB) {
  try {
    const a = featA?.type === 'Feature' ? featA : turf.feature(featA);
    const b = featB?.type === 'Feature' ? featB : turf.feature(featB);
    return turf.intersect(turf.featureCollection([a, b])) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Retorna { areaHa, geom } com a geometria recortada (interseção do alerta com
 * o shape), ou null se não houver interseção ou geometria disponível.
 */
export function computeClippedResult(alertObj, shapeGeometry) {
  if (!shapeGeometry) return null;
  const { geojson } = alertGeometryAndPoint(alertObj);
  if (!geojson) return null;
  try {
    const clip = intersectPolygonFeatures(turf.feature(geojson), turf.feature(shapeGeometry));
    if (!clip) return null;
    return {
      areaHa: turf.area(clip) / 10000,
      geom: clip.geometry,
    };
  } catch (_) {
    return null;
  }
}
