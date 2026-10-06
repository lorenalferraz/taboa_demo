import { normMunNome as normMunNomeCatalog, resolveRegiaoPlanejamento as resolveRegiaoFromCatalog } from './faixaMunicipiosCatalog.js';

export { normMunNomeCatalog as normMunNome };

export function resolveRegiaoPlanejamento(nomMun, ibgeId) {
  return resolveRegiaoFromCatalog(nomMun, ibgeId);
}

export function regiaoPlanejamentoLabel(codigo) {
  if (codigo === 'litoral_sul') return '05 – Litoral Sul';
  if (codigo === 'baixo_sul') return '06 – Baixo Sul';
  if (codigo === 'extremo_sul') return '07 – Extremo Sul';
  return '—';
}

export function featureNomePublico(f, idx0) {
  if (!f) return `Área ${idx0 + 1}`;
  const p = f.properties || {};
  return p.nome_projeto || p.nome_proje || p.nm_comunid || p.denominaca || p.nomMun || p.nm_mun || p.NM_MUN || p.name || `Área ${idx0 + 1}`;
}

function firstNonemptyProp(p, keys) {
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
    const v = p[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s && s.toLowerCase() !== 'null') return s;
  }
  return '';
}

/**
 * Monta texto único Cefir/CAR (e relacionados) a partir das propriedades da feição GeoJSON.
 * Campos comuns: numero_car (SICAR), cod_sipra/cd_sipra, ide_imovel (INCRA).
 */
export function formatCefirCarFromFeatureProperties(rawProps) {
  if (!rawProps || typeof rawProps !== 'object') return '';
  const p = rawProps;
  const car = firstNonemptyProp(p, [
    'numero_car', 'NUMERO_CAR', 'CAR', 'car', 'cod_car', 'nu_car', 'Cod_CAR',
    'cod_imovel', 'COD_IMOVEL', 'nuCAR',
  ]);
  const sipra = firstNonemptyProp(p, ['cod_sipra', 'cd_sipra', 'COD_SIPRA', 'CD_SIPRA']);
  const ide = firstNonemptyProp(p, ['ide_imovel', 'IDE_IMOVEL']);
  const parts = [];
  if (car) parts.push(car);
  if (sipra) parts.push(`SIPRA ${sipra}`);
  if (ide && ide !== car) parts.push(`INCRA ${ide}`);
  return parts.join(' · ');
}

/** Primeira feição da lista cujas propriedades produzem texto Cefir/CAR não vazio. */
export function cefirCarFromContainingFeatures(features) {
  if (!features?.length) return '';
  for (const f of features) {
    const s = formatCefirCarFromFeatureProperties(f?.properties);
    if (s) return s;
  }
  return '';
}

export function tagFeaturesRegiaoTaboa(geojson) {
  for (const f of geojson.features || []) {
    if (!f.properties) f.properties = {};
    const ibge = f.properties.codMun || f.properties.cd_mun || f.properties.CD_MUN || f.properties.codigo_ibge || f.properties.id;
    const nm = f.properties.nomMun || f.properties.nm_mun || f.properties.NM_MUN || f.properties.municipio || '';
    f.properties._regiaoTaboa = resolveRegiaoPlanejamento(nm, ibge);
  }
}
