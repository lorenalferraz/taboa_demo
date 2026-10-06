/**
 * Bbox efetiva = interseção filtro (UF/município IBGE) ∩ extensão visível do mapa.
 */

/** Zoom mínimo para carregar polígonos locais no cruzamento. */
export const LOCAL_LAYER_MIN_ZOOM = 8;
export const WFS_MIN_ZOOM = LOCAL_LAYER_MIN_ZOOM;

/**
 * @param {import('leaflet').Map} map
 * @returns {number[]|null} [west, south, east, north]
 */
export function mapBoundsToBbox(map) {
  if (!map) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]|null}
 */
export function intersectBboxes(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return null;
  const west = Math.max(a[0], b[0]);
  const south = Math.max(a[1], b[1]);
  const east = Math.min(a[2], b[2]);
  const north = Math.min(a[3], b[3]);
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

/** Chave de cache por bbox arredondada. */
export function bboxCacheKey(bbox, precision = 3) {
  return (bbox || []).map((n) => Number(n).toFixed(precision)).join(',');
}

/**
 * Combina filtro administrativo com área visível do mapa.
 * @param {import('leaflet').Map|null} map
 * @param {{ bbox: number[]|null, label: string, uf: string, municipio: string, ibgeId: number|null }} filterCtx
 */
export function resolveEffectiveLocalContext(map, filterCtx) {
  const base = filterCtx || {};
  if (!base.bbox || !base.uf) {
    return {
      ...base,
      effectiveBbox: null,
      effectiveLabel: base.label || '',
      zoomOk: false,
      outOfView: false,
    };
  }

  if (!map) {
    return {
      ...base,
      effectiveBbox: base.bbox,
      effectiveLabel: base.label,
      zoomOk: true,
      outOfView: false,
    };
  }

  const zoom = map.getZoom();
  if (zoom < LOCAL_LAYER_MIN_ZOOM) {
    return {
      ...base,
      effectiveBbox: null,
      effectiveLabel: base.label,
      zoomOk: false,
      outOfView: false,
      zoom,
    };
  }

  const visible = mapBoundsToBbox(map);
  const effective = intersectBboxes(base.bbox, visible);
  if (!effective) {
    return {
      ...base,
      effectiveBbox: null,
      effectiveLabel: base.label,
      zoomOk: true,
      outOfView: true,
      zoom,
    };
  }

  const areaLabel = base.municipio
    ? `área visível · ${base.municipio} (${base.uf})`
    : `área visível · ${base.label}`;

  return {
    ...base,
    effectiveBbox: effective,
    effectiveLabel: areaLabel,
    zoomOk: true,
    outOfView: false,
    zoom,
  };
}

export const resolveEffectiveWfsContext = resolveEffectiveLocalContext;
