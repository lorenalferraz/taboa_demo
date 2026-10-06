/**
 * Metadados e rótulos para assentamentos (assentamentos.geojson).
 */

function fmtVal(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'null') return '';
  return s;
}

/** @returns {{ label: string, value: string }[]} */
export function assentamentoFeatureDetailRows(props) {
  const p = props || {};
  const rows = [
    { label: 'Nome', value: fmtVal(p.nome_projeto || p.nome_proje) },
    { label: 'SIPRA', value: fmtVal(p.cd_sipra || p.cod_sipra) },
    { label: 'Município', value: fmtVal(p.municipio || p.nm_municip) },
    { label: 'Área declarada', value: fmtVal(p.area_hectare_declarada) ? `${fmtVal(p.area_hectare_declarada)} ha` : '' },
    { label: 'Área calculada', value: fmtVal(p.area_calc_ha) ? `${fmtVal(p.area_calc_ha)} ha` : '' },
    { label: 'Famílias', value: fmtVal(p.num_familias) },
    { label: 'Capacidade', value: fmtVal(p.capacidade) },
    { label: 'Fase', value: fmtVal(p.descricao_fase || p.fase) },
    { label: 'Criação', value: fmtVal(p.data_de_criacao) },
    { label: 'Obtenção', value: fmtVal(p.forma_obtencao) },
    { label: 'Data obtenção', value: fmtVal(p.data_obtencao) },
    { label: 'SR', value: fmtVal(p.sr) },
  ];
  return rows.filter((r) => r.value);
}

export function assentamentoFeatureTitle(props) {
  return fmtVal(props?.nome_projeto || props?.nome_proje) || 'Assentamento';
}

export function assentamentoFeatureSubtitle(props) {
  const parts = [
    fmtVal(props?.cd_sipra || props?.cod_sipra) ? `SIPRA ${fmtVal(props?.cd_sipra || props?.cod_sipra)}` : '',
    fmtVal(props?.municipio),
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * @param {object} props
 * @param {(s: string) => string} esc
 */
export function buildAssentamentoPopupHtml(props, esc) {
  const title = assentamentoFeatureTitle(props);
  const subtitle = assentamentoFeatureSubtitle(props);
  const rows = assentamentoFeatureDetailRows(props).filter((r) => r.label !== 'Nome');
  const body = rows
    .slice(0, 10)
    .map((r) => `<div class="popup-row">${esc(r.label)}: ${esc(r.value)}</div>`)
    .join('');
  return `
    <div class="popup-title">${esc(title)}</div>
    ${subtitle ? `<div class="popup-row"><small>${esc(subtitle)}</small></div>` : ''}
    ${body}
  `;
}
