/**
 * Cruzamento tipo MapBiomas «Imóveis»: interseção geométrica entre o recorte do alerta
 * e polígonos CEFIR / imóvel rural / certificado privado carregados em shape/.
 */
import * as turf from '@turf/turf';
import { featureNomePublico, formatCefirCarFromFeatureProperties } from './region.js';
import { humanKindLabel } from './cruzamentoPrioridade.js';

const CAR_KINDS = new Set(['car', 'cefir', 'imovel_rural', 'certificado_privado']);

/**
 * @param {{ kind?: string }[]} candidates
 */
export function filterPropertyCandidatesForCar(candidates) {
  if (!candidates?.length) return [];
  return candidates.filter((c) => c && CAR_KINDS.has(c.kind));
}

/**
 * @param {import('geojson').Geometry|import('geojson').Feature|null|undefined} clipGeomOrFeature — interseção alerta × AOI (ou geometria do alerta)
 * @param {object[]} propertyCandidates — entradas de buildCruzamentoCandidates filtradas
 * @returns {{ carText: string, areaIntersecHa: number, kindLabel: string, sourceFile: string }[]}
 */
export function linkedImoveisForAlertClip(clipGeomOrFeature, propertyCandidates) {
  if (!clipGeomOrFeature || !propertyCandidates?.length) return [];

  let clipFeat = null;
  try {
    if (clipGeomOrFeature.type === 'Feature') clipFeat = clipGeomOrFeature;
    else clipFeat = turf.feature(clipGeomOrFeature);
  } catch (_) {
    return [];
  }

  let clipBBox = null;
  try {
    clipBBox = turf.bbox(clipFeat);
  } catch (_) {}

  /** @type {Map<string, { carText: string, areaIntersecHa: number, kindLabel: string, sourceFile: string }>} */
  const byKey = new Map();

  for (const c of propertyCandidates) {
    const g = c.feature?.geometry;
    if (!g) continue;
    try {
      const pf = turf.feature(g);
      if (clipBBox) {
        const fb = turf.bbox(pf);
        if (clipBBox[2] < fb[0] || clipBBox[0] > fb[2] || clipBBox[3] < fb[1] || clipBBox[1] > fb[3]) continue;
      }
      if (!turf.booleanIntersects(clipFeat, pf)) continue;
      const inter = turf.intersect(clipFeat, pf);
      if (!inter) continue;
      const ha = turf.area(inter) / 10000;
      if (!Number.isFinite(ha) || ha < 1e-8) continue;

      const props = c.feature.properties || {};
      const carFromProp = formatCefirCarFromFeatureProperties(props);
      const pub = featureNomePublico(c.feature, c.featureIndex ?? 0);
      const carText =
        carFromProp ||
        `SICAR — ${humanKindLabel(c.kind)} · ${pub}`;

      const kindLabel = humanKindLabel(c.kind);
      const sourceFile = c.sourceFile || '';
      const prev = byKey.get(carText);
      if (prev) prev.areaIntersecHa += ha;
      else byKey.set(carText, { carText, areaIntersecHa: ha, kindLabel, sourceFile });
    } catch (_) {}
  }

  const list = [...byKey.values()].sort((a, b) => b.areaIntersecHa - a.areaIntersecHa);
  for (const row of list) {
    row.areaIntersecHa = Math.round(row.areaIntersecHa * 10000) / 10000;
  }
  return list;
}
