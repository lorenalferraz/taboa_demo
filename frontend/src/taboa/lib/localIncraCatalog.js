/**
 * Catálogo de camadas INCRA locais (GeoJSON em backend/shape/).
 */

const ASSENTAMENTOS_STYLE = { color: '#c2410c', weight: 1.5, fillColor: '#fb923c', fillOpacity: 0.2 };

export const INCRA_LOCAL_LAYERS = [
  {
    id: 'assentamentos',
    label: 'Assentamentos (local)',
    geojson: 'assentamentos.geojson',
    style: ASSENTAMENTOS_STYLE,
    local: true,
    source: 'INCRA',
    title: 'Assentamentos',
  },
];

/** @deprecated use INCRA_LOCAL_LAYERS */
export const INCRA_WFS_LAYERS = INCRA_LOCAL_LAYERS;

export function isIncraLocalLayer(layerId) {
  return layerId === 'assentamentos';
}

export function incraLocalGeojsonFile(layerId) {
  const cfg = INCRA_LOCAL_LAYERS.find((l) => l.id === layerId);
  return cfg?.geojson || null;
}
