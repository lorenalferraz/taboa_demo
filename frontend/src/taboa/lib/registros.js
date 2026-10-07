/**
 * Suporte a registros de crédito (CRA, FIAGRO, etc.) carregados via CSV do backend.
 * Responsabilidades:
 *  - parseDMSCoord: converte coordenadas em graus-minutos-segundos → decimal
 *  - CRA_COLORS: mapa de tipo → cor do marcador
 *  - buildRegistrosLayer: monta LayerGroup Leaflet com CircleMarkers + popups
 */
import L from 'leaflet';
import * as turf from '@turf/turf';
import { featureNomePublico } from './region.js';

import { resolvePrioritizedCruzamentoAoi } from './cruzamentoPrioridade.js';

/** Raio do buffer de fallback (km) quando o ponto não está em assentamento — 500 m = diâmetro 1 km. */
export const REGISTRO_CRUZAMENTO_BUFFER_KM = 0.5;

// ─── Tipos → cores ────────────────────────────────────────────────────────────

const CRA_COLORS = {
  'CRA/2024-REV': '#f59e0b',  // âmbar
  'CRA/2024':     '#3b82f6',  // azul
  'CRA/2023':     '#8b5cf6',  // violeta
  'CRA/2022':     '#06b6d4',  // ciano
  default:        '#94a3b8',  // cinza
};

export function craColor(tipo) {
  if (!tipo) return CRA_COLORS.default;
  const t = String(tipo).trim().toUpperCase();
  for (const [k, v] of Object.entries(CRA_COLORS)) {
    if (k !== 'default' && t === k.toUpperCase()) return v;
  }
  // Correspondência parcial
  if (t.includes('REV')) return CRA_COLORS['CRA/2024-REV'];
  if (t.includes('2024')) return CRA_COLORS['CRA/2024'];
  if (t.includes('2023')) return CRA_COLORS['CRA/2023'];
  return CRA_COLORS.default;
}

// ─── Parser de coordenadas DMS ───────────────────────────────────────────────

/**
 * Converte string DMS (graus, minutos, segundos) ou decimal → número.
 *
 * Estratégia: normalização antes da regex, para lidar com todos os formatos
 * encontrados no CSV sem depender de regex frágil por formato.
 *
 * Formatos aceitos (exemplos reais do CSV):
 *   16°55'53.8"S     → ponto como decimal, ' e " como separadores
 *   16°55'53,8"S     → vírgula como decimal
 *   14°33°14,77°°S   → ° como separador universal, vírgula decimal, °° final
 *   -16.9276         → decimal puro com sinal
 *   O / o            → "Oeste" equivale a W (Oeste em português)
 */
export function parseDMSCoord(raw) {
  if (raw == null) return null;

  // Remove aspas envolventes geradas pelo CSV
  let s = String(raw).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s || s === '0') return null;

  // ── 1. Detecta hemisfério (última letra alfabética) ──────────────────────
  // Suporta N, S, E, W e O (Oeste em português)
  const hemMatch = s.match(/([NSEWOnsewO])\s*$/);
  if (!hemMatch) {
    // Sem hemisfério → tenta decimal puro
    const num = parseFloat(s.replace(',', '.'));
    return Number.isFinite(num) && num !== 0 ? num : null;
  }

  const hem = hemMatch[1].toUpperCase();

  // Remove hemisfério do final da string
  s = s.slice(0, hemMatch.index).trimEnd();

  // ── 2. Normaliza separadores ──────────────────────────────────────────────
  // Remove todos os caracteres que funcionam como separadores DMS:
  // °, º, ", ", ″, ', ′ → substituídos por espaço
  // O resultado são os componentes numéricos D M S separados por espaço.
  // Vírgulas em números decimais são preservadas (ex: "14,77") pois não
  // são separadores de campo — a substituição só ocorre em não-dígitos.
  s = s
    .replace(/[°º″′\u00b0\u00ba\u2033\u2032]/g, ' ') // separadores DMS → espaço
    .replace(/["']/g, ' ')                             // aspas remanescentes → espaço
    .replace(/\s+/g, ' ')
    .trim();

  // ── 3. Extrai partes D, M, S ──────────────────────────────────────────────
  const parts = s.split(' ').filter(Boolean);
  if (!parts.length) return null;

  const toNum = (v) => parseFloat(String(v).replace(',', '.')) || 0;
  const d   = toNum(parts[0]);
  const min = parts.length > 1 ? toNum(parts[1]) : 0;
  const sec = parts.length > 2 ? toNum(parts[2]) : 0;

  const dec = d + min / 60 + sec / 3600;
  if (!Number.isFinite(dec) || dec === 0) return null;

  // Sul (S) e Oeste (W ou O) são negativos
  return (hem === 'S' || hem === 'W' || hem === 'O') ? -dec : dec;
}

// ─── Popup HTML ───────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPopup(rec) {
  const tipo = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '—';
  const cor = craColor(tipo);
  const rows = [
    ['Nome',       rec['Nome']],
    ['CPF/CNPJ',   rec['CPF/CNPJ']],
    ['Endereço',   rec['Endereço'] || rec['Endereco']],
    ['Município',  rec['Município'] || rec['Municipio']],
    ['Estado',     rec['Estado']],
    ['Operação',   tipo],
  ];
  const cells = rows
    .map(([label, val]) => `
      <tr>
        <td style="font-weight:600;padding:2px 6px 2px 0;color:#64748b;white-space:nowrap;font-size:0.8rem">${label}</td>
        <td style="padding:2px 0;font-size:0.8rem">${esc(val)}</td>
      </tr>`)
    .join('');
  return `
<div style="min-width:200px;max-width:280px">
  <div style="background:${cor};color:#fff;font-weight:700;padding:6px 10px;border-radius:6px 6px 0 0;font-size:0.85rem;margin:-8px -12px 8px">
    ${esc(tipo)}
  </div>
  <table style="border-collapse:collapse;width:100%">${cells}</table>
</div>`;
}

// ─── Área de cruzamento: assentamento (ponto dentro do shape) ou buffer ──────

/**
 * Lista feições do GeoJSON de assentamentos (fazenda, INCRA, SIGEF, etc.) que contêm o ponto.
 * @param {number} lng
 * @param {number} lat
 * @param {import('geojson').Feature[]} features
 * @returns {import('geojson').Feature[]}
 */
export function listAssentamentosContainingPoint(lng, lat, features) {
  if (!features?.length) return [];
  const pt = turf.point([lng, lat]);
  const out = [];
  for (const f of features) {
    if (!f?.geometry) continue;
    try {
      if (turf.booleanPointInPolygon(pt, turf.feature(f.geometry))) out.push(f);
    } catch (_) {}
  }
  return out;
}

/**
 * Junta polígonos/multipolígonos numa única feição para interseção com alertas.
 * @param {import('geojson').Feature[]} features
 * @returns {import('geojson').Feature<import('geojson').Polygon|import('geojson').MultiPolygon>|null}
 */
export function combinePolygonalFeatures(features) {
  const polys = [];
  for (const f of features) {
    if (!f?.geometry) continue;
    const g = f.geometry;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') {
      for (const ring of g.coordinates) polys.push(ring);
    }
  }
  if (!polys.length) return null;
  if (polys.length === 1) return turf.polygon(polys[0]);
  return turf.multiPolygon(polys);
}

/**
 * Área usada no cruzamento CRA × alertas: polígono do(s) assentamento(s) que contêm o ponto,
 * ou buffer circular se estiver fora de qualquer shape carregado.
 * @param {number} lng
 * @param {number} lat
 * @param {import('geojson').Feature[]|null|undefined} assentamentoFeatures
 * @param {number} [bufferKm=REGISTRO_CRUZAMENTO_BUFFER_KM]
 * @returns {{
 *   mode: 'assentamento'|'buffer',
 *   aoi: import('geojson').Feature,
 *   containing: import('geojson').Feature[],
 *   labels: string[]
 * }}
 */
export function resolveRegistroCruzamentoAoi(lng, lat, assentamentoFeatures, bufferKm = REGISTRO_CRUZAMENTO_BUFFER_KM) {
  const containing = listAssentamentosContainingPoint(lng, lat, assentamentoFeatures || []);
  if (containing.length) {
    const merged = combinePolygonalFeatures(containing);
    if (merged) {
      const labels = containing.map((f, i) => featureNomePublico(f, i));
      return { mode: 'assentamento', aoi: merged, containing, labels, aoiMeta: null, prioritizedHits: [] };
    }
  }
  const pt = turf.point([lng, lat]);
  const buf = turf.buffer(pt, bufferKm, { units: 'kilometers' });
  return { mode: 'buffer', aoi: buf, containing: [], labels: [], aoiMeta: null, prioritizedHits: [] };
}

// ─── Monta LayerGroup de buffers / polígonos de análise ───────────────────────

/**
 * Área de análise por registro: polígono prioritário (multi-camada) ou assentamento;
 * senão buffer de 500 m de raio (1 km de diâmetro).
 * @param {object[]} records
 * @param {import('geojson').Feature[]|null|undefined} assentamentoFeatures
 * @param {object[]|null} [cruzamentoCandidates]
 * @returns {L.LayerGroup}
 */
export function buildRegistrosBufferLayer(records, assentamentoFeatures, cruzamentoCandidates = null) {
  const layers = [];

  for (const rec of records) {
    const lat = parseDMSCoord(rec['Latitude']  ?? rec['latitude']);
    const lng = parseDMSCoord(rec['Longitude'] ?? rec['longitude']);
    if (lat == null || lng == null) continue;

    const tipo = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '';
    const color = craColor(tipo);

    const { mode, aoi } = cruzamentoCandidates && cruzamentoCandidates.length
      ? resolvePrioritizedCruzamentoAoi(lng, lat, cruzamentoCandidates, REGISTRO_CRUZAMENTO_BUFFER_KM)
      : resolveRegistroCruzamentoAoi(lng, lat, assentamentoFeatures, REGISTRO_CRUZAMENTO_BUFFER_KM);
    const isAssent = mode !== 'buffer';

    layers.push(
      L.geoJSON(aoi, {
        style: isAssent
          ? {
              color: '#7c3aed',
              weight: 2,
              opacity: 0.85,
              fillColor: color,
              fillOpacity: 0.1,
            }
          : {
              color,
              weight: 1.5,
              opacity: 0.7,
              fillColor: color,
              fillOpacity: 0.12,
            },
      })
    );
  }

  return L.layerGroup(layers);
}

// ─── Monta LayerGroup de pontos ───────────────────────────────────────────────

/**
 * Cria e retorna um L.LayerGroup com CircleMarkers para cada registro com coordenadas.
 * @param {object[]} records - array de objetos vindos do CSV (chaves = cabeçalhos)
 * @returns {{ layer: L.LayerGroup, total: number, withCoords: number }}
 */
export function buildRegistrosLayer(records, opts = {}) {
  const markers = [];
  let withCoords = 0;

  for (const rec of records) {
    const latRaw = rec['Latitude']  ?? rec['latitude'];
    const lngRaw = rec['Longitude'] ?? rec['longitude'];
    const lat = parseDMSCoord(latRaw);
    const lng = parseDMSCoord(lngRaw);
    if (lat == null || lng == null) continue;

    withCoords++;
    const tipo = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '';
    const color = craColor(tipo);

    const marker = L.circleMarker([lat, lng], {
      radius: 7,
      fillColor: color,
      fillOpacity: 0.85,
      color: '#fff',
      weight: 1.5,
      interactive: true,
      renderer: opts.renderer || undefined,
    }).bindPopup(buildPopup(rec), { maxWidth: 300 });

    markers.push(marker);
  }

  return {
    layer: L.layerGroup(markers),
    total: records.length,
    withCoords,
  };
}
