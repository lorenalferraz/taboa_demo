/**
 * Relatório da Consulta × PRODES.
 * O resumo completo vai só no PDF (backend/relatorio). Aqui: botão de download + payload.
 */

export function sourceLabelPt(source) {
  const map = {
    coords: 'Par de coordenadas',
    kml: 'KML',
    'map-point': 'Ponto no mapa',
    'map-polygon': 'Polígono no mapa',
    'imovel-car': 'Imóvel rural (CAR)',
  };
  return map[source] || source || '—';
}

export function kindLabelPt(kind) {
  return kind === 'polygon' ? 'Polígono' : 'Ponto';
}

/**
 * Caixa da consulta após o cruzamento: só a ação de baixar o PDF.
 */
export function buildConsultaReportHtml() {
  return `
    <div class="consulta-report-actions">
      <button type="button" class="btn btn-ghost btn-sm consulta-pdf-btn" id="btnConsultaPdf">
        <span>Baixar relatório</span>
        <svg class="consulta-pdf-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm1 7V3.5L19.5 9z"/>
          <path fill="#fff" d="M7.2 11.1h2.05c.95 0 1.55.5 1.55 1.28 0 .52-.28.93-.76 1.12.62.18 1 .66 1 1.32 0 .9-.7 1.48-1.82 1.48H7.2zm1.18 2.08h.82c.42 0 .7-.22.7-.55s-.28-.54-.72-.54h-.8zm0 2.22h.95c.48 0 .8-.24.8-.62 0-.4-.32-.62-.84-.62h-.91zM12.05 11.1H14c1.28 0 2.05.78 2.05 1.95v1.7c0 1.18-.77 1.95-2.05 1.95h-1.95zm1.18 1.08V16.1H14c.62 0 .9-.42.9-.88v-1.96c0-.46-.28-.88-.9-.88zM16.7 11.1h3.1v1.08h-1.92V13.4h1.72v1.05h-1.72v2.25H16.7z"/>
        </svg>
      </button>
      <p class="consulta-pdf-err" id="consultaPdfErr" hidden></p>
    </div>
  `;
}

/** Payload para o PDF em backend/relatorio (geometrias compactas para o mapa). */
export function buildConsultaPdfPayload(opts) {
  const {
    source,
    kind,
    mode,
    areaHa,
    municipio,
    lat,
    lng,
    generatedAt,
    aoi,
    point,
    nome,
    cpf,
    car,
  } = opts;

  return {
    source,
    kind,
    mode,
    areaHa,
    municipio: municipio
      ? {
          municipio: municipio.municipio || municipio.nome || '',
          uf: municipio.uf || 'BA',
        }
      : null,
    lat,
    lng,
    generatedAt,
    aoi: aoi || null,
    point: Array.isArray(point) && point.length >= 2 ? [Number(point[0]), Number(point[1])] : null,
    nome: String(nome || '').trim(),
    cpf: String(cpf || '').trim(),
    car: String(car || '').trim(),
    propriedadeHa: Number.isFinite(Number(opts.propriedadeHa)) && Number(opts.propriedadeHa) > 0
      ? Number(opts.propriedadeHa)
      : null,
  };
}
