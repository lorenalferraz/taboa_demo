/**
 * Municípios da faixa — lidos de backend/shape/municipios.geojson.
 */
import { fetchFaixaGeoJson } from './faixaGeojsonClient.js';
import { normMunNome } from './faixaMunicipiosCatalog.js';

function featureNome(f) {
  return String(f?.properties?.nomMun || f?.properties?.nm_mun || f?.properties?.NM_MUN || '').trim();
}

function featureIbge(f) {
  const n = Number(f?.properties?.codMun ?? f?.properties?.cd_mun);
  return Number.isFinite(n) ? n : null;
}

/** @type {{ id: number|null, nome: string, uf: string }[] | null} */
let _all = null;
/** @type {Map<string, object>} */
const _featByNome = new Map();

/**
 * @returns {Promise<{ id: number|null, nome: string, uf: string }[]>}
 */
export async function loadIbgeMunicipios() {
  if (_all) return _all;
  const resp = await fetchFaixaGeoJson();
  const feats = resp?.geojson?.features || [];
  const seen = new Set();
  const list = [];
  _featByNome.clear();
  for (const f of feats) {
    const nome = featureNome(f);
    if (!nome) continue;
    const key = normMunNome(nome);
    if (!_featByNome.has(key)) _featByNome.set(key, f);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ id: featureIbge(f), nome, uf: 'BA' });
  }
  list.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  _all = list;
  return _all;
}

/** Feições carregadas de `municipios.geojson`, já na área da faixa. */
export function getMunicipioFeatures() {
  return [..._featByNome.values()];
}

/** Feição de `municipios.geojson` pelo nome (match sem acento). */
export function findMunicipioFeature(nome) {
  const n = normMunNome(nome);
  if (!n) return null;
  return _featByNome.get(n) || null;
}

/** @returns {{ id: number|null, nome: string, uf: string }[]} */
export function getMunicipiosByUf() {
  return _all || [];
}

/** Nomes ordenados a partir de municipios.geojson. */
export function getMunicipioNamesByUf() {
  return getMunicipiosByUf().map((m) => m.nome);
}

/** Resolve código IBGE pelo nome (match sem acento). */
export function findMunicipioId(nome) {
  const n = normMunNome(nome);
  if (!n) return null;
  const hit = (_all || []).find((m) => normMunNome(m.nome) === n);
  return hit?.id ?? null;
}
