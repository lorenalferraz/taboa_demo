'use strict';

const turf = require('@turf/turf');

/**
 * Índice leve de feições municipais — bbox + feature turf cacheado.
 * Evita recomputar bbox/turf.feature a cada alerta.
 */
function buildMunFeatureIndex(feats) {
  const items = [];
  for (const f of feats || []) {
    if (!f?.geometry) continue;
    let fb = null;
    let poly = null;
    try { fb = turf.bbox(f.geometry); } catch (_) {}
    try { poly = turf.feature(f.geometry); } catch (_) {}
    if (!poly) continue;
    items.push({ fb, poly });
  }
  return items;
}

function bboxesOverlap(a, b) {
  if (!a || !b) return true;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Testa alerta contra feições de um município (ou subconjunto).
 * @param {object} alert
 * @param {object} ctx — { geojson, point, alertBbox, alertFeat, pt } pré-computado opcional
 * @param {{ fb, poly }[]} index
 */
function alertHitsFeatureIndex(alert, index, ctx) {
  if (!index?.length) return false;

  let geojson = ctx?.geojson;
  let point = ctx?.point;
  let alertBbox = ctx?.alertBbox;
  let alertFeat = ctx?.alertFeat;
  let pt = ctx?.pt;

  if (!ctx) {
    const parsed = alert._geomCtx;
    if (parsed) {
      ({ geojson, point, alertBbox, alertFeat, pt } = parsed);
    }
  }

  if (!geojson && !point) return false;

  for (const { fb, poly } of index) {
    if (alertBbox && fb && !bboxesOverlap(alertBbox, fb)) continue;

    if (pt) {
      try { if (turf.booleanPointInPolygon(pt, poly)) return true; } catch (_) {}
    }
    if (alertFeat) {
      try { if (turf.booleanIntersects(alertFeat, poly)) return true; } catch (_) {}
    }
  }
  return false;
}

function buildAlertGeomCtx(alert, alertGeometryAndPoint) {
  if (alert._geomCtx) return alert._geomCtx;
  const { geojson, point } = alertGeometryAndPoint(alert);
  let alertBbox = null;
  let alertFeat = null;
  let pt = null;
  try { if (geojson) alertBbox = turf.bbox(geojson); } catch (_) {}
  try { alertFeat = geojson ? turf.feature(geojson) : null; } catch (_) {}
  try { pt = point ? turf.point([point[1], point[0]]) : null; } catch (_) {}
  const ctx = { geojson, point, alertBbox, alertFeat, pt };
  alert._geomCtx = ctx;
  return ctx;
}

function filterAlertsInMunIndex(collection, index, alertGeometryAndPoint) {
  if (!index.length) return collection || [];
  const out = [];
  for (const a of collection || []) {
    const ctx = buildAlertGeomCtx(a, alertGeometryAndPoint);
    if (alertHitsFeatureIndex(a, index, ctx)) out.push(a);
  }
  return out;
}

function buildFaixaFeatureIndex(feats) {
  const items = [];
  for (const f of feats || []) {
    if (!f?.geometry) continue;
    let fb = null;
    let poly = null;
    try { fb = turf.bbox(f.geometry); } catch (_) {}
    try { poly = turf.feature(f.geometry); } catch (_) {}
    if (!poly) continue;
    const p = f.properties || {};
    const munNome = String(p.nomMun || p.nm_mun || p.NM_MUN || p.municipio || '').trim();
    items.push({
      fb,
      poly,
      regiaoTaboa: p._regiaoTaboa || '',
      munNome,
    });
  }
  return items;
}

/**
 * Filtra alertas pela interseção com polígonos da faixa e anota região/município.
 */
function filterAlertsInFaixaIndex(collection, index, alertGeometryAndPoint) {
  if (!index.length) return [];
  const out = [];
  for (const a of collection || []) {
    const ctx = buildAlertGeomCtx(a, alertGeometryAndPoint);
    let matched = false;
    for (const { fb, poly, regiaoTaboa, munNome } of index) {
      if (ctx.alertBbox && fb && !bboxesOverlap(ctx.alertBbox, fb)) continue;
      let hits = false;
      if (ctx.pt) {
        try { if (turf.booleanPointInPolygon(ctx.pt, poly)) hits = true; } catch (_) {}
      }
      if (!hits && ctx.alertFeat) {
        try { if (turf.booleanIntersects(ctx.alertFeat, poly)) hits = true; } catch (_) {}
      }
      if (!hits) continue;
      matched = true;
      if (regiaoTaboa) {
        if (!a._regiaoTaboa) a._regiaoTaboa = regiaoTaboa;
        else if (a._regiaoTaboa !== regiaoTaboa && a._regiaoTaboa !== 'divisa') a._regiaoTaboa = 'divisa';
      }
      if (munNome) {
        if (!Array.isArray(a._munNomesInFaixa)) a._munNomesInFaixa = [];
        if (!a._munNomesInFaixa.includes(munNome)) a._munNomesInFaixa.push(munNome);
      }
    }
    if (matched) out.push(a);
  }
  return out;
}

module.exports = {
  buildMunFeatureIndex,
  buildFaixaFeatureIndex,
  alertHitsFeatureIndex,
  buildAlertGeomCtx,
  filterAlertsInMunIndex,
  filterAlertsInFaixaIndex,
};
