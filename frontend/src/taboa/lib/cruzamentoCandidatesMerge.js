/**
 * Prioridade WFS > shape local no cruzamento (transição até remover pasta shape/).
 */
import * as turf from '@turf/turf';
import { normMunNome } from './region.js';

/** Menor = maior prioridade na resolução de AOI. */
export const CRUZAMENTO_SOURCE_TIER = {
  WFS_REMOTE: 0,
  WFS_LOCAL: 1,
  SHAPE: 2,
};

function normCar(value) {
  if (value == null || value === '') return '';
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

function normSipra(value) {
  if (value == null || value === '') return '';
  return String(value).trim().toUpperCase();
}

function normNomeAssentamento(value) {
  if (value == null || value === '') return '';
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/\s+/g, ' ');
}

function firstProp(p, keys) {
  for (const k of keys) {
    const v = p?.[k];
    if (v != null && String(v).trim() && String(v).toLowerCase() !== 'null') return String(v).trim();
  }
  return '';
}

/**
 * Chaves de deduplicação entre feição shape e feição WFS equivalente.
 * @param {{ feature?: import('geojson').Feature, sourceFile?: string }} c
 * @returns {string[]}
 */
export function candidateDedupKeys(c) {
  const p = c?.feature?.properties || {};
  const keys = [];
  const car = normCar(firstProp(p, [
    'numero_car', 'NUMERO_CAR', 'CAR', 'car', 'cod_car', 'nu_car', 'Cod_CAR', 'cod_imovel', 'COD_IMOVEL', 'nuCAR',
  ]));
  if (car) keys.push(`car:${car}`);
  const sipra = normSipra(firstProp(p, ['cod_sipra', 'cd_sipra', 'COD_SIPRA', 'CD_SIPRA']));
  if (sipra) keys.push(`sipra:${sipra}`);
  const ide = firstProp(p, ['ide_imovel', 'IDE_IMOVEL']);
  if (ide) keys.push(`ide:${ide}`);
  const nome = normNomeAssentamento(firstProp(p, ['nome_proje', 'denominaca', 'nm_comunid', 'nome', 'name']));
  const mun = normMunNome(firstProp(p, ['municipio', 'nomMun', 'NM_MUN', 'nm_municip']));
  if (nome && mun) keys.push(`nm:${nome}|${mun}`);
  return keys;
}

function tagSourceTier(c, tier) {
  return { ...c, sourceTier: tier };
}

function significantOverlap(cShape, cWfs, minRatio = 0.32) {
  try {
    const a = turf.feature(cShape.feature.geometry);
    const b = turf.feature(cWfs.feature.geometry);
    const areaA = turf.area(a);
    const areaB = turf.area(b);
    if (!areaA || !areaB) return false;
    const inter = turf.intersect(turf.featureCollection([a, b]));
    if (!inter) return false;
    const interArea = turf.area(inter);
    const smaller = Math.min(areaA, areaB);
    return interArea / smaller >= minRatio;
  } catch (_) {
    return false;
  }
}

function shapeCandidateShadowedByWfs(shapeCand, wfsCandidates) {
  const shapeKeys = candidateDedupKeys(shapeCand);
  for (const w of wfsCandidates) {
    for (const sk of shapeKeys) {
      if (candidateDedupKeys(w).includes(sk)) return true;
    }
    const related =
      shapeCand.kind === w.kind ||
      (shapeCand.kind === 'assentamento' && (w.kind === 'assentamento' || w.kind === 'car' || w.kind === 'cefir' || w.kind === 'sigef')) ||
      ((shapeCand.kind === 'cefir' || shapeCand.kind === 'car') && (w.kind === 'cefir' || w.kind === 'car'));
    if (related && significantOverlap(shapeCand, w)) return true;
  }
  return false;
}

/**
 * Mescla candidatos dando prioridade a WFS (remoto > toggles locais > shape/).
 * Remove do shape feições já cobertas por WFS (mesmo CAR/SIPRA/nome ou sobreposição forte).
 *
 * @param {{ shape?: object[], wfsLocal?: object[], wfsRemote?: object[] }} groups
 */
export function mergeCruzamentoCandidatesWithWfsPriority(groups) {
  const shape = (groups.shape || []).map((c) => tagSourceTier(c, c.sourceTier ?? CRUZAMENTO_SOURCE_TIER.SHAPE));
  const wfsLocal = (groups.wfsLocal || []).map((c) => tagSourceTier(c, CRUZAMENTO_SOURCE_TIER.WFS_LOCAL));
  const wfsRemote = (groups.wfsRemote || []).map((c) => tagSourceTier(c, CRUZAMENTO_SOURCE_TIER.WFS_REMOTE));

  const wfsAll = [...wfsRemote, ...wfsLocal];
  const filteredShape = shape.filter((c) => !shapeCandidateShadowedByWfs(c, wfsAll));
  return [...wfsAll, ...filteredShape];
}
