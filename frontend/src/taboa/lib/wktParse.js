import wellknown from 'wellknown';

export function wktToGeoJSON(wkt) {
  if (!wkt || typeof wkt !== 'string') return null;
  const s = wkt.trim();
  if (!s) return null;
  try {
    if (wellknown?.parse) {
      const g = wellknown.parse(s);
      if (g && (g.coordinates || g.type === 'GeometryCollection')) return g;
    }
  } catch (_) {}
  try {
    const u = s.toUpperCase();
    if (u.startsWith('POLYGON')) {
      const m = s.match(/POLYGON\s*\(\(\s*([\d\s.,\-eE+]+)\s*\)\)/i);
      if (!m) return null;
      const ring = m[1].trim().split(',').map((ps) => {
        const p = ps.trim().split(/\s+/).map(Number);
        return [p[0], p[1]];
      }).filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
      if (ring.length < 3) return null;
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
        ring.push([ring[0][0], ring[0][1]]);
      return { type: 'Polygon', coordinates: [ring] };
    }
    if (u.startsWith('MULTIPOLYGON')) {
      const acc = [];
      let rest = s.replace(/^MULTIPOLYGON\s*\(\s*/i, '');
      while (rest.length) {
        const open = rest.indexOf('((');
        if (open < 0) break;
        let depth = 0;
        let end = -1;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '(') depth++;
          else if (rest[i] === ')') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end < 0) break;
        const chunk = rest.slice(open + 1, end);
        const m2 = chunk.match(/\(\s*([\d\s.,\-eE+]+)\s*\)/);
        if (m2) {
          const ring = m2[1].trim().split(',').map((ps) => {
            const p = ps.trim().split(/\s+/).map(Number);
            return [p[0], p[1]];
          }).filter((p) => p.length === 2 && !Number.isNaN(p[0]) && !Number.isNaN(p[1]));
          if (ring.length >= 3) {
            if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
              ring.push([ring[0][0], ring[0][1]]);
            acc.push([ring]);
          }
        }
        rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
      }
      if (acc.length === 0) return null;
      return { type: 'MultiPolygon', coordinates: acc };
    }
  } catch (_) {}
  return null;
}

export function simplifiedPointsToPolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const ring = points.map((p) => {
    const x = p?.xCoord != null ? Number(p.xCoord) : NaN;
    const y = p?.yCoord != null ? Number(p.yCoord) : NaN;
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    return [x, y];
  }).filter(Boolean);
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { type: 'Polygon', coordinates: [ring] };
}
