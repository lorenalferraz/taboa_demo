/**
 * Área de análise da Consulta: buffer do ponto com a área da propriedade, polígono intacto.
 */
import * as turf from '@turf/turf';

/** Lê hectares digitados com vírgula ou ponto. */
export function parseHectares(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Raio em metros de um círculo com a mesma área, em hectares. */
export function bufferMetersFromHectares(ha) {
  const n = Number(ha);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.sqrt((n * 10000) / Math.PI);
}

/**
 * @param {{ kind: 'point'|'polygon', feature: object, lat?: number, lng?: number }} geom
 * @param {{ hectares?: number|null }} [opts]
 * @returns {{ ok: true, mode: 'buffer'|'poligono', aoi: object, point: object|null, areaHa: number, bufferMeters: number|null } | { ok: false, error: string }}
 */
export function buildConsultaAoi(geom, opts = {}) {
  if (!geom?.kind || !geom.feature) {
    return { ok: false, error: 'Defina um ponto ou um polígono para consultar.' };
  }
  try {
    if (geom.kind === 'point') {
      const lng = Number(geom.lng ?? geom.feature.geometry?.coordinates?.[0]);
      const lat = Number(geom.lat ?? geom.feature.geometry?.coordinates?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, error: 'Coordenadas inválidas.' };
      }
      const hectares = parseHectares(opts.hectares);
      if (hectares == null) {
        return { ok: false, error: 'Informe o tamanho da propriedade em hectares para calcular o buffer.' };
      }
      let bufferMeters = bufferMetersFromHectares(hectares);
      const point = turf.point([lng, lat]);
      let aoi = turf.buffer(point, bufferMeters, { units: 'meters' });
      if (!aoi?.geometry) return { ok: false, error: 'Não foi possível gerar o buffer a partir do tamanho da propriedade.' };
      const gotHa = turf.area(aoi) / 10000;
      if (gotHa > 0) {
        bufferMeters *= Math.sqrt(hectares / gotHa);
        aoi = turf.buffer(point, bufferMeters, { units: 'meters' });
        if (!aoi?.geometry) return { ok: false, error: 'Não foi possível gerar o buffer a partir do tamanho da propriedade.' };
      }
      return {
        ok: true,
        mode: 'buffer',
        aoi,
        point,
        areaHa: turf.area(aoi) / 10000,
        bufferMeters,
      };
    }
    const aoi = geom.feature.type === 'Feature' ? geom.feature : turf.feature(geom.feature);
    const t = aoi.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') {
      return { ok: false, error: 'A geometria precisa ser um polígono.' };
    }
    return {
      ok: true,
      mode: 'poligono',
      aoi,
      point: turf.centroid(aoi),
      areaHa: turf.area(aoi) / 10000,
      bufferMeters: null,
    };
  } catch (e) {
    return { ok: false, error: e.message || 'Geometria inválida.' };
  }
}
