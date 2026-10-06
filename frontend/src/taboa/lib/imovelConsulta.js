/**
 * Imóveis identificados no centróide da Consulta — CAR/SICAR primeiro, depois assentamentos.
 */
import * as turf from '@turf/turf';
import { featureNomePublico, formatCefirCarFromFeatureProperties } from './region.js';
import { humanKindLabel } from './cruzamentoPrioridade.js';
import {
  pickPrimaryRuralPropertyHit,
  collectSettlementFeaturesForOverlap,
  computePropertySettlementOverlaps,
  applySettlementOverlapToCamadasHa,
  RURAL_PROPERTY_KINDS,
} from './settlementOverlap.js';

function firstProp(p, keys) {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
    const v = p[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s && s.toLowerCase() !== 'null') return s;
  }
  return '';
}

function parseAreaHa(raw, fallbackHa) {
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (fallbackHa != null && Number.isFinite(Number(fallbackHa)) && Number(fallbackHa) > 0) {
    return Number(fallbackHa);
  }
  return null;
}

/** Feição WFS CAR/SICAR (prioridade no relatório). */
export function isSicarCarHit(hit) {
  if (!hit) return false;
  if (hit.kind === 'car') return true;
  const sf = String(hit.sourceFile || '').toLowerCase();
  if (sf.includes('sicar') || sf.includes('car/sicar') || sf.includes('wfs car')) return true;
  return false;
}

export function isAssentamentoHit(hit) {
  return hit?.kind === 'assentamento';
}

/**
 * @param {object} hit — entrada de prioritizedHits
 */
export function extractImovelReportRow(hit) {
  const p = hit?.feature?.properties || {};
  const carCode =
    formatCefirCarFromFeatureProperties(p) ||
    firstProp(p, ['cod_imovel', 'COD_IMOVEL', 'numero_car', 'NUMERO_CAR', 'nuCAR']);
  const label = featureNomePublico(hit.feature, hit.featureIndex ?? 0);
  const areaHa = parseAreaHa(
    firstProp(p, ['area', 'area_hecta', 'area_regis', 'area_calc_', 'area_calc_ha', 'area_hectare_declarada']),
    hit.areaHa,
  );
  return {
    kind: hit.kind || 'outros',
    kindLabel: humanKindLabel(hit.kind),
    sourceFile: hit.sourceFile || '',
    label,
    carCode: carCode || '—',
    codImovel: firstProp(p, ['cod_imovel', 'COD_IMOVEL', 'numero_car', 'NUMERO_CAR']),
    municipio: firstProp(p, ['municipio', 'nomMun', 'NM_MUN', 'nome_municipio']),
    uf: firstProp(p, ['uf', 'UF', 'sigla_uf']),
    status: firstProp(p, ['status_imovel', 'status', 'condicao']),
    tipoImovel: firstProp(p, ['tipo_imovel', 'tipo']),
    areaHa,
    isCar: isSicarCarHit(hit),
    isAssentamento: isAssentamentoHit(hit),
  };
}

function hitsFromResolved(resolved) {
  if (resolved?.prioritizedHits?.length) return resolved.prioritizedHits;
  if (resolved?.containing?.length && resolved?.aoiMeta) {
    return [
      {
        feature: resolved.containing[0],
        sourceFile: resolved.aoiMeta.sourceFile,
        kind: resolved.aoiMeta.kind,
        featureIndex: 0,
        areaHa: resolved.aoiMeta.areaHa,
      },
    ];
  }
  return [];
}

/**
 * Lista imóveis no ponto: CAR/SICAR primeiro, assentamentos depois, demais por último.
 * @returns {{ imoveisNoPonto: object[], primaryCar: object|null, primaryImovel: object|null, camadasHa: Record<string, number> }}
 */
export function collectImoveisAtPointForReport(resolved) {
  const hits = hitsFromResolved(resolved);
  const carRows = [];
  const assentRows = [];
  const otherRows = [];
  const seen = new Set();

  for (const h of hits) {
    const row = extractImovelReportRow(h);
    const dedup =
      row.carCode !== '—'
        ? row.carCode.toUpperCase()
        : `${row.kind}|${row.label}|${row.sourceFile}`.toLowerCase();
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    if (row.isCar) carRows.push(row);
    else if (row.isAssentamento) assentRows.push(row);
    else otherRows.push(row);
  }

  const imoveisNoPonto = [...carRows, ...assentRows, ...otherRows];
  const primaryCar = carRows[0] || null;
  const ruralHit = pickPrimaryRuralPropertyHit(hits);
  const primaryRuralRow = ruralHit ? extractImovelReportRow(ruralHit) : null;
  const primaryImovel = primaryRuralRow || primaryCar || imoveisNoPonto.find((r) => !r.isAssentamento) || imoveisNoPonto[0] || null;
  const camadasHa = {};
  if (primaryImovel?.areaHa != null) {
    camadasHa['Área total da propriedade'] = primaryImovel.areaHa;
  }
  return { imoveisNoPonto, primaryCar, primaryImovel, primaryRuralRow, camadasHa };
}

/** Código CAR utilizável (evita null/placeholder "—"). */
export function pickCarCodeFromImovelRow(row) {
  const c = row?.carCode;
  if (c == null || String(c).trim() === '' || String(c).trim() === '—') return '';
  return String(c).trim();
}

export {
  pickPrimaryRuralPropertyHit,
  collectSettlementFeaturesForOverlap,
  computePropertySettlementOverlaps,
  applySettlementOverlapToCamadasHa,
  enrichCruzamentoWithSettlementOverlap,
  RURAL_PROPERTY_KINDS,
  SETTLEMENT_KINDS,
} from './settlementOverlap.js';

// ─── Cálculo local de Sobreposição de CEFIR ──────────────────────────────────

function localCandidateKey(c) {
  if (!c?.feature) return '';
  const car = formatCefirCarFromFeatureProperties(c.feature.properties || {});
  if (car) return `car:${car.toUpperCase()}`;
  const sf = String(c.sourceFile || '');
  const idx = c.featureIndex ?? 0;
  return `geom:${sf}#${idx}`;
}

function bboxesOverlapLocal(a, b) {
  if (!a || !b) return true;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function intersectLocalFeatures(aoiFeat, rawFeat, aoiBbox) {
  if (!rawFeat?.geometry) return null;
  try {
    const pf = rawFeat.type === 'Feature' ? rawFeat : turf.feature(rawFeat.geometry);
    if (aoiBbox && !bboxesOverlapLocal(aoiBbox, turf.bbox(pf))) return null;
    if (!turf.booleanIntersects(aoiFeat, pf)) return null;
    try {
      const inter = turf.intersect(turf.featureCollection([aoiFeat, pf]));
      if (inter) return inter;
    } catch (_) {}
    if (turf.booleanWithin(aoiFeat, pf)) return aoiFeat;
    if (turf.booleanWithin(pf, aoiFeat)) return pf;
  } catch (_) {}
  return null;
}

function sumLocalIntersectionHa(aoiFeat, rawFeatures, capHa) {
  if (!aoiFeat || !rawFeatures?.length) return null;
  let aoiBbox = null;
  try { aoiBbox = turf.bbox(aoiFeat); } catch (_) {}
  const parts = [];
  for (const raw of rawFeatures) {
    const inter = intersectLocalFeatures(aoiFeat, raw, aoiBbox);
    if (inter) parts.push(inter.type === 'Feature' ? inter : turf.feature(inter));
  }
  if (!parts.length) return null;
  try {
    let united = parts[0];
    for (let i = 1; i < parts.length; i++) {
      try { united = turf.union(turf.featureCollection([united, parts[i]])) || united; } catch (_) {}
    }
    let ha = turf.area(united) / 10000;
    if (!Number.isFinite(ha) || ha <= 0) return null;
    if (capHa != null && Number.isFinite(capHa) && capHa > 0) ha = Math.min(ha, capHa);
    return Math.round(ha * 10000) / 10000;
  } catch (_) {
    return null;
  }
}

/**
 * Enriquece um objeto `camadasHa` já existente com Sobreposição de CEFIR e Área Antropizada.
 * Usado no path local (frontend sem backend), onde as camadas temáticas SICAR não estão disponíveis.
 *
 * @param {Record<string, number>} camadasHa — objeto mutável (Área total da propriedade já preenchida)
 * @param {import('geojson').Feature|import('geojson').Geometry|null} aoiGeom — geometria/feature do imóvel primário
 * @param {object[]|null} candidates — candidatos WFS buscados para a bbox do ponto
 * @param {string|null} primaryKey — chave do imóvel primário (para excluí-lo do CEFIR)
 */
export function enrichLocalCamadasHa(camadasHa, aoiGeom, candidates, primaryKey) {
  if (!aoiGeom || !candidates?.length) return;

  let aoiFeat = null;
  try {
    aoiFeat = aoiGeom.type === 'Feature' ? aoiGeom : turf.feature(aoiGeom);
  } catch (_) {
    return;
  }
  const cap = camadasHa['Área total da propriedade'] ?? null;

  // Sobreposição de CEFIR: imóveis CEFIR vizinhos que não são o imóvel primário
  const cefirOthers = candidates.filter((c) => {
    if (c.kind !== 'cefir') return false;
    const key = localCandidateKey(c);
    return !key || key !== primaryKey;
  });

  if (cefirOthers.length) {
    const cefirHa = sumLocalIntersectionHa(aoiFeat, cefirOthers.map((c) => c.feature), cap);
    if (cefirHa != null) camadasHa['Sobreposição de CEFIR'] = cefirHa;
  }

  // Área Antropizada = Área Total − Remanescente florestal (quando disponível)
  const total = camadasHa['Área total da propriedade'];
  const rem = camadasHa['Remanescente florestal'];
  if (total != null && rem != null) {
    camadasHa['Área antropizada'] = Math.max(0, Math.round((total - rem) * 10000) / 10000);
  }
}
