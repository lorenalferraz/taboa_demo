import proj4 from 'proj4';

/** CRS geográficos usados no Brasil — não reprojetar como UTM. */
export const GEOGRAPHIC_CRS = new Set(['EPSG:4326', 'EPSG:4674', 'EPSG:4979']);

export function geomCenter(geojson) {
  if (!geojson || !geojson.coordinates) return null;
  let lonSum = 0;
  let latSum = 0;
  let n = 0;
  const visit = (c) => {
    if (typeof c[0] === 'number') { lonSum += c[0]; latSum += c[1]; n++; }
    else c.forEach(visit);
  };
  visit(geojson.coordinates);
  return n ? [latSum / n, lonSum / n] : null;
}

export function parseCrsFromGeoJSON(g) {
  const c = g?.crs?.properties?.name || g?.crs?.name || '';
  if (/CRS84/i.test(c)) return 'EPSG:4326';
  const m = c.match(/EPSG[:\s]*(\d+)/i) || c.match(/(\d{4,5})/);
  return m ? 'EPSG:' + m[1] : null;
}

export function needsReprojectToWgs84(sourceCrs) {
  return Boolean(sourceCrs && !GEOGRAPHIC_CRS.has(sourceCrs));
}

export function sampleFirstCoordinate(g) {
  const coords = g?.features?.[0]?.geometry?.coordinates;
  if (!coords) return null;
  function dig(c) {
    if (Array.isArray(c) && typeof c[0] === 'number') return c;
    if (Array.isArray(c) && c.length) return dig(c[0]);
    return null;
  }
  return dig(coords);
}

export function inferCrsFromCoordinates(g) {
  const s = sampleFirstCoordinate(g);
  if (!s) return null;
  const [x, y] = s;
  if (x >= -180 && x <= 180 && y >= -90 && y <= 90) return 'EPSG:4326';
  if (x >= 100000 && x <= 1000000 && y >= 7000000 && y <= 9500000)
    return 'EPSG:' + (31978 + (y > 8500000 ? 6 : y > 8000000 ? 5 : y > 7500000 ? 4 : 3));
  return null;
}

export function normalizeToFeatureCollection(raw) {
  if (!raw) return null;
  let geojson = raw;
  if (geojson.type === 'Feature') geojson = { type: 'FeatureCollection', features: [geojson] };
  else if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
    geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: geojson, properties: {} }] };
  }
  if (!geojson.features?.length) return null;
  return geojson;
}

/** Normaliza FC e reprojeta só quando o CRS declarado/inferido é projetado (UTM etc.). */
export function prepareGeoJsonForDisplay(raw) {
  const geojson = normalizeToFeatureCollection(raw);
  if (!geojson) return null;
  const sourceCrs = parseCrsFromGeoJSON(geojson) || inferCrsFromCoordinates(geojson);
  if (needsReprojectToWgs84(sourceCrs)) return reprojectToWGS84(geojson, sourceCrs);
  return geojson;
}

export function reprojectToWGS84(geojson, sourceCrs) {
  if (!geojson?.features) return geojson;
  const fromCrs = sourceCrs || parseCrsFromGeoJSON(geojson) || 'EPSG:31984';
  if (GEOGRAPHIC_CRS.has(fromCrs)) return geojson;
  function transformCoord(c) {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      try {
        const p = proj4(fromCrs, 'EPSG:4326', [c[0], c[1]]);
        return Array.isArray(p) ? p : [p.x, p.y];
      } catch (_) { return c; }
    }
    return c.map(transformCoord);
  }
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => {
      const fc = JSON.parse(JSON.stringify(f));
      if (fc.geometry?.coordinates) fc.geometry.coordinates = transformCoord(fc.geometry.coordinates);
      return fc;
    })
  };
}
