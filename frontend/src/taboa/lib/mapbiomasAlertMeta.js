/**
 * Metadados MapBiomas Alerta — bioma, fonte/sinal e rótulos pt-BR.
 * Campos: crossedBiomes, sources, deforestationClasses (API v2 GraphQL).
 */

/** Fragmento reutilizável na query `alerts { collection { ... } }`. */
export const MAPBIOMAS_ALERT_COLLECTION_GQL = `
  alertCode
  areaHa
  detectedAt
  publishedAt
  crossedBiomes
  sources
  deforestationClasses
  geometryWkt
  coordenates { latitude longitude }
  alertGeometry { simplifiedPoints { xCoord yCoord } }
`;

/** @type {Record<string, string>} — rótulos oficiais (MapBiomas API SourceTypes). */
const SOURCE_LABELS_PT = {
  All: 'Todas as fontes',
  DeterbAmazonia: 'DETER Amazônia',
  DeterCerrado: 'DETER Cerrado',
  Glad: 'GLAD',
  InemaBa: 'INEMA Bahia',
  IefMg: 'IEF Minas Gerais',
  ProdesCerrado: 'PRODES Cerrado',
  ProdesAmazonia: 'PRODES Amazônia',
  Sad: 'SAD',
  SadCaatinga: 'SAD Caatinga',
  SadMataAtlantica: 'SAD Mata Atlântica',
  SadPantanal: 'SAD Pantanal',
  SadPampa: 'SAD Pampa',
  SadCerrado: 'SAD Cerrado',
  SipamSar: 'SIPAM SAR',
  SiradX: 'Sirad X',
  SosInpe: 'SOS Mata Atlântica / INPE',
};

/** @type {Record<string, string>} — rótulos oficiais (MapBiomas API DeforestationTypes). */
const DEFORESTATION_CLASS_LABELS_PT = {
  All: 'Todos',
  Agriculture: 'Agricultura',
  IllegalMining: 'Garimpo ilegal',
  Mining: 'Mineração',
  UrbanExpansion: 'Expansão urbana',
  NaturalCause: 'Causa natural',
  Roads: 'Estradas',
  RenewableEnergyProject: 'Energia renovável',
  ReservoirOrDam: 'Reservatório ou barragem',
  Others: 'Outros',
};

function humanizeEnumKey(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

export function labelMapbiomasSource(sourceKey) {
  const k = String(sourceKey || '').trim();
  if (!k) return '';
  return SOURCE_LABELS_PT[k] || humanizeEnumKey(k);
}

export function labelDeforestationClass(classKey) {
  const k = String(classKey || '').trim();
  if (!k) return '';
  return DEFORESTATION_CLASS_LABELS_PT[k] || humanizeEnumKey(k);
}

function uniqueNonEmpty(arr) {
  const out = [];
  const seen = new Set();
  for (const raw of arr || []) {
    const s = String(raw ?? '').trim();
    if (!s || s === 'All' || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Detalhe de fonte/classe (sem código do alerta).
 * @param {object|null|undefined} alert
 */
export function alertSinaisDetail(alert) {
  if (!alert) return '';
  const sourceLabels = uniqueNonEmpty(alert.sources).map(labelMapbiomasSource).filter(Boolean);
  const classLabels = uniqueNonEmpty(alert.deforestationClasses).map(labelDeforestationClass).filter(Boolean);
  return [...sourceLabels, ...classLabels].join('; ');
}

/**
 * Coluna «Sinais de Alertas de Desmatamento» — fontes de detecção + classe, com código.
 * @param {object|null|undefined} alert
 */
export function sinaisFromAlert(alert) {
  if (!alert) return '—';
  const code = alert.alertCode != null ? `Alerta ${alert.alertCode}` : '';
  const detail = alertSinaisDetail(alert);
  if (code && detail) return `${code} — ${detail}`;
  if (detail) return detail;
  return code || '—';
}

/**
 * Coluna «Bioma» — crossedBiomes da API; fallback shape local.
 * @param {object|null|undefined} alert
 * @param {import('geojson').Feature|null|undefined} feat
 */
export function biomaFromAlert(alert, feat) {
  const biomes = uniqueNonEmpty(alert?.crossedBiomes);
  if (biomes.length) return biomes.join('; ');
  const b = alert?.biome ?? alert?.bioma ?? alert?.biomeName;
  if (b) return String(b);
  const fromShape = feat?.properties?.bioma || feat?.properties?.Bioma;
  return fromShape ? String(fromShape) : '—';
}

export function fonteAlertaLabel(alert) {
  const labels = uniqueNonEmpty(alert?.sources).map(labelMapbiomasSource).filter(Boolean);
  return labels.length ? labels.join('; ') : '—';
}

export function vetorPressaoLabel(alert) {
  const labels = uniqueNonEmpty(alert?.deforestationClasses).map((k) => {
    if (k === 'Agriculture') return 'Agropecuária';
    return labelDeforestationClass(k);
  }).filter(Boolean);
  return labels.length ? labels.join('; ') : '—';
}

export function alertSourceLabel() {
  return 'MapBiomas';
}

export function mapbiomasAlertDetailRows(alert, bioma, sinaisDet) {
  const rows = [
    { label: 'Fonte', value: 'MapBiomas Alerta' },
  ];
  if (bioma && bioma !== '—') rows.push({ label: 'Bioma', value: bioma });
  if (sinaisDet) rows.push({ label: 'Sinal', value: sinaisDet });
  if (alert?.publishedAt) rows.push({ label: 'Publicado', value: String(alert.publishedAt) });
  return rows;
}

export function alertDetailRows(alert, opts = {}) {
  return mapbiomasAlertDetailRows(alert, opts.bioma ?? '', opts.sinaisDet ?? '');
}

export function buildDetailRowsHtml(rows, esc, rowClass = 'card-row') {
  return (rows || [])
    .map((r) => `<div class="${rowClass}"><span>${esc(r.label)}</span><span>${esc(r.value)}</span></div>`)
    .join('');
}

