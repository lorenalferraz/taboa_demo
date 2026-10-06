/**
 * Camadas locais extras (backend/shape/) — TI, UCs e quilombolas.
 */

function fmtVal(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s.replace(/^["']+|["']+$/g, '');
}

function haVal(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ha`;
}

function popupHtml(title, rows, esc) {
  const body = rows
    .filter((r) => r.value)
    .slice(0, 10)
    .map((r) => `<div class="popup-row">${esc(r.label)}: ${esc(r.value)}</div>`)
    .join('');
  return `<div class="popup-title">${esc(title)}</div>${body}`;
}

export function buildIndigenasPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.terrai_nom) || 'Terra indígena';
  return popupHtml(title, [
    { label: 'Povo', value: fmtVal(p.etnia_nome) },
    { label: 'Município', value: fmtVal(p.municipio_) },
    { label: 'UF', value: fmtVal(p.uf_sigla) },
    { label: 'Fase', value: fmtVal(p.fase_ti) },
    { label: 'Modalidade', value: fmtVal(p.modalidade) },
    { label: 'CR', value: fmtVal(p.cr) },
  ], esc);
}

export function buildUcEstadualPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.nome_ofici || p.nome_uc) || 'Unidade de Conservação estadual';
  return popupHtml(title, [
    { label: 'Categoria', value: fmtVal(p.categori_1) },
    { label: 'Grupo', value: fmtVal(p.grupo_1) },
    { label: 'Gestor', value: fmtVal(p.org_gestor) },
    { label: 'Municípios', value: fmtVal(p.municipios) },
    { label: 'Bioma', value: fmtVal(p.bioma) },
    { label: 'Área', value: haVal(p.area_ha || p.area_decre) },
    { label: 'Ato', value: fmtVal(p.l_vigente || p.l_criacao) },
  ], esc);
}

export function buildUcMunicipalPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.nome_uc) || 'Unidade de Conservação municipal';
  return popupHtml(title, [
    { label: 'Categoria', value: fmtVal(p.categoria) },
    { label: 'Grupo', value: fmtVal(p.grupo) },
    { label: 'Município', value: fmtVal(p.municipio) },
    { label: 'Gestor', value: fmtVal(p.org_gestor) },
    { label: 'Bioma', value: fmtVal(p.bioma) },
    { label: 'Área', value: haVal(p.area_decre || p.area_geo) },
    { label: 'SNUC', value: fmtVal(p.snuc) },
    { label: 'Ato', value: fmtVal(p.ato_vigent) },
  ], esc);
}

export function buildUcFederalPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.nome) || 'Unidade de Conservação federal';
  return popupHtml(title, [
    { label: 'Categoria', value: fmtVal(p.sigla) },
    { label: 'Grupo', value: fmtVal(p.siglagrupo) },
    { label: 'Administração', value: fmtVal(p.administra) },
    { label: 'Municípios', value: fmtVal(p.municipios) },
    { label: 'Bioma', value: fmtVal(p.biomaibge) },
    { label: 'Ato legal', value: fmtVal(p.atolegal) },
    { label: 'CNUC', value: fmtVal(p.codigocnuc) },
  ], esc);
}

export function buildAppPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.TIPO) || 'Área de preservação permanente';
  return popupHtml(title, [
    { label: 'Imóvel', value: fmtVal(p.IDE_IMOVEL) },
    { label: 'Conservação', value: fmtVal(p.EST_CONSER) },
    { label: 'Cadastro', value: fmtVal(p.TPO_CADAST) },
    { label: 'Área', value: haVal(p.AREA_DECLA) },
  ], esc);
}

export function buildReservaLegalPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.TIPO) || 'Reserva legal';
  return popupHtml(title, [
    { label: 'Imóvel', value: fmtVal(p.IDE_IMOVEL) },
    { label: 'Status', value: fmtVal(p.STATUS) },
    { label: 'Conservação', value: fmtVal(p.EST_CONSER) },
    { label: 'Cadastro', value: fmtVal(p.TPO_CADAST) },
    { label: 'Área', value: haVal(p.AREA_DECLA) },
  ], esc);
}

export function buildMunicipiosPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.nomMun || p.nm_mun || p.NM_MUN) || 'Município';
  const areaKm = Number(p.area_km2);
  const area = Number.isFinite(areaKm) && areaKm > 0
    ? `${areaKm.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`
    : '';
  const regiaoRaw = fmtVal(p._regiaoTaboa);
  const regiao = regiaoRaw === 'litoral_sul' ? '05 – Litoral Sul'
    : regiaoRaw === 'baixo_sul' ? '06 – Baixo Sul'
      : regiaoRaw === 'extremo_sul' ? '07 – Extremo Sul'
        : regiaoRaw;
  return popupHtml(title, [
    { label: 'Código IBGE', value: fmtVal(p.codMun || p.cd_mun) },
    { label: 'UF', value: fmtVal(p.sigla_uf) || 'BA' },
    { label: 'Área', value: area },
    { label: 'Região', value: regiao },
  ], esc);
}

export function buildImoveisRuraisPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.DENOMINACA) || 'Imóvel rural';
  return popupHtml(title, [
    { label: 'Município', value: fmtVal(p.MUNICIPIO) },
    { label: 'CAR', value: fmtVal(p.NUMERO_CAR) },
    { label: 'Status', value: fmtVal(p.STATUS) },
    { label: 'Área', value: haVal(p.AREA_REGIS) },
    { label: 'Módulos fiscais', value: fmtVal(p.QTD_MODFIS) },
    { label: 'Imóvel', value: fmtVal(p.IDE_IMOVEL) },
  ], esc);
}
export function buildQuilombolasPopupHtml(props, esc) {
  const p = props || {};
  const title = fmtVal(p.nm_comunid) || 'Território quilombola';
  return popupHtml(title, [
    { label: 'Município', value: fmtVal(p.nm_municip) },
    { label: 'UF', value: fmtVal(p.cd_uf) },
    { label: 'Famílias', value: fmtVal(p.nr_familia) },
    { label: 'Área', value: haVal(p.area_calc_) },
    { label: 'Esfera', value: fmtVal(p.esfera) },
    { label: 'Responsável', value: fmtVal(p.responsave) },
    { label: 'Processo', value: fmtVal(p.nr_process) },
    { label: 'Fase', value: fmtVal(p.fase) },
  ], esc);
}

/** Camadas da aba Camada (além de municípios, alertas e assentamentos). */
export const SHAPE_OVERLAY_LAYERS = [
  {
    id: 'indigenas',
    checkboxId: 'chkFunaiIndigenas',
    label: 'Terras indígenas',
    source: 'FUNAI',
    geojson: 'indigenas.geojson',
    style: { color: '#059669', weight: 1.5, fillColor: '#34d399', fillOpacity: 0.18 },
    buildPopup: buildIndigenasPopupHtml,
  },
  {
    id: 'quilombolas',
    checkboxId: 'chkIncraQuilombolas',
    label: 'Territórios quilombolas',
    source: 'INCRA',
    geojson: 'quilombolas.geojson',
    style: { color: '#be185d', weight: 1.5, fillColor: '#f9a8d4', fillOpacity: 0.18 },
    buildPopup: buildQuilombolasPopupHtml,
  },
  {
    id: 'uc_federais',
    checkboxId: 'chkIcmbioUcFederais',
    label: 'Unidades de Conservação federais',
    source: 'ICMBio',
    geojson: 'uc_federais.geojson',
    style: { color: '#0f766e', weight: 1.5, fillColor: '#5eead4', fillOpacity: 0.18 },
    buildPopup: buildUcFederalPopupHtml,
  },
  {
    id: 'uc_estaduais',
    checkboxId: 'chkInemaUcEstaduais',
    label: 'Unidades de Conservação estaduais',
    source: 'INEMA',
    geojson: 'uc_estaduais.geojson',
    style: { color: '#1d4ed8', weight: 1.5, fillColor: '#93c5fd', fillOpacity: 0.18 },
    buildPopup: buildUcEstadualPopupHtml,
  },
  {
    id: 'uc_municipais',
    checkboxId: 'chkInemaUcMunicipais',
    label: 'Unidades de Conservação municipais',
    source: 'INEMA',
    geojson: 'uc_municipais.geojson',
    style: { color: '#6d28d9', weight: 1.5, fillColor: '#c4b5fd', fillOpacity: 0.18 },
    buildPopup: buildUcMunicipalPopupHtml,
  },
  {
    id: 'imoveis_rurais',
    checkboxId: 'chkInemaImoveisRurais',
    label: 'Imóveis rurais',
    source: 'INEMA',
    geojson: 'imoveis_rurais.geojson',
    heavy: true,
    defaultOn: false,
    style: { color: '#eab308', weight: 1.8, fillColor: '#facc15', fillOpacity: 0.28 },
    buildPopup: buildImoveisRuraisPopupHtml,
  },
  {
    id: 'reserva_legal',
    checkboxId: 'chkInemaReservaLegal',
    label: 'Reserva legal',
    source: 'INEMA',
    geojson: 'reserva_legal.geojson',
    heavy: true,
    defaultOn: false,
    style: { color: '#166534', weight: 1.4, fillColor: '#86efac', fillOpacity: 0.2 },
    buildPopup: buildReservaLegalPopupHtml,
  },
  {
    id: 'app',
    checkboxId: 'chkInemaApp',
    label: 'Áreas de preservação permanente',
    source: 'INEMA',
    geojson: 'app.geojson',
    heavy: true,
    defaultOn: false,
    style: { color: '#0e7490', weight: 1.4, fillColor: '#67e8f9', fillOpacity: 0.2 },
    buildPopup: buildAppPopupHtml,
  },
];

export const SHAPE_OVERLAY_FILES = SHAPE_OVERLAY_LAYERS.map((c) => c.geojson);
