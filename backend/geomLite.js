'use strict';

function walkCoords(geom, fn) {
  if (!geom?.coordinates) return;
  const t = geom.type;
  if (t === 'Point') fn(geom.coordinates);
  else if (t === 'MultiPoint' || t === 'LineString') geom.coordinates.forEach(fn);
  else if (t === 'MultiLineString' || t === 'Polygon') geom.coordinates.forEach((r) => r.forEach(fn));
  else if (t === 'MultiPolygon') geom.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
}

function geomBbox(geom) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walkCoords(geom, (c) => {
    const x = Number(c[0]);
    const y = Number(c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function pointInRing(pt, ring) {
  const x = pt[0];
  const y = pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeom(pt, geom) {
  if (!pt || !geom) return false;
  if (geom.type === 'Feature') return pointInGeom(pt, geom.geometry);
  if (geom.type === 'Point') {
    return Math.abs(Number(geom.coordinates[0]) - pt[0]) < 1e-8
      && Math.abs(Number(geom.coordinates[1]) - pt[1]) < 1e-8;
  }
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates
      : null;
  if (!polys) return false;
  return polys.some((rings) => rings?.[0] && pointInRing(pt, rings[0])
    && !rings.slice(1).some((hole) => pointInRing(pt, hole)));
}

function sampleRing(ring, max) {
  if (!ring || ring.length <= max) return ring || [];
  const step = Math.ceil(ring.length / max);
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  return out;
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringsOf(geom) {
  if (!geom) return [];
  const g = geom.type === 'Feature' ? geom.geometry : geom;
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates || [];
  if (g.type === 'MultiPolygon') return (g.coordinates || []).flat();
  if (g.type === 'LineString') return [g.coordinates];
  return [];
}

function geometriesIntersect(a, b) {
  if (!a || !b) return false;
  const ga = a.type === 'Feature' ? a.geometry : a;
  const gb = b.type === 'Feature' ? b.geometry : b;
  if (!ga || !gb) return false;
  const ba = geomBbox(ga);
  const bb = geomBbox(gb);
  if (ba && bb && (ba[2] < bb[0] || ba[0] > bb[2] || ba[3] < bb[1] || ba[1] > bb[3])) return false;
  if (ga.type === 'Point') return pointInGeom(ga.coordinates, gb);
  if (gb.type === 'Point') return pointInGeom(gb.coordinates, ga);
  let inside = false;
  walkCoords(ga, (c) => { if (!inside && pointInGeom(c, gb)) inside = true; });
  if (inside) return true;
  walkCoords(gb, (c) => { if (!inside && pointInGeom(c, ga)) inside = true; });
  if (inside) return true;
  const ra = ringsOf(ga).map((ring) => sampleRing(ring, 60));
  const rb = ringsOf(gb).map((ring) => sampleRing(ring, 60));
  for (const ringA of ra) {
    for (let i = 0; i < ringA.length - 1; i++) {
      for (const ringB of rb) {
        for (let j = 0; j < ringB.length - 1; j++) {
          if (segmentsCross(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
        }
      }
    }
  }
  return false;
}

function ringCentroid(geom) {
  let x = 0;
  let y = 0;
  let n = 0;
  walkCoords(geom, (c) => { x += Number(c[0]); y += Number(c[1]); n += 1; });
  if (!n) return null;
  return [x / n, y / n];
}

exports.geomBbox = geomBbox;
exports.pointInGeom = pointInGeom;
exports.geometriesIntersect = geometriesIntersect;
exports.ringCentroid = ringCentroid;
