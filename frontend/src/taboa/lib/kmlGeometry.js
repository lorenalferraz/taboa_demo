/**
 * KML da aba Consulta: Point ou Polygon. LineString e KMZ são rejeitados.
 * Aceita vários CRS (WGS84, SIRGAS 2000, SAD69, UTM, Web Mercator…) e converte para WGS84.
 */
import * as turf from '@turf/turf';
import { detectCrsFromKmlText, pairsToWgs84, crsDisplayName } from './kmlCrs.js';

function parseCoordTriplets(coordText) {
  const out = [];
  const chunks = String(coordText || '')
    .trim()
    .split(/[\s\r\n\t]+/)
    .filter(Boolean);
  for (const ch of chunks) {
    const parts = ch.split(',');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

function parsePosList(text) {
  const nums = String(text || '')
    .trim()
    .split(/[\s,;]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function placemarkLabel(pm) {
  const names = pm.getElementsByTagName('name');
  return names[0]?.textContent?.trim() || '';
}

function localName(el) {
  return String(el?.localName || el?.tagName || '').replace(/^.*:/, '');
}

function hasLineGeometry(doc) {
  const all = doc.getElementsByTagName('*');
  for (const el of all) {
    const n = localName(el).toLowerCase();
    if (n === 'linestring' || n === 'multilinestring' || n === 'track') return true;
  }
  return false;
}

function findByLocalName(root, name) {
  const want = String(name).toLowerCase();
  const out = [];
  const all = root.getElementsByTagName('*');
  for (const el of all) {
    if (localName(el).toLowerCase() === want) out.push(el);
  }
  return out;
}

function coordsFromElement(el) {
  if (!el) return [];
  const coordsEl = findByLocalName(el, 'coordinates')[0];
  if (coordsEl) return parseCoordTriplets(coordsEl.textContent);
  const pos = findByLocalName(el, 'pos')[0];
  if (pos) return parsePosList(pos.textContent);
  const posList = findByLocalName(el, 'posList')[0] || findByLocalName(el, 'poslist')[0];
  if (posList) return parsePosList(posList.textContent);
  return [];
}

function polygonPairsFromElement(polyEl) {
  const rings = findByLocalName(polyEl, 'LinearRing');
  const outerEl = rings[0] || polyEl;
  const outer = coordsFromElement(outerEl);
  if (outer.length < 3) return null;
  const holes = [];
  for (let i = 1; i < rings.length; i++) {
    const h = coordsFromElement(rings[i]);
    if (h.length >= 3) holes.push(h);
  }
  return { outer, holes };
}

/**
 * @param {string} text
 * @returns {{
 *   ok: true,
 *   kind: 'point'|'polygon',
 *   feature: object,
 *   lat?: number,
 *   lng?: number,
 *   name?: string,
 *   crsFrom?: string,
 *   crsLabel?: string,
 * } | { ok: false, error: string }}
 */
export function extractConsultaGeometryFromKml(text) {
  if (text == null || typeof text !== 'string') {
    return { ok: false, error: 'Arquivo vazio.' };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Arquivo vazio.' };
  if (trimmed.charCodeAt(0) === 0x50 && trimmed.charCodeAt(1) === 0x4b) {
    return { ok: false, error: 'KMZ não é aceito. Exporte como KML.' };
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(trimmed, 'application/xml');
  } catch (_) {
    return { ok: false, error: 'XML inválido.' };
  }
  if (doc.querySelector('parsererror')) {
    return { ok: false, error: 'Não foi possível interpretar o XML.' };
  }

  if (hasLineGeometry(doc)) {
    return { ok: false, error: 'KML com linha não é aceito. Envie ponto ou polígono.' };
  }

  const declaredCrs = detectCrsFromKmlText(trimmed, doc);
  const placemarks = findByLocalName(doc, 'Placemark');
  const targets = placemarks.length ? placemarks : [doc.documentElement];

  let pointRaw = null;
  let polyRaw = null;
  let name = '';

  for (const pm of targets) {
    const label = pm.getElementsByTagName ? placemarkLabel(pm) : '';
    const polys = findByLocalName(pm, 'Polygon');
    if (polys.length && !polyRaw) {
      const rings = polygonPairsFromElement(polys[0]);
      if (rings) {
        polyRaw = rings;
        name = label || name;
      }
    }
    const points = findByLocalName(pm, 'Point');
    if (points.length && !pointRaw) {
      const trip = coordsFromElement(points[0]);
      if (trip.length) {
        pointRaw = trip[0];
        if (!name) name = label;
      }
    }
  }

  if (polyRaw) {
    const all = [...polyRaw.outer, ...polyRaw.holes.flat()];
    const converted = pairsToWgs84(all, declaredCrs);
    if (!converted.ok) return converted;
    let offset = 0;
    const outer = closeRing(converted.pairs.slice(offset, offset + polyRaw.outer.length));
    offset += polyRaw.outer.length;
    const holes = [];
    for (const hole of polyRaw.holes) {
      holes.push(closeRing(converted.pairs.slice(offset, offset + hole.length)));
      offset += hole.length;
    }
    if (outer.length < 4) {
      return { ok: false, error: 'Polígono do KML ficou inválido após a conversão.' };
    }
    try {
      const feature = turf.polygon([outer, ...holes]);
      return {
        ok: true,
        kind: 'polygon',
        feature,
        name: name || undefined,
        crsFrom: converted.crsFrom,
        crsLabel: crsDisplayName(converted.crsFrom),
      };
    } catch (_) {
      return { ok: false, error: 'Polígono do KML ficou inválido após a conversão.' };
    }
  }

  if (pointRaw) {
    const converted = pairsToWgs84([pointRaw], declaredCrs);
    if (!converted.ok) return converted;
    const [lng, lat] = converted.pairs[0];
    return {
      ok: true,
      kind: 'point',
      feature: turf.point([lng, lat]),
      lat,
      lng,
      name: name || undefined,
      crsFrom: converted.crsFrom,
      crsLabel: crsDisplayName(converted.crsFrom),
    };
  }

  return { ok: false, error: 'Nenhum ponto ou polígono encontrado no KML.' };
}
