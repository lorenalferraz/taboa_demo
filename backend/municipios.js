'use strict';

/**
 * Relação oficial TABOA — 62 municípios da faixa 05/06/07 (BA).
 * Corresponde a backend/shape/municipios.geojson.
 */
const FAIXA_MUNICIPIOS = [
  { ibge: 2900900, nomMun: 'Almadina', regiao: 'litoral_sul' },
  { ibge: 2902252, nomMun: 'Arataca', regiao: 'litoral_sul' },
  { ibge: 2902401, nomMun: 'Aurelino Leal', regiao: 'litoral_sul' },
  { ibge: 2903300, nomMun: 'Barro Preto', regiao: 'litoral_sul' },
  { ibge: 2904704, nomMun: 'Buerarema', regiao: 'litoral_sul' },
  { ibge: 2905602, nomMun: 'Camacan', regiao: 'litoral_sul' },
  { ibge: 2906303, nomMun: 'Canavieiras', regiao: 'litoral_sul' },
  { ibge: 2908002, nomMun: 'Coaraci', regiao: 'litoral_sul' },
  { ibge: 2911006, nomMun: 'Floresta Azul', regiao: 'litoral_sul' },
  { ibge: 2912103, nomMun: 'Ibicaraí', regiao: 'litoral_sul' },
  { ibge: 2912707, nomMun: 'Ibirapitanga', regiao: 'litoral_sul' },
  { ibge: 2913606, nomMun: 'Ilhéus', regiao: 'litoral_sul' },
  { ibge: 2914802, nomMun: 'Itabuna', regiao: 'litoral_sul' },
  { ibge: 2914901, nomMun: 'Itacaré', regiao: 'litoral_sul' },
  { ibge: 2915403, nomMun: 'Itaju do Colônia', regiao: 'litoral_sul' },
  { ibge: 2915502, nomMun: 'Itajuípe', regiao: 'litoral_sul' },
  { ibge: 2916203, nomMun: 'Itapé', regiao: 'litoral_sul' },
  { ibge: 2916609, nomMun: 'Itapitanga', regiao: 'litoral_sul' },
  { ibge: 2918555, nomMun: 'Jussari', regiao: 'litoral_sul' },
  { ibge: 2920700, nomMun: 'Maraú', regiao: 'litoral_sul' },
  { ibge: 2920908, nomMun: 'Mascote', regiao: 'litoral_sul' },
  { ibge: 2923902, nomMun: 'Pau Brasil', regiao: 'litoral_sul' },
  { ibge: 2928059, nomMun: 'Santa Luzia', regiao: 'litoral_sul' },
  { ibge: 2929354, nomMun: 'São José da Vitória', regiao: 'litoral_sul' },
  { ibge: 2932200, nomMun: 'Ubaitaba', regiao: 'litoral_sul' },
  { ibge: 2932507, nomMun: 'Una', regiao: 'litoral_sul' },
  { ibge: 2932705, nomMun: 'Uruçuca', regiao: 'litoral_sul' },
  { ibge: 2902302, nomMun: 'Aratuípe', regiao: 'baixo_sul' },
  { ibge: 2905404, nomMun: 'Cairu', regiao: 'baixo_sul' },
  { ibge: 2905800, nomMun: 'Camamu', regiao: 'baixo_sul' },
  { ibge: 2911204, nomMun: 'Gandu', regiao: 'baixo_sul' },
  { ibge: 2913457, nomMun: 'Igrapiúna', regiao: 'baixo_sul' },
  { ibge: 2917300, nomMun: 'Ituberá', regiao: 'baixo_sul' },
  { ibge: 2917805, nomMun: 'Jaguaripe', regiao: 'baixo_sul' },
  { ibge: 2922607, nomMun: 'Nilo Peçanha', regiao: 'baixo_sul' },
  { ibge: 2924678, nomMun: 'Piraí do Norte', regiao: 'baixo_sul' },
  { ibge: 2925758, nomMun: 'Presidente Tancredo Neves', regiao: 'baixo_sul' },
  { ibge: 2931202, nomMun: 'Taperoá', regiao: 'baixo_sul' },
  { ibge: 2931608, nomMun: 'Teolândia', regiao: 'baixo_sul' },
  { ibge: 2932903, nomMun: 'Valença', regiao: 'baixo_sul' },
  { ibge: 2933505, nomMun: 'Wenceslau Guimarães', regiao: 'baixo_sul' },
  { ibge: 2900801, nomMun: 'Alcobaça', regiao: 'extremo_sul' },
  { ibge: 2903409, nomMun: 'Belmonte', regiao: 'extremo_sul' },
  { ibge: 2906907, nomMun: 'Caravelas', regiao: 'extremo_sul' },
  { ibge: 2910727, nomMun: 'Eunápolis', regiao: 'extremo_sul' },
  { ibge: 2911808, nomMun: 'Guaratinga', regiao: 'extremo_sul' },
  { ibge: 2912806, nomMun: 'Ibirapuã', regiao: 'extremo_sul' },
  { ibge: 2914653, nomMun: 'Itabela', regiao: 'extremo_sul' },
  { ibge: 2915304, nomMun: 'Itagimirim', regiao: 'extremo_sul' },
  { ibge: 2915601, nomMun: 'Itamaraju', regiao: 'extremo_sul' },
  { ibge: 2916005, nomMun: 'Itanhém', regiao: 'extremo_sul' },
  { ibge: 2916302, nomMun: 'Itapebi', regiao: 'extremo_sul' },
  { ibge: 2918456, nomMun: 'Jucuruçu', regiao: 'extremo_sul' },
  { ibge: 2918902, nomMun: 'Lajedão', regiao: 'extremo_sul' },
  { ibge: 2921104, nomMun: 'Medeiros Neto', regiao: 'extremo_sul' },
  { ibge: 2922003, nomMun: 'Mucuri', regiao: 'extremo_sul' },
  { ibge: 2923001, nomMun: 'Nova Viçosa', regiao: 'extremo_sul' },
  { ibge: 2925303, nomMun: 'Porto Seguro', regiao: 'extremo_sul' },
  { ibge: 2925501, nomMun: 'Prado', regiao: 'extremo_sul' },
  { ibge: 2927705, nomMun: 'Santa Cruz Cabrália', regiao: 'extremo_sul' },
  { ibge: 2931350, nomMun: 'Teixeira de Freitas', regiao: 'extremo_sul' },
  { ibge: 2933257, nomMun: 'Vereda', regiao: 'extremo_sul' },
];

const BY_IBGE = new Map(FAIXA_MUNICIPIOS.map((m) => [m.ibge, m]));
const BY_NOME = new Map(FAIXA_MUNICIPIOS.map((m) => [normMunNome(m.nomMun), m]));
const FAIXA_IBGE_SET = new Set(FAIXA_MUNICIPIOS.map((m) => m.ibge));

function resolveCatalogByNome(nomMun) {
  return BY_NOME.get(normMunNome(nomMun)) || null;
}

function normMunNome(s) {
  if (s == null || s === '') return '';
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/\s+/g, ' ').replace(/-/g, ' ');
}

function resolveRegiaoByIbge(ibgeId) {
  return BY_IBGE.get(Number(ibgeId))?.regiao || '';
}

function resolveRegiaoByNome(nomMun) {
  const n = normMunNome(nomMun);
  const hit = FAIXA_MUNICIPIOS.find((m) => normMunNome(m.nomMun) === n);
  return hit?.regiao || '';
}

exports.FAIXA_MUNICIPIOS = FAIXA_MUNICIPIOS;
exports.FAIXA_IBGE_SET = FAIXA_IBGE_SET;
exports.BY_IBGE = BY_IBGE;
exports.BY_NOME = BY_NOME;
exports.normMunNome = normMunNome;
exports.resolveCatalogByNome = resolveCatalogByNome;
exports.resolveRegiaoByIbge = resolveRegiaoByIbge;
exports.resolveRegiaoByNome = resolveRegiaoByNome;
