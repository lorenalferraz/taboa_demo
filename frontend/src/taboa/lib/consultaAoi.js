/**
 * Área de análise da Consulta: buffer de 500 m em ponto, polígono intacto.
 */
import * as turf from '@turf/turf';

export const CONSULTA_BUFFER_METERS = 500;

/**
 * @param {{ kind: 'point'|'polygon', feature: object, lat?: number, lng?: number }} geom
 * @returns {{ ok: true, mode: 'buffer'|'poligono', aoi: object, point: object|null, areaHa: number } | { ok: false, error: string }}
 */
export function buildConsultaAoi(geom) {
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
      const point = turf.point([lng, lat]);
      const aoi = turf.buffer(point, CONSULTA_BUFFER_METERS, { units: 'meters' });
      if (!aoi?.geometry) return { ok: false, error: 'Não foi possível gerar o buffer de 500 m.' };
      return {
        ok: true,
        mode: 'buffer',
        aoi,
        point,
        areaHa: turf.area(aoi) / 10000,
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
    };
  } catch (e) {
    return { ok: false, error: e.message || 'Geometria inválida.' };
  }
}
