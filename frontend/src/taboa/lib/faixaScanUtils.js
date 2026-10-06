import * as turf from '@turf/turf';
import { normMunNome } from './region.js';

/** Agrupa feições normalizadas por município (62 IBGE BA). */
export function groupFaixaFeaturesByMunicipio(features) {
  const byKey = new Map();
  for (const feat of features || []) {
    const ibge = feat.properties?.codMun ?? feat.properties?.cd_mun ?? feat.properties?.codigo;
    const nm = feat.properties?.nomMun ?? feat.properties?.nm_mun ?? feat.properties?.NM_MUN ?? '';
    const key = ibge ? String(ibge) : normMunNome(nm);
    if (!key) continue;
    if (!byKey.has(key)) {
      byKey.set(key, {
        ibgeId: ibge != null && ibge !== '' ? Number(ibge) : null,
        munNome: feat.properties?.nomMun || feat.properties?.nm_mun || String(nm).trim() || `Município ${key}`,
        regiaoTaboa: feat.properties?._regiaoTaboa || '',
        feats: [],
      });
    }
    byKey.get(key).feats.push(feat);
  }
  const out = [];
  for (const g of byKey.values()) {
    try {
      g.munBbox = turf.bbox(turf.featureCollection(g.feats));
    } catch (_) {
      continue;
    }
    out.push(g);
  }
  out.sort((a, b) => a.munNome.localeCompare(b.munNome, 'pt-BR'));
  return out;
}
