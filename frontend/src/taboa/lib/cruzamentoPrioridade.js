/**
 * Cruzamento espacial com várias camadas GeoJSON: escolhe a poligonal
 * que contém o ponto com menor área (mais restritiva), com desempate por tipo.
 */
import * as turf from '@turf/turf';
import { featureNomePublico, formatCefirCarFromFeatureProperties } from './region.js';
import { sortHitsForCruzamento, pickPrimaryRuralPropertyHit } from './settlementOverlap.js';

/** Ordem de desempate (menor = mais restritivo em caso de área igual). */
export const CRUZAMENTO_KIND_RANK = {
  certificado_privado: 0,
  certificado_publico: 0,
  car: 1,
  imovel_rural: 2,
  sigef: 3,
  cefir: 4,
  indigena: 5,
  quilombo: 6,
  assentamento: 7,
  outros: 8,
};

export function humanKindLabel(kind) {
  const k = kind || 'outros';
  if (k === 'certificado_privado') return 'Certificado privado';
  if (k === 'car') return 'CAR / SICAR';
  if (k === 'imovel_rural') return 'Imóvel rural / INEMA';
  if (k === 'sigef') return 'SIGEF';
  if (k === 'cefir') return 'CEFIR';
  if (k === 'indigena') return 'Terra Indígena';
  if (k === 'quilombo') return 'Quilombo';
  if (k === 'assentamento') return 'Assentamento';
  return 'Outros';
}

/**
 * @param {string} filename
 * @returns {keyof typeof CRUZAMENTO_KIND_RANK}
 */
export function inferLayerKindFromFilename(filename) {
  const n = String(filename || '').toLowerCase();
  if (n.includes('certificado') && n.includes('publico')) return 'certificado_publico';
  if (n.includes('certificado') && n.includes('privado')) return 'certificado_privado';
  if (n.includes('imovel') || n.includes('imóvel') || (n.includes('inema') && n.includes('imovel'))) return 'imovel_rural';
  if (n.includes('sigef')) return 'sigef';
  if (n.includes('cefir')) return 'cefir';
  if (n.includes('quilombo')) return 'quilombo';
  if (n.includes('assentamento')) return 'assentamento';
  return 'outros';
}

/**
 * @param {Record<string, object>} loadedGeoJSONByFile
 * @param {Set<string>|string[]} excludeLowerNames — nomes de ficheiro em minúsculas a ignorar (ex.: faixa)
 * @returns {{ feature: import('geojson').Feature, sourceFile: string, kind: string, featureIndex: number, bbox: number[]|null }[]}
 */
export function buildCruzamentoCandidates(loadedGeoJSONByFile, excludeLowerNames) {
  const ex = excludeLowerNames instanceof Set
    ? excludeLowerNames
    : new Set((excludeLowerNames || []).map((s) => String(s).toLowerCase()));
  const out = [];
  for (const [name, gj] of Object.entries(loadedGeoJSONByFile || {})) {
    const low = String(name).toLowerCase();
    if (ex.has(low)) continue;
    const kind = inferLayerKindFromFilename(name);
    const feats = gj?.features || [];
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      if (!f?.geometry) continue;
      const t = f.geometry.type;
      if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
      let bbox = null;
      try {
        bbox = turf.bbox(f.geometry);
      } catch (_) {}
      out.push({ feature: f, sourceFile: name, kind, featureIndex: i, bbox });
    }
  }
  return out;
}

function bboxMayContain(bbox, lng, lat) {
  if (!bbox || bbox.length < 4) return true;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function candidateFeatureKey(c) {
  if (!c?.feature) return '';
  const car = formatCefirCarFromFeatureProperties(c.feature.properties || {});
  if (car) return `car:${car.toUpperCase()}`;
  const sf = String(c.sourceFile || '');
  const idx = c.featureIndex ?? 0;
  return `geom:${sf}#${idx}`;
}

/**
 * @returns {{
 *   mode: 'poligono'|'buffer',
 *   aoi: import('geojson').Feature,
 *   containing: import('geojson').Feature[],
 *   labels: string[],
 *   aoiMeta: object|null,
 *   prioritizedHits: object[]
 * }}
 */
export function resolvePrioritizedCruzamentoAoi(lng, lat, candidates, bufferKm = 0.5, excludeKeys = null) {
  const pt = turf.point([lng, lat]);
  const ex = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys || []);
  const strictHits = [];
  const toleranceHits = [];

  for (const c of candidates || []) {
    const key = candidateFeatureKey(c);
    if (key && ex.has(key)) continue;
    if (!bboxMayContain(c.bbox, lng, lat)) continue;
    try {
      const tf = turf.feature(c.feature.geometry);
      const area = turf.area(tf);
      const entry = { ...c, area, areaHa: area / 10000 };
      if (turf.booleanPointInPolygon(pt, tf)) strictHits.push(entry);
      else {
        const ptBuffer = turf.buffer(pt, 0.075, { units: 'kilometers', steps: 8 });
        if (ptBuffer && turf.booleanIntersects(ptBuffer, tf)) toleranceHits.push(entry);
      }
    } catch (_) {}
  }

  const hits = strictHits.length ? strictHits : toleranceHits;

  if (!hits.length) {
    const buf = turf.buffer(pt, bufferKm, { units: 'kilometers' });
    return {
      mode: 'buffer',
      aoi: buf,
      containing: [],
      labels: [],
      aoiMeta: null,
      prioritizedHits: [],
    };
  }

  const sorted = sortHitsForCruzamento(hits);
  const ruralBest = pickPrimaryRuralPropertyHit(sorted);
  const best = ruralBest || sorted[0];
  const merged = turf.feature(
    JSON.parse(JSON.stringify(best.feature.geometry)),
    { ...(best.feature.properties || {}) },
  );
  const pub = featureNomePublico(best.feature, best.featureIndex);
  const label = `${humanKindLabel(best.kind)} · ${pub}`;
  const allHitsSummary = sorted.slice(0, 12).map((h) => {
    const p = featureNomePublico(h.feature, h.featureIndex);
    return `${humanKindLabel(h.kind)} — ${p} (${h.areaHa.toFixed(2)} ha · ${h.sourceFile})`;
  });

  const ruralPrimary = pickPrimaryRuralPropertyHit(sorted);

  return {
    mode: 'poligono',
    aoi: merged,
    containing: [best.feature],
    labels: [label],
    primaryKey: candidateFeatureKey(best),
    aoiMeta: {
      sourceFile: best.sourceFile,
      kind: best.kind,
      areaHa: best.areaHa,
      label: pub,
      humanKind: humanKindLabel(best.kind),
      allHitsSummary,
      totalHits: sorted.length,
      cefirCar: formatCefirCarFromFeatureProperties(best.feature.properties || {}),
      ruralPropertyHit: ruralPrimary
        ? {
            kind: ruralPrimary.kind,
            areaHa: ruralPrimary.areaHa,
            label: featureNomePublico(ruralPrimary.feature, ruralPrimary.featureIndex),
            humanKind: humanKindLabel(ruralPrimary.kind),
          }
        : null,
    },
    prioritizedHits: sorted,
  };
}
