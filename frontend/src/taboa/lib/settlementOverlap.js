/**
 * Priorização de imóveis rurais e sobreposição imóvel × assentamentos (PA, quilombolas, TIs).
 */
import * as turf from '@turf/turf';
import { featureNomePublico } from './region.js';
import { assentamentoFeatureTitle } from './assentamentoMeta.js';

const CRUZAMENTO_KIND_RANK = {
  certificado_privado: 0,
  certificado_publico: 0,
  car: 1,
  imovel_rural: 2,
  sigef: 3,
  cefir: 4,
  indigena: 5,
  quilombo: 6,
  assentamento: 7,
  outros: 8,
};

function humanKindLabel(kind) {
  const k = kind || 'outros';
  if (k === 'certificado_privado') return 'Certificado privado';
  if (k === 'car') return 'CAR / SICAR';
  if (k === 'imovel_rural') return 'Imóvel rural / INEMA';
  if (k === 'sigef') return 'SIGEF';
  if (k === 'cefir') return 'CEFIR';
  if (k === 'indigena') return 'Terra Indígena';
  if (k === 'quilombo') return 'Quilombo';
  if (k === 'assentamento') return 'Assentamento';
  return 'Outros';
}

export const RURAL_PROPERTY_KINDS = new Set([
  'certificado_privado',
  'certificado_publico',
  'car',
  'imovel_rural',
  'sigef',
  'cefir',
]);

export const SETTLEMENT_KINDS = new Set(['assentamento', 'quilombo', 'indigena']);

const SETTLEMENT_CAMADAS_LABEL = {
  assentamento: 'Sobreposição — Assentamentos',
  quilombo: 'Sobreposição — Quilombolas',
  indigena: 'Sobreposição — Terras Indígenas',
};

function rankOf(kind) {
  return CRUZAMENTO_KIND_RANK[kind] ?? CRUZAMENTO_KIND_RANK.outros;
}

export function sortHitsForCruzamento(hits) {
  const sorted = [...(hits || [])];
  sorted.sort((a, b) => {
    const ta = a.sourceTier ?? 2;
    const tb = b.sourceTier ?? 2;
    if (ta !== tb) return ta - tb;
    const ra = rankOf(a.kind);
    const rb = rankOf(b.kind);
    if (ra !== rb) return ra - rb;
    return (a.area || 0) - (b.area || 0);
  });
  return sorted;
}

export function pickPrimaryRuralPropertyHit(hits) {
  const rural = (hits || []).filter((h) => RURAL_PROPERTY_KINDS.has(h.kind));
  if (!rural.length) return null;
  return sortHitsForCruzamento(rural)[0];
}

function settlementLabel(kind, feature, featureIndex) {
  if (kind === 'assentamento') return assentamentoFeatureTitle(feature?.properties);
  return featureNomePublico(feature, featureIndex ?? 0);
}

function featureDedupKey(kind, feature) {
  const p = feature?.properties || {};
  const id =
    p.gid ?? p.cd_sipra ?? p.terrai_codigo ?? p.terrai_cod ?? p.nm_comunid ?? p.numero_car ?? '';
  if (id != null && String(id).trim() !== '') return `${kind}:${String(id).trim()}`;
  try {
    return `${kind}:geom:${JSON.stringify(feature.geometry?.coordinates?.[0]?.[0]?.slice?.(0, 2))}`;
  } catch (_) {
    return `${kind}:rnd:${Math.random()}`;
  }
}

function toFeature(geomOrFeat) {
  if (!geomOrFeat) return null;
  try {
    return geomOrFeat.type === 'Feature' ? geomOrFeat : turf.feature(geomOrFeat);
  } catch (_) {
    return null;
  }
}

function intersectFeatures(a, b) {
  try {
    return turf.intersect(turf.featureCollection([a, b])) || null;
  } catch (_) {
    return null;
  }
}

function intersectionHa(a, b) {
  const inter = intersectFeatures(a, b);
  if (!inter) return null;
  const ha = turf.area(inter) / 10000;
  if (!Number.isFinite(ha) || ha <= 1e-8) return null;
  return Math.round(ha * 10000) / 10000;
}

export function collectSettlementFeaturesForOverlap(candidates) {
  const out = [];
  const seen = new Set();
  const add = (kind, feature, sourceFile, featureIndex = 0) => {
    if (!feature?.geometry || !SETTLEMENT_KINDS.has(kind)) return;
    const t = feature.geometry.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') return;
    const key = featureDedupKey(kind, feature);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, feature, sourceFile: sourceFile || '', featureIndex });
  };

  for (const c of candidates || []) {
    if (SETTLEMENT_KINDS.has(c.kind)) add(c.kind, c.feature, c.sourceFile, c.featureIndex ?? 0);
  }

  return out;
}

export function computePropertySettlementOverlaps(propertyGeom, settlementFeatures) {
  const propertyFeat = toFeature(propertyGeom);
  const empty = { propertyAreaHa: null, overlaps: [], totals: {}, camadasHa: {} };
  if (!propertyFeat) return empty;

  let propertyAreaHa = null;
  try {
    propertyAreaHa = Math.round((turf.area(propertyFeat) / 10000) * 10000) / 10000;
  } catch (_) {}

  const overlaps = [];
  const totals = { assentamento: 0, quilombo: 0, indigena: 0 };
  const totalParts = { assentamento: [], quilombo: [], indigena: [] };

  for (const item of settlementFeatures || []) {
    const settFeat = toFeature(item.feature);
    if (!settFeat) continue;
    try {
      if (!turf.booleanIntersects(propertyFeat, settFeat)) continue;
    } catch (_) {
      continue;
    }
    const overlapHa = intersectionHa(propertyFeat, settFeat);
    if (overlapHa == null) continue;

    const pctOfProperty =
      propertyAreaHa != null && propertyAreaHa > 0
        ? Math.round((overlapHa / propertyAreaHa) * 10000) / 100
        : null;

    overlaps.push({
      kind: item.kind,
      kindLabel: humanKindLabel(item.kind),
      label: settlementLabel(item.kind, item.feature, item.featureIndex),
      overlapHa,
      pctOfProperty,
      sourceFile: item.sourceFile || '',
    });

    const inter = intersectFeatures(propertyFeat, settFeat);
    if (inter) totalParts[item.kind].push(inter.type === 'Feature' ? inter : turf.feature(inter));
  }

  overlaps.sort((a, b) => {
    const d = rankOf(a.kind) - rankOf(b.kind);
    if (d !== 0) return d;
    return b.overlapHa - a.overlapHa;
  });

  for (const kind of SETTLEMENT_KINDS) {
    const parts = totalParts[kind];
    if (!parts.length) continue;
    try {
      let united = parts[0];
      for (let i = 1; i < parts.length; i++) {
        try { united = turf.union(turf.featureCollection([united, parts[i]])) || united; } catch (_) {}
      }
      let ha = turf.area(united) / 10000;
      if (propertyAreaHa != null && propertyAreaHa > 0) ha = Math.min(ha, propertyAreaHa);
      if (Number.isFinite(ha) && ha > 0) totals[kind] = Math.round(ha * 10000) / 10000;
    } catch (_) {}
  }

  const camadasHa = {};
  for (const [kind, ha] of Object.entries(totals)) {
    if (ha > 0 && SETTLEMENT_CAMADAS_LABEL[kind]) {
      camadasHa[SETTLEMENT_CAMADAS_LABEL[kind]] = ha;
    }
  }

  return { propertyAreaHa, overlaps, totals, camadasHa };
}

export function applySettlementOverlapToCamadasHa(camadasHa, overlapResult) {
  if (!camadasHa || !overlapResult?.camadasHa) return camadasHa || {};
  return { ...camadasHa, ...overlapResult.camadasHa };
}

export function enrichCruzamentoWithSettlementOverlap(imovelReport, resolved, allCandidates) {
  const hits = resolved?.prioritizedHits || [];
  const ruralHit = pickPrimaryRuralPropertyHit(hits);
  const propertyFeat = ruralHit?.feature || null;
  if (!propertyFeat || !imovelReport?.camadasHa) {
    return { settlementOverlap: null };
  }

  const settlements = collectSettlementFeaturesForOverlap(allCandidates);
  const overlap = computePropertySettlementOverlaps(propertyFeat, settlements);
  applySettlementOverlapToCamadasHa(imovelReport.camadasHa, overlap);

  if (overlap.propertyAreaHa != null && imovelReport.primaryRuralRow && imovelReport.primaryImovel) {
    if (imovelReport.primaryImovel.areaHa == null) {
      imovelReport.primaryImovel.areaHa = overlap.propertyAreaHa;
      imovelReport.camadasHa['Área total da propriedade'] = overlap.propertyAreaHa;
    }
  }

  return { settlementOverlap: overlap };
}
