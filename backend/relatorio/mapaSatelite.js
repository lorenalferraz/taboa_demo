/**
 * Mapa de satélite da área de consulta (Esri World Imagery + sobreposição).
 */
const sharp = require('sharp');

const TILE = 256;
const MAX_TILES = 8;
const TARGET_LONG_SIDE = 1400;
const PAD_FRAC = 0.18;
const MIN_PAD_DEG = 0.0012;
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function lngToTileX(lng, z) {
  return ((lng + 180) / 360) * (2 ** z);
}

function latToTileY(lat, z) {
  const s = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.min(0.9999, Math.max(-0.9999, s));
  return (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * (2 ** z);
}

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

function padBbox(b) {
  const dx = Math.max((b[2] - b[0]) * PAD_FRAC, MIN_PAD_DEG);
  const dy = Math.max((b[3] - b[1]) * PAD_FRAC, MIN_PAD_DEG);
  return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
}

function pointBbox(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lng = Number(point[0]);
  const lat = Number(point[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat, lng, lat];
}

/** Área da consulta e propriedade entram juntas, com a mesma margem nos dois lados. */
function focusBbox(aoi, point, frames) {
  return unionBboxes([
    geomBbox(asGeom(aoi)),
    pointBbox(point),
    ...(frames || []).map((g) => geomBbox(asGeom(g))),
  ]);
}

function unionBboxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((acc, b) => [
    Math.min(acc[0], b[0]),
    Math.min(acc[1], b[1]),
    Math.max(acc[2], b[2]),
    Math.max(acc[3], b[3]),
  ]);
}

function asGeom(g) {
  if (!g) return null;
  if (g.type === 'Feature') return g.geometry || null;
  if (g.geometry?.type) return g.geometry;
  return g.type ? g : null;
}

function toLandscapeBbox(b, aspect = 2.15) {
  const midLat = (b[1] + b[3]) / 2;
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 0.2);
  const widthM = Math.max((b[2] - b[0]) * 111320 * cos, 40);
  const heightM = Math.max((b[3] - b[1]) * 110540, 40);
  const current = widthM / heightM;
  const out = b.slice();
  if (current < aspect) {
    const needW = heightM * aspect;
    const extra = ((needW - widthM) / 2) / (111320 * cos);
    out[0] -= extra;
    out[2] += extra;
  } else if (current > aspect) {
    const needH = widthM / aspect;
    const extra = ((needH - heightM) / 2) / 110540;
    out[1] -= extra;
    out[3] += extra;
  }
  return out;
}

function zoomForBbox(bbox) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthM = Math.max((bbox[2] - bbox[0]) * 111320 * Math.cos((midLat * Math.PI) / 180), 40);
  const heightM = Math.max((bbox[3] - bbox[1]) * 110540, 40);
  const meters = Math.max(widthM, heightM);
  const cos = Math.max(Math.cos((midLat * Math.PI) / 180), 0.2);
  const z = Math.log2((156543.03392 * cos * TARGET_LONG_SIDE) / meters);
  return Math.max(9, Math.min(18, Math.floor(z)));
}

function tileRange(bbox, z) {
  const max = 2 ** z;
  let x0 = Math.floor(lngToTileX(bbox[0], z));
  let x1 = Math.floor(lngToTileX(bbox[2], z));
  let y0 = Math.floor(latToTileY(bbox[3], z));
  let y1 = Math.floor(latToTileY(bbox[1], z));
  x0 = Math.max(0, Math.min(max - 1, x0));
  x1 = Math.max(0, Math.min(max - 1, x1));
  y0 = Math.max(0, Math.min(max - 1, y0));
  y1 = Math.max(0, Math.min(max - 1, y1));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  return { z, x0, x1, y0, y1, nx: x1 - x0 + 1, ny: y1 - y0 + 1 };
}

function fitTileRange(bbox) {
  let z = zoomForBbox(bbox);
  let range = tileRange(bbox, z);
  while ((range.nx > MAX_TILES || range.ny > MAX_TILES) && z > 8) {
    z -= 1;
    range = tileRange(bbox, z);
  }
  return range;
}

async function fetchTile(z, x, y) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'TaboaConsulta/1.0 (relatorio)' },
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y} HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function ringsToPoints(rings, toPx) {
  return (rings || []).map((ring) => ring.map((c) => {
    const [x, y] = toPx(c[0], c[1]);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' '));
}

function geomToSvg(geom, toPx, fill, stroke, opts = {}) {
  if (!geom) return '';
  const fillOpacity = opts.fillOpacity ?? 0.32;
  const strokeWidth = opts.strokeWidth ?? 2.4;
  const t = geom.type;
  const polys = t === 'Polygon' ? [geom.coordinates]
    : t === 'MultiPolygon' ? geom.coordinates
      : null;
  if (!polys) return '';
  return polys.map((rings) => {
    const pts = ringsToPoints(rings, toPx);
    if (!pts[0]) return '';
    return `<polygon points="${pts[0]}" fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" fill-rule="evenodd"/>`;
  }).join('');
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function legendSvg(w, h, items) {
  const rows = (items || []).slice(0, 8);
  if (!rows.length) return '';
  const rowH = 16;
  const legendH = 10 + rows.length * rowH;
  const legendW = 228;
  const lx = 12;
  const ly = h - legendH - 14;
  const body = rows.map((it, i) => {
    const y = ly + 8 + i * rowH;
    return `<rect x="${lx + 10}" y="${y}" width="16" height="10" fill="${it.fill}" fill-opacity="0.55" stroke="${it.stroke}" stroke-width="1.4"/>
    <text x="${lx + 32}" y="${y + 9}" fill="#f8fafc" font-size="10" font-family="Helvetica, Arial, sans-serif">${escapeXml(it.label)}</text>`;
  }).join('');
  return `<rect x="${lx}" y="${ly}" width="${legendW}" height="${legendH}" rx="6" fill="#0f172a" fill-opacity="0.72"/>${body}`;
}

function niceStep(span, target = 4) {
  const s = Math.max(Number(span) || 0, 1e-8);
  const raw = s / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return step * mag;
}

function ticks(min, max, step) {
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(v);
  return out;
}

function fmtDeg(v, isLat) {
  const hem = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  return `${Math.abs(v).toFixed(2).replace('.', ',')}° ${hem}`;
}

function niceDistance(meters) {
  const candidates = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000];
  const target = Math.max(meters, 1) * 0.28;
  return candidates.reduce((best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best));
}

function coordGridSvg(mapW, mapH, bbox, toPx, frame) {
  if (!bbox) return '';
  const ox = frame.left;
  const oy = frame.top;
  const [west, south, east, north] = bbox;
  const lngStep = niceStep(east - west, 4);
  const latStep = niceStep(north - south, 4);
  const lngs = ticks(west, east, lngStep);
  const lats = ticks(south, north, latStep);
  const lines = [];
  const labels = [];
  const navy = '#002848';
  const font = 'Helvetica, Arial, sans-serif';

  for (const lng of lngs) {
    const [xN] = toPx(lng, north);
    const [xS, yS] = toPx(lng, south);
    const x = ox + xN;
    if (xN < 8 || xN > mapW - 8) continue;
    lines.push(`<line x1="${x.toFixed(1)}" y1="${oy.toFixed(1)}" x2="${(ox + xS).toFixed(1)}" y2="${(oy + yS).toFixed(1)}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.9"/>`);
    const label = escapeXml(fmtDeg(lng, false));
    labels.push(`<text x="${x.toFixed(1)}" y="${(oy - 7).toFixed(1)}" fill="${navy}" font-size="9" font-family="${font}" text-anchor="middle">${label}</text>`);
    labels.push(`<text x="${x.toFixed(1)}" y="${(oy + mapH + 14).toFixed(1)}" fill="${navy}" font-size="9" font-family="${font}" text-anchor="middle">${label}</text>`);
  }

  for (const lat of lats) {
    const [xW, yW] = toPx(west, lat);
    const [xE] = toPx(east, lat);
    if (yW < 10 || yW > mapH - 10) continue;
    const y = oy + yW;
    lines.push(`<line x1="${(ox + xW).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(ox + xE).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.9"/>`);
    const label = escapeXml(fmtDeg(lat, true));
    const lx = (frame.left / 2).toFixed(1);
    const rx = (ox + mapW + frame.right / 2).toFixed(1);
    const yf = y.toFixed(1);
    labels.push(`<text transform="rotate(-90 ${lx} ${yf})" x="${lx}" y="${yf}" fill="${navy}" font-size="9" font-family="${font}" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
    labels.push(`<text transform="rotate(-90 ${rx} ${yf})" x="${rx}" y="${yf}" fill="${navy}" font-size="9" font-family="${font}" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
  }

  const border = `<rect x="${ox}" y="${oy}" width="${mapW}" height="${mapH}" fill="none" stroke="${navy}" stroke-width="1.1"/>`;
  return `<g>${lines.join('')}${border}${labels.join('')}</g>`;
}

function compassSvg(w) {
  const cx = w - 48;
  const cy = 48;
  return `<g transform="translate(${cx},${cy})">
    <circle r="26" fill="#ffffff" fill-opacity="0.9" stroke="#002848" stroke-width="1.4"/>
    <polygon points="0,-20 5.5,2 0,6 -5.5,2" fill="#002848"/>
    <polygon points="0,20 5.5,-2 0,-6 -5.5,-2" fill="#94a3b8"/>
    <polygon points="20,0 -2,5.5 -6,0 -2,-5.5" fill="#cbd5e1"/>
    <polygon points="-20,0 2,5.5 6,0 2,-5.5" fill="#cbd5e1"/>
    <circle r="3" fill="#e08818"/>
    <text y="-30" fill="#002848" font-size="11" font-weight="700" font-family="Helvetica, Arial, sans-serif" text-anchor="middle">N</text>
  </g>`;
}

function scaleBarSvg(w, h, bbox) {
  if (!bbox) return '';
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthM = Math.max((bbox[2] - bbox[0]) * 111320 * Math.cos((midLat * Math.PI) / 180), 1);
  const dist = niceDistance(widthM);
  const px = Math.max(36, Math.min(w * 0.42, (dist / widthM) * w));
  const label = dist >= 1000 ? `${(dist / 1000).toString().replace('.', ',')} km` : `${dist} m`;
  const x = w - px - 18;
  const y = h - 28;
  const mid = x + px / 2;
  return `<g>
    <rect x="${x - 8}" y="${y - 16}" width="${px + 16}" height="28" rx="4" fill="#0f172a" fill-opacity="0.62"/>
    <line x1="${x}" y1="${y}" x2="${x + px}" y2="${y}" stroke="#ffffff" stroke-width="2.4"/>
    <line x1="${x}" y1="${y - 5}" x2="${x}" y2="${y + 5}" stroke="#ffffff" stroke-width="2"/>
    <line x1="${x + px}" y1="${y - 5}" x2="${x + px}" y2="${y + 5}" stroke="#ffffff" stroke-width="2"/>
    <line x1="${mid}" y1="${y - 3}" x2="${mid}" y2="${y + 3}" stroke="#ffffff" stroke-width="1.4"/>
    <text x="${mid}" y="${y - 8}" fill="#ffffff" font-size="10" font-family="Helvetica, Arial, sans-serif" text-anchor="middle">${label}</text>
  </g>`;
}

function buildOverlaySvg(mapW, mapH, toPx, aoi, clips, point, bbox, overlays, frame) {
  const W = mapW + frame.left + frame.right;
  const H = mapH + frame.top + frame.bottom;
  const grid = coordGridSvg(mapW, mapH, bbox, toPx, frame);
  const overlaySvg = (overlays || []).map((o) => {
    const g = o?.geom?.type === 'Feature' ? o.geom.geometry : o.geom;
    return geomToSvg(g, toPx, o.fill || '#f59e0b', o.stroke || '#b45309', {
      fillOpacity: 0.18,
      strokeWidth: 3,
    });
  }).join('');
  const clipSvg = (clips || []).slice(0, 40).map((g) => geomToSvg(g, toPx, '#ef4444', '#fecaca')).join('');
  const aoiSvg = geomToSvg(aoi, toPx, '#38bdf8', '#7dd3fc');
  let pin = '';
  if (point && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) {
    const [x, y] = toPx(Number(point[0]), Number(point[1]));
    pin = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="#fff" stroke="#0ea5e9" stroke-width="2.2"/>`;
  }
  const legendItems = [
    { fill: '#38bdf8', stroke: '#7dd3fc', label: 'Área de análise' },
  ];
  if (clips?.length) legendItems.push({ fill: '#ef4444', stroke: '#ef4444', label: 'Alerta MapBiomas' });
  const seen = new Set();
  for (const o of overlays || []) {
    const key = o.legend || o.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    legendItems.push({ fill: o.fill, stroke: o.stroke, label: o.legend || o.id });
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="mapFrame"><rect x="0" y="0" width="${mapW}" height="${mapH}"/></clipPath>
  </defs>
  ${grid}
  <g transform="translate(${frame.left},${frame.top})">
    <g clip-path="url(#mapFrame)">
      ${overlaySvg}
      ${aoiSvg}
      ${clipSvg}
      ${pin}
    </g>
    ${compassSvg(mapW)}
    ${scaleBarSvg(mapW, mapH, bbox)}
    ${legendSvg(mapW, mapH, legendItems)}
  </g>
</svg>`;
}

function geomPolys(geom) {
  const g = geom?.type === 'Feature' ? geom.geometry : geom;
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

function decimateRing(pts, max = 360) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out.length && (out[0][0] !== pts[pts.length - 1][0] || out[0][1] !== pts[pts.length - 1][1])) {
    out.push(pts[pts.length - 1]);
  }
  return out;
}

function shapeFromGeom(geom, toPx, scale, fill, stroke) {
  const shapes = [];
  for (const rings of geomPolys(geom)) {
    const scaled = [];
    for (const ring of rings || []) {
      const pts = [];
      for (const c of ring || []) {
        const [x, y] = toPx(Number(c[0]), Number(c[1]));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        pts.push([x * scale, y * scale]);
      }
      const slim = decimateRing(pts);
      if (slim.length >= 3) scaled.push(slim);
    }
    if (scaled.length) shapes.push({ rings: scaled, fill, stroke });
  }
  return shapes;
}

/**
 * @param {{ aoi?: object, clips?: object[], point?: number[], overlays?: object[], frameGeom?: object, frameGeoms?: object[] }} opts
 * @returns {Promise<{ png: Buffer, width: number, height: number, shapes?: object[], pin?: {x:number,y:number}, legend?: object[] } | null>}
 */
async function renderSatelliteMap(opts = {}) {
  const aoi = opts.aoi?.type ? opts.aoi : opts.aoi?.geometry || opts.aoi;
  const clips = (opts.clips || [])
    .map((c) => (c?.type === 'Feature' ? c.geometry : c))
    .filter((g) => g?.type);
  const overlays = (opts.overlays || []).map((o) => ({
    ...o,
    geom: o.geom?.type === 'Feature' ? o.geom.geometry : o.geom,
  })).filter((o) => o.geom?.type);
  const frameList = [
    ...(Array.isArray(opts.frameGeoms) ? opts.frameGeoms : []),
    ...(opts.frameGeom ? [opts.frameGeom] : []),
  ].map(asGeom).filter((g) => g?.type);
  const raw = focusBbox(aoi, opts.point, frameList);
  if (!raw) return null;
  const bbox = toLandscapeBbox(padBbox(raw));
  const range = fitTileRange(bbox);
  const { z, x0, x1, y0, y1, nx, ny } = range;
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) jobs.push({ x, y });
  }
  const tiles = await Promise.all(jobs.map(async (t) => {
    const input = await fetchTile(z, t.x, t.y);
    return { input, left: (t.x - x0) * TILE, top: (t.y - y0) * TILE };
  }));
  const fullW = nx * TILE;
  const fullH = ny * TILE;
  const mosaic = await sharp({
    create: { width: fullW, height: fullH, channels: 3, background: { r: 18, g: 18, b: 18 } },
  }).composite(tiles).jpeg({ quality: 90 }).toBuffer();

  const pxLeft = (lngToTileX(bbox[0], z) - x0) * TILE;
  const pxRight = (lngToTileX(bbox[2], z) - x0) * TILE;
  const pxTop = (latToTileY(bbox[3], z) - y0) * TILE;
  const pxBottom = (latToTileY(bbox[1], z) - y0) * TILE;
  let left = Math.max(0, Math.floor(Math.min(pxLeft, pxRight)));
  let top = Math.max(0, Math.floor(Math.min(pxTop, pxBottom)));
  let cropW = Math.min(fullW - left, Math.ceil(Math.abs(pxRight - pxLeft)));
  let cropH = Math.min(fullH - top, Math.ceil(Math.abs(pxBottom - pxTop)));
  cropW = Math.max(32, cropW);
  cropH = Math.max(32, cropH);
  if (left + cropW > fullW) left = Math.max(0, fullW - cropW);
  if (top + cropH > fullH) top = Math.max(0, fullH - cropH);

  const cropped = await sharp(mosaic).extract({ left, top, width: cropW, height: cropH }).jpeg({ quality: 86 }).toBuffer();

  const toPx = (lng, lat) => [
    (lngToTileX(lng, z) - x0) * TILE - left,
    (latToTileY(lat, z) - y0) * TILE - top,
  ];
  const long = Math.max(cropW, cropH);
  const scale = long > TARGET_LONG_SIDE ? TARGET_LONG_SIDE / long : 1;
  const outW = Math.round(cropW * scale);
  const outH = Math.round(cropH * scale);
  let pipeline = sharp(cropped);
  if (scale !== 1) pipeline = pipeline.resize(outW, outH);
  const jpeg = await pipeline.jpeg({ quality: 84 }).toBuffer();

  const shapes = [];
  const legend = [];
  const seenLegend = new Set();
  // A legenda só lista o que tem contorno visível no quadro: um polígono que
  // cobre o mapa inteiro tem a borda fora da imagem e não aparece.
  const segmentInFrame = (a, b) => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const edges = [[-dx, a[0]], [dx, outW - a[0]], [-dy, a[1]], [dy, outH - a[1]]];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return false;
        continue;
      }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  const inFrame = (shape) => shape.rings.some((ring) => {
    for (let i = 0; i < ring.length; i++) {
      if (segmentInFrame(ring[i], ring[(i + 1) % ring.length])) return true;
    }
    return false;
  });
  const push = (geom, fill, stroke, label) => {
    const next = shapeFromGeom(geom, toPx, scale, fill, stroke);
    if (!next.length) return;
    shapes.push(...next);
    if (label && !seenLegend.has(label) && next.some(inFrame)) {
      seenLegend.add(label);
      legend.push({ fill, stroke, label });
    }
  };
  for (const o of overlays) {
    push(o.geom, o.fill || '#f59e0b', o.stroke || '#b45309', o.legend || o.id);
  }
  for (const clip of clips.slice(0, 40)) {
    push(clip, '#ef4444', '#ef4444', 'Alerta MapBiomas');
  }
  push(aoi, '#38bdf8', '#0369a1', 'Área de análise');
  let pin = null;
  if (opts.point && Number.isFinite(Number(opts.point[0])) && Number.isFinite(Number(opts.point[1]))) {
    const [x, y] = toPx(Number(opts.point[0]), Number(opts.point[1]));
    if (Number.isFinite(x) && Number.isFinite(y)) pin = { x: x * scale, y: y * scale };
  }
  return {
    png: jpeg,
    width: outW,
    height: outH,
    shapes,
    pin,
    legend,
    decor: mapDecor(bbox, toPx, scale, outW, outH),
  };
}

function mapDecor(bbox, toPx, scale, outW, outH) {
  if (!bbox) return { vLines: [], hLines: [], scalePx: 48, scaleLabel: '' };
  const [west, south, east, north] = bbox;
  const vLines = [];
  for (const lng of ticks(west, east, niceStep(east - west, 4))) {
    const px = toPx(lng, north)[0] * scale;
    if (px < 18 || px > outW - 18) continue;
    vLines.push({ x: px, label: fmtDeg(lng, false) });
  }
  const hLines = [];
  for (const lat of ticks(south, north, niceStep(north - south, 3))) {
    const py = toPx(west, lat)[1] * scale;
    if (py < 16 || py > outH - 16) continue;
    hLines.push({ y: py, label: fmtDeg(lat, true) });
  }
  const midLat = (south + north) / 2;
  const widthM = Math.max((east - west) * 111320 * Math.cos((midLat * Math.PI) / 180), 1);
  const dist = niceDistance(widthM);
  const scalePx = Math.max(36, Math.min(outW * 0.34, (dist / widthM) * outW));
  const scaleLabel = dist >= 1000
    ? `${String(dist / 1000).replace('.', ',')} km`
    : `${dist} m`;
  return { vLines, hLines, scalePx, scaleLabel };
}

exports.renderSatelliteMap = renderSatelliteMap;
