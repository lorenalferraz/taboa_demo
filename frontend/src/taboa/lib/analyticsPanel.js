/** Configuração visual das regiões TABOA (05/06/07). */
export const FAIXA_REGIOES = [
  { key: 'litoral_sul', label: '05 Litoral Sul', color: '#ef4444' },
  { key: 'baixo_sul', label: '06 Baixo Sul', color: '#f59e0b' },
  { key: 'extremo_sul', label: '07 Extremo Sul', color: '#a855f7' },
  { key: 'divisa', label: 'Divisa', color: '#06b6d4' },
];

function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

function fmtHa(n, digits = 1) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
  return v.toFixed(digits).replace('.', ',');
}

function fmtHaFull(n) {
  return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtPct(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1).replace('.', ',')}%`;
}

function fmtDatePt(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso.slice(0, 10);
  return `${d}/${m}/${y}`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Painel analítico do PRODES (desmatamento de 2020 em diante nos municípios). */
export function renderProdesAnalyticsHtml(data) {
  const total = Number(data?.total) || 0;
  const areaTotal = Number(data?.areaHa) || 0;
  const byYear = data?.byYear || {};
  const byMun = data?.byMun || {};
  const byRegiao = data?.byRegiao || {};
  const periodStart = data?.periodStart || '';
  const periodEnd = data?.periodEnd || '';

  if (!total) {
    return '<div class="analytic-empty">Nenhum desmatamento do PRODES desde 2020 nos municípios.</div>';
  }

  let mediaDiaria = 0;
  if (periodStart && periodEnd) {
    const days = Math.max(1, Math.ceil((new Date(periodEnd) - new Date(periodStart)) / 86400000));
    mediaDiaria = areaTotal / days;
  }
  const munEntries = Object.entries(byMun).sort((a, b) => b[1].area - a[1].area);
  const muniCount = munEntries.length;
  const topMunis = munEntries.slice(0, 5);
  const maxMuniArea = topMunis.length ? topMunis[0][1].area : 1;

  const regions = FAIXA_REGIOES
    .map((r) => ({ ...r, count: byRegiao[r.key]?.count || 0, area: byRegiao[r.key]?.area || 0 }))
    .filter((r) => r.count > 0);

  const years = Object.keys(byYear).sort();
  const maxYearArea = years.length ? Math.max(...years.map((y) => byYear[y].area)) : 1;

  const periodLabel = periodStart && periodEnd
    ? `${fmtDatePt(periodStart)} — ${fmtDatePt(periodEnd)}`
    : `Desde ${data?.minYear || 2020}`;

  const stackSegments = regions.map((r) => {
    const w = total ? (r.count / total) * 100 : 0;
    return `<div class="ap-reg-stack-seg" style="width:${w}%;background:${r.color}" title="${r.label}: ${r.count}"></div>`;
  }).join('');

  const regionCards = regions.map((r) => {
    const barW = total ? (r.count / total) * 100 : 0;
    return `<div class="ap-reg-card">
      <div class="ap-reg-card-head">
        <span class="ap-reg-dot" style="background:${r.color}"></span>
        <span class="ap-reg-name">${r.label}</span>
        <span class="ap-reg-count">${fmtInt(r.count)}</span>
      </div>
      <div class="ap-reg-bar-wrap"><div class="ap-reg-bar" style="width:${Math.max(2, barW)}%;background:${r.color}"></div></div>
      <div class="ap-reg-meta">
        <span>${fmtPct(r.count, total)} dos polígonos</span>
        <span>${fmtHaFull(r.area)} ha · ${fmtPct(r.area, areaTotal)} área</span>
      </div>
    </div>`;
  }).join('');

  const yGridPcts = [0, 25, 50, 75, 100];
  const yGridLines = yGridPcts.map((p) =>
    `<div class="ap-ygrid-line" style="bottom:${p}%"><span>${fmtHa(maxYearArea * p / 100, 0)}</span></div>`,
  ).join('');
  const yearCols = years.map((y) => {
    const pct = maxYearArea > 0 ? (byYear[y].area / maxYearArea) * 100 : 0;
    return `<div class="ap-ycol">
      <div class="ap-ycol-bar-wrap">
        <div class="ap-ycol-bar ap-ycol-bar-faixa" style="height:${Math.max(3, pct)}%" title="${y}: ${fmtInt(byYear[y].count)} polígonos · ${fmtHaFull(byYear[y].area)} ha"></div>
      </div>
      <div class="ap-ycol-lbl">${y.slice(2)}</div>
    </div>`;
  }).join('');

  const muniRows = topMunis.map(([nome, v]) => {
    const pct = (v.area / maxMuniArea) * 100;
    return `<div class="ap-muni-row">
      <div class="ap-muni-name" title="${esc(nome)}">${esc(nome)}</div>
      <div class="ap-muni-bar-wrap"><div class="ap-muni-bar" style="width:${Math.max(4, pct)}%"></div></div>
      <div class="ap-muni-count">${fmtHa(v.area, 0)} ha</div>
    </div>`;
  }).join('');

  return `
    <div class="ap-faixa-hero">
      <div class="ap-faixa-hero-kicker">PRODES · INPE · desde ${data?.minYear || 2020}</div>
      <div class="ap-faixa-hero-total">${fmtInt(total)}<span> polígonos de desmatamento</span></div>
      <div class="ap-faixa-hero-sub">${periodLabel}${muniCount ? ` · ${muniCount} município(s)` : ''}</div>
    </div>

    <div class="ap-metrics ap-metrics-grid">
      <div class="ap-metric ap-metric-accent">
        <div class="ap-metric-val">${fmtHaFull(areaTotal)}</div>
        <div class="ap-metric-lbl">hectares</div>
      </div>
      <div class="ap-metric">
        <div class="ap-metric-val">${fmtHa(total ? areaTotal / total : 0)}</div>
        <div class="ap-metric-lbl">ha / polígono</div>
      </div>
      <div class="ap-metric">
        <div class="ap-metric-val">${fmtHa(mediaDiaria)}</div>
        <div class="ap-metric-lbl">ha / dia</div>
      </div>
      <div class="ap-metric">
        <div class="ap-metric-val">${fmtInt(muniCount)}</div>
        <div class="ap-metric-lbl">municípios</div>
      </div>
    </div>

    ${regions.length > 1 ? `
    <div class="ap-section">
      <div class="ap-section-title">Distribuição por região</div>
      <div class="ap-reg-stack" aria-hidden="true">${stackSegments}</div>
      <div class="ap-reg-cards">${regionCards}</div>
    </div>` : ''}

    ${years.length ? `
    <div class="ap-section">
      <div class="ap-section-title">Área desmatada por ano (ha)</div>
      <div class="ap-year-chart">
        <div class="ap-ygrid">${yGridLines}</div>
        <div class="ap-ycols">${yearCols}</div>
      </div>
    </div>` : ''}

    ${topMunis.length ? `
    <div class="ap-section">
      <div class="ap-section-title">Municípios com mais área desmatada</div>
      <div class="ap-muni-list">${muniRows}</div>
    </div>` : ''}
  `;
}

