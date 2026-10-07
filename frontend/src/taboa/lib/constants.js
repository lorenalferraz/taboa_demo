export const CENTER_BRASIL = [-14.2, -51.9];
export const ZOOM_BRASIL = 5;
/** Vista inicial TABOA — faixa Litoral/Baixo/Extremo Sul (BA). */
export const CENTER_FAIXA_TABOA = [-15.65, -39.45];
export const ZOOM_FAIXA_TABOA = 8;

/** Malha municipal da faixa TABOA (62 municípios). */
export const SHAPE_FILE = 'municipios.geojson';
export const ASSENTAMENTOS_FILE = 'assentamentos.geojson';
export const INDIGENAS_FILE = 'indigenas.geojson';
export const QUILOMBOLAS_FILE = 'quilombolas.geojson';
export const UC_FEDERAIS_FILE = 'uc_federais.geojson';
export const UC_ESTADUAIS_FILE = 'uc_estaduais.geojson';
export const UC_MUNICIPAIS_FILE = 'uc_municipais.geojson';

/**
 * GeoJSONs carregados depois da faixa (não bloqueiam a abertura do mapa).
 */
export const DEFERRED_SHAPE_GEOJSON_FILES = [
  ASSENTAMENTOS_FILE,
  INDIGENAS_FILE,
  QUILOMBOLAS_FILE,
  UC_FEDERAIS_FILE,
  UC_ESTADUAIS_FILE,
  UC_MUNICIPAIS_FILE,
];

/** Desmatamentos PRODES no mapa: contorno vermelho com preenchimento leve. */
export const PRODES_STYLE = {
  color: '#ef4444',
  weight: 2,
  opacity: 1,
  fillColor: '#ef4444',
  fillOpacity: 0.12,
  interactive: true,
};
/** Malha municipal: linha branca acinzentada, fina; fill quase invisível só para o clique do popup. */
export const MUNICIPIOS_STYLE = {
  color: '#d4d4d8',
  weight: 0.7,
  opacity: 0.88,
  fillColor: '#d4d4d8',
  fillOpacity: 0.02,
  fill: true,
  interactive: true,
};
export const MUNICIPIOS_STANDBY_STYLE = {
  color: '#a1a1aa',
  weight: 0.5,
  opacity: 0.55,
  fillColor: '#a1a1aa',
  fillOpacity: 0.015,
  fill: true,
  interactive: true,
};
export const ASSENTAMENTOS_STYLE = MUNICIPIOS_STYLE;
export const ASSENTAMENTOS_STANDBY_STYLE = MUNICIPIOS_STANDBY_STYLE;

export const PDF_GREEN = [21, 128, 61];
export const PDF_GREEN_LIGHT = [236, 253, 245];
