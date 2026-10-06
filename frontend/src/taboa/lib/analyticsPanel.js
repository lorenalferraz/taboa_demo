/** Configuração visual das regiões TABOA (05/06/07). */
export const FAIXA_REGIOES = [
  { key: 'litoral_sul', label: '05 Litoral Sul', color: '#ef4444' },
  { key: 'baixo_sul', label: '06 Baixo Sul', color: '#f59e0b' },
  { key: 'extremo_sul', label: '07 Extremo Sul', color: '#a855f7' },
  { key: 'divisa', label: 'Divisa', color: '#06b6d4' },
];

export function isFaixaAlertsMode(alerts) {
  return Array.isArray(alerts) && alerts.some((a) => a._regiaoTaboa);
}

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

export function buildFaixaAnalytics(alerts) {
  const regions = {};
  for (const r of FAIXA_REGIOES) {
    regions[r.key] = { ...r, count: 0, area: 0 };
  }

  let areaTotal = 0;
  const byYear = {};
  const muniCounts = {};
  const dates = [];

  for (const a of alerts) {
    const ha = Number(a.areaHa) || 0;
    areaTotal += ha;

    const reg = a._regiaoTaboa;
    if (reg && regions[reg]) {
      regions[reg].count += 1;
      regions[reg].area += ha;
    }

    const dt = a.detectedAt || '';
    if (dt) {
      dates.push(dt);
      const yr = dt.slice(0, 4);
      if (!byYear[yr]) byYear[yr] = { count: 0, area: 0 };
      byYear[yr].count += 1;
      byYear[yr].area += ha;
    }

    for (const m of a._munNomesInFaixa || []) {
      if (m) muniCounts[m] = (muniCounts[m] || 0) + 1;
    }
  }

  dates.sort();
  let mediaDiaria = 0;
  if (dates.length > 1) {
    const days = Math.max(
      1,
      Math.ceil((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000),
    );
    mediaDiaria = areaTotal / days;
  }

  const total = alerts.length;
  const regionList = FAIXA_REGIOES
    .map((r) => regions[r.key])
    .filter((r) => r.count > 0);

  const topMunis = Object.entries(muniCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const years = Object.keys(byYear).sort();
  const maxYearCount = years.length ? Math.max(...years.map((y) => byYear[y].count)) : 1;

  return {
    total,
    areaTotal,
    mediaDiaria,
    mediaPorAlerta: total ? areaTotal / total : 0,
    muniCount: Object.keys(muniCounts).length,
    periodStart: dates[0] || '',
    periodEnd: dates[dates.length - 1] || '',
    regions: regionList,
    byYear,
    years,
    maxYearCount,
    topMunis,
    maxMuniCount: topMunis.length ? topMunis[0][1] : 1,
  };
}

export function renderFaixaAnalyticsHtml(stats) {
  const {
    total, areaTotal, mediaDiaria, mediaPorAlerta, muniCount,
    periodStart, periodEnd, regions, byYear, years, maxYearCount, topMunis, maxMuniCount,
  } = stats;

  const periodLabel = periodStart && periodEnd
    ? `${fmtDatePt(periodStart)} — ${fmtDatePt(periodEnd)}`
    : 'Período do filtro';

  const sourceKicker = 'MapBiomas · faixa 05/06/07';

  const sourceLegend = '';

  const stackSegments = regions.map((r) => {
    const w = total ? (r.count / total) * 100 : 0;
    return `<div class="ap-reg-stack-seg" style="width:${w}%;background:${r.color}" title="${r.label}: ${r.count}"></div>`;
  }).join('');

  const regionCards = regions.map((r) => {
    const pctCount = fmtPct(r.count, total);
    const barW = total ? (r.count / total) * 100 : 0;
    return `<div class="ap-reg-card">
      <div class="ap-reg-card-head">
        <span class="ap-reg-dot" style="background:${r.color}"></span>
        <span class="ap-reg-name">${r.label}</span>
        <span class="ap-reg-count">${fmtInt(r.count)}</span>
      </div>
      <div class="ap-reg-bar-wrap"><div class="ap-reg-bar" style="width:${Math.max(2, barW)}%;background:${r.color}"></div></div>
      <div class="ap-reg-meta">
        <span>${pctCount} dos alertas</span>
        <span>${fmtHaFull(r.area)} ha · ${fmtPct(r.area, areaTotal)} área</span>
      </div>
    </div>`;
  }).join('');

  const yGridPcts = [0, 25, 50, 75, 100];
  function fmtK(n) { return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n); }
  const yGridLines = yGridPcts.map((p) =>
    `<div class="ap-ygrid-line" style="bottom:${p}%"><span>${fmtK(Math.round(maxYearCount * p / 100))}</span></div>`,
  ).join('');
  const yearCols = years.map((y) => {
    const pct = maxYearCount > 0 ? (byYear[y].count / maxYearCount) * 100 : 0;
    return `<div class="ap-ycol">
      <div class="ap-ycol-bar-wrap">
        <div class="ap-ycol-bar ap-ycol-bar-faixa" style="height:${Math.max(3, pct)}%" title="${y}: ${byYear[y].count} alertas · ${fmtHaFull(byYear[y].area)} ha"></div>
      </div>
      <div class="ap-ycol-lbl">${y.slice(2)}</div>
    </div>`;
  }).join('');

  const muniRows = topMunis.map(([nome, n]) => {
    const pct = (n / maxMuniCount) * 100;
    return `<div class="ap-muni-row">
      <div class="ap-muni-name" title="${nome}">${nome}</div>
      <div class="ap-muni-bar-wrap"><div class="ap-muni-bar" style="width:${Math.max(4, pct)}%"></div></div>
      <div class="ap-muni-count">${n}</div>
    </div>`;
  }).join('');

  return `
    <div class="ap-faixa-hero">
      <div class="ap-faixa-hero-kicker">${sourceKicker}</div>
      <div class="ap-faixa-hero-total">${fmtInt(total)}<span> alertas</span></div>
      <div class="ap-faixa-hero-sub">${periodLabel}${muniCount ? ` · ${muniCount} município(s)` : ''}</div>
      ${sourceLegend}
    </div>

    <div class="ap-metrics ap-metrics-grid">
      <div class="ap-metric ap-metric-accent">
        <div class="ap-metric-val">${fmtHaFull(areaTotal)}</div>
        <div class="ap-metric-lbl">hectares</div>
      </div>
      <div class="ap-metric">
        <div class="ap-metric-val">${fmtHa(mediaPorAlerta)}</div>
        <div class="ap-metric-lbl">ha / alerta</div>
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

    <div class="ap-section">
      <div class="ap-section-title">Distribuição por região</div>
      <div class="ap-reg-stack" aria-hidden="true">${stackSegments}</div>
      <div class="ap-reg-cards">${regionCards}</div>
    </div>

    ${years.length ? `
    <div class="ap-section">
      <div class="ap-section-title">Evolução anual</div>
      <div class="ap-year-chart">
        <div class="ap-ygrid">${yGridLines}</div>
        <div class="ap-ycols">${yearCols}</div>
      </div>
    </div>` : ''}

    ${topMunis.length ? `
    <div class="ap-section">
      <div class="ap-section-title">Municípios com mais alertas</div>
      <div class="ap-muni-list">${muniRows}</div>
    </div>` : ''}
  `;
}
