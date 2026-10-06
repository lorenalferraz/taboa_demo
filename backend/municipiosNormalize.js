'use strict';

const { ringCentroid } = require('./geomLite');
const {
  FAIXA_MUNICIPIOS,
  BY_IBGE,
  BY_NOME,
  FAIXA_IBGE_SET,
  normMunNome,
} = require('./municipios');

/** Bbox aproximada da faixa 05/06/07 (BA) — descarta homônimos fora da área. */
const FAIXA_BBOX = [-40.85, -18.65, -37.15, -12.85];

function featureCentroidInFaixa(feat) {
  if (!feat?.geometry) return false;
  try {
    const c = ringCentroid(feat.geometry);
    if (!c) return false;
    const [lng, lat] = c;
    return lng >= FAIXA_BBOX[0] && lng <= FAIXA_BBOX[2] && lat >= FAIXA_BBOX[1] && lat <= FAIXA_BBOX[3];
  } catch (_) {
    return false;
  }
}

function resolveCatalogForFeature(feat) {
  const p = feat?.properties || {};
  const rawIbge = Number(String(p.cd_mun ?? p.codMun ?? p.codigo ?? '').replace(/\D/g, ''));
  const nm = p.nm_mun || p.nomMun || p.NM_MUN || p.municipio || '';
  if (Number.isFinite(rawIbge) && BY_IBGE.has(rawIbge)) return BY_IBGE.get(rawIbge);
  const byNome = BY_NOME.get(normMunNome(nm));
  if (byNome) return byNome;
  return null;
}

/**
 * Corrige cd_mun/nome/região pelo catálogo oficial (62 mun BA) e remove feições fora da faixa.
 */
function normalizeFaixaShapeGeoJSON(geojson) {
  if (!geojson?.features?.length) return geojson;
  const kept = [];
  for (const feat of geojson.features) {
    if (!feat?.geometry) continue;
    if (!featureCentroidInFaixa(feat)) continue;
    const meta = resolveCatalogForFeature(feat);
    if (!meta) continue;
    if (!feat.properties) feat.properties = {};
    feat.properties.cd_mun = String(meta.ibge);
    feat.properties.codMun = meta.ibge;
    feat.properties.nm_mun = meta.nomMun;
    feat.properties.nomMun = meta.nomMun;
    feat.properties._regiaoTaboa = meta.regiao;
    feat.properties.sigla_uf = 'BA';
    kept.push(feat);
  }
  const seenIbge = new Set(kept.map((f) => f.properties.codMun));
  const missing = FAIXA_MUNICIPIOS.filter((m) => !seenIbge.has(m.ibge)).map((m) => m.nomMun);
  return {
    ...geojson,
    type: 'FeatureCollection',
    features: kept,
    metadata: {
      ...(geojson.metadata || {}),
      normalizedAt: new Date().toISOString(),
      municipiosNoShape: seenIbge.size,
      municipiosEsperados: FAIXA_MUNICIPIOS.length,
      missingMunicipios: missing,
    },
  };
}

exports.normalizeFaixaShapeGeoJSON = normalizeFaixaShapeGeoJSON;
exports.FAIXA_BBOX = FAIXA_BBOX;
exports.FAIXA_IBGE_SET = FAIXA_IBGE_SET;
