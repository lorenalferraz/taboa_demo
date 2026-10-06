/**
 * Laudo PDF da consulta TABOA × MapBiomas Alerta.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { renderSatelliteMap } = require('./mapaSatelite');
const { cruzarAreaConsulta, identificarMunicipios, identificarImoveisCadastrais, identificarRlAppDoImovel } = require('./cruzamentos');

const NAVY = '#002848';
const GOLD = '#e08818';
const MUTED = '#64748b';
const TEXT = '#0f172a';
const LINE = '#cbd5e1';
const CARD = '#f4f5f7';
const CARD_HIT = '#fff7ed';
const CELL_BG = '#eceff1';
const CELL_EDGE = '#d8dee4';
const CELL_OK_BG = '#e7efe3';
const CELL_OK_EDGE = '#9fb891';
const CELL_OK_TEXT = '#2f4a32';
const CELL_GAP = 4;
const CELL_PAD_X = 8;
const CELL_PAD_Y = 7;
const MARGIN = 42;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PAGE_LIMIT = PAGE_H - 78;

const FONT_REGULAR_CANDIDATES = [
  '/Library/Fonts/SF-Pro-Text-Regular.otf',
  path.join(__dirname, 'fonts', 'SF-Pro-Text-Regular.otf'),
];
const FONT_BOLD_CANDIDATES = [
  '/Library/Fonts/SF-Pro-Text-Bold.otf',
  path.join(__dirname, 'fonts', 'SF-Pro-Text-Bold.otf'),
];

function applyFonts(doc) {
  const regular = FONT_REGULAR_CANDIDATES.find((p) => fs.existsSync(p));
  const bold = FONT_BOLD_CANDIDATES.find((p) => fs.existsSync(p));
  if (regular && bold) {
    doc.registerFont('TaboaSans', regular);
    doc.registerFont('TaboaSans-Bold', bold);
    doc._sans = 'TaboaSans';
    doc._sansBold = 'TaboaSans-Bold';
    return;
  }
  doc._sans = 'Helvetica';
  doc._sansBold = 'Helvetica-Bold';
}

const LOGO_CANDIDATES = [
  path.join(__dirname, 'assets', 'taboa-marca-relatorio.png'),
  path.join(__dirname, 'assets', 'lg_taboa_semslogan.png'),
];

function findLogo() {
  return LOGO_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function nowPtBr(d = new Date()) {
  try {
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  } catch (_) {
    return d.toISOString();
  }
}

function txt(v) {
  const s = v == null ? '' : String(v);
  return s.trim() ? s : '—';
}

function formatHa(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2).replace('.', ',')} ha`;
}

function formatPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1).replace('.', ',')}%`;
}

function sourceLabel(source) {
  const map = {
    coords: 'Par de coordenadas',
    kml: 'Arquivo KML',
    'map-point': 'Ponto no mapa',
    'map-polygon': 'Polígono no mapa',
    'imovel-car': 'Imóvel rural (CAR)',
  };
  return map[source] || source || '—';
}

const FONTE_NOTAS = [
  { test: /deter/i, sigla: 'DETER', texto: 'Sistema de Detecção de Desmatamento em Tempo Real, do INPE.', url: 'http://www.obt.inpe.br/OBT/assuntos/programas/amazonia/deter' },
  { test: /glad/i, sigla: 'GLAD', texto: 'Global Land Analysis and Discovery, da University of Maryland.', url: 'https://glad.umd.edu' },
  { test: /inema/i, sigla: 'INEMA', texto: 'Instituto do Meio Ambiente e Recursos Hídricos da Bahia.', url: 'https://www.inema.ba.gov.br' },
  { test: /ief/i, sigla: 'IEF', texto: 'Instituto Estadual de Florestas de Minas Gerais.', url: 'https://www.ief.mg.gov.br' },
  { test: /prodes/i, sigla: 'PRODES', texto: 'Programa de Monitoramento do Desmatamento, do INPE.', url: 'http://www.obt.inpe.br/OBT/assuntos/programas/amazonia/prodes' },
  { test: /sad/i, sigla: 'SAD', texto: 'Sistema de Alerta de Desmatamento, do Imazon, integrado ao MapBiomas Alerta.', url: 'https://imazon.org.br' },
  { test: /sipam/i, sigla: 'SIPAM SAR', texto: 'Sistema de Proteção da Amazônia, com imagens de radar.', url: 'https://www.gov.br/sipam' },
  { test: /sirad/i, sigla: 'Sirad-X', texto: 'Sistema de alerta de desmatamento por radar.', url: 'https://plataforma.alerta.mapbiomas.org' },
  { test: /sos/i, sigla: 'SOS Mata Atlântica / INPE', texto: 'Monitoramento da Mata Atlântica pela Fundação SOS Mata Atlântica e pelo INPE.', url: 'https://www.sosma.org.br' },
];

function collectFonteNotas(alerts) {
  const notes = [];
  const seen = new Set();
  for (const a of alerts || []) {
    const fonte = String(a.fonte || a.sinal || '');
    for (const n of FONTE_NOTAS) {
      if (!n.test.test(fonte)) continue;
      if (seen.has(n.sigla)) continue;
      seen.add(n.sigla);
      notes.push(n);
    }
  }
  if ((alerts || []).length) {
    notes.push({
      sigla: 'MapBiomas Alerta',
      texto: 'Plataforma que consolida as fontes acima.',
      url: 'https://plataforma.alerta.mapbiomas.org',
    });
  }
  return notes;
}

function markFonte(value) {
  const s = txt(value);
  if (s === '—') return s;
  return `${s} *`;
}

function municipioLabel(raw) {
  if (raw?.mun) return txt(raw.mun);
  const m = raw?.municipio;
  if (!m) return '—';
  const nome = m.municipio || m.nome;
  if (!nome) return '—';
  return `${nome}/${m.uf || 'BA'}`;
}

function coordLabel(raw) {
  if (raw?.coord) return txt(raw.coord);
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }
  return '—';
}

function areaLabel(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return formatHa(value);
  const s = String(value);
  return s.replace(/(\d+),(\d{4}) ha/, (_, a, b) => `${a},${b.slice(0, 2)} ha`);
}

function isPointBuffer(raw) {
  return raw.mode === 'buffer' || raw.kind === 'point';
}

function preparePayload(raw = {}) {
  const generatedAt = String(raw.generatedAt || '').trim() || nowPtBr();
  const alerts = Array.isArray(raw.alerts) ? raw.alerts : [];
  return {
    generatedAt,
    origem: raw.origem || sourceLabel(raw.source),
    showBuffer: isPointBuffer(raw),
    coord: coordLabel(raw),
    mun: municipioLabel(raw),
    areaHa: areaLabel(raw.areaHa),
    nAlertas: raw.nAlertas != null ? String(raw.nAlertas) : String(alerts.length),
    overlapPct: raw.overlapPctLabel || formatPct(raw.overlapPct),
    overlapHa: areaLabel(raw.overlapHa),
    alerts,
    aoi: raw.aoi,
    clips: raw.clips,
    point: raw.point,
    nome: txt(raw.nome),
    cpf: txt(raw.cpf),
  };
}

function drawHeader(doc, generatedAt) {
  const logo = findLogo();
  const top = 24;
  const rowH = 42;
  const cellW = CONTENT_W / 2;
  const logoH = 30;
  const logoY = top + (rowH - logoH) / 2;
  if (logo) {
    try { doc.image(logo, MARGIN, logoY, { height: logoH }); } catch (_) {}
  }
  const title = 'LAUDO DE ANÁLISE DE ÁREA'.toLocaleUpperCase('pt-BR');
  const titleSize = 13;
  doc.fillColor(NAVY).font(doc._sansBold).fontSize(titleSize);
  const lineH = doc.currentLineHeight();
  const titleY = top + (rowH - lineH) / 2;
  doc.text(title, MARGIN + cellW, titleY, {
    width: cellW,
    align: 'right',
    lineBreak: false,
    lineGap: 0,
  });
  const rowBottom = top + rowH;
  doc.moveTo(MARGIN, rowBottom + 6).lineTo(PAGE_W - MARGIN, rowBottom + 6)
    .strokeColor(GOLD).lineWidth(1.6).stroke();
  doc.fillColor(MUTED).font(doc._sans).fontSize(7.5)
    .text(`Gerado em ${generatedAt}`, MARGIN, rowBottom + 12, { width: CONTENT_W });
  return rowBottom + 30;
}

function drawFooter(doc) {
  const notes = doc._taboaFonteNotas || [];
  const noteH = notes.length ? 4 + notes.length * 8 : 0;
  const y = PAGE_H - 26 - noteH;
  doc.moveTo(MARGIN, y - 8).lineTo(PAGE_W - MARGIN, y - 8)
    .strokeColor(LINE).lineWidth(0.6).stroke();
  doc.fillColor(MUTED).font(doc._sans).fontSize(7.5)
    .text('Tabôa · Módulo de Desmatamento', MARGIN, y, { width: CONTENT_W / 2, lineBreak: false });
  doc.text(`Página ${doc._taboaPage || 1}`, MARGIN, y, { width: CONTENT_W, align: 'right', lineBreak: false });
  notes.forEach((n, i) => {
    doc.font(doc._sans).fontSize(6.4).fillColor(MUTED)
      .text(`* ${n.sigla} — ${n.texto} ${n.url}`, MARGIN, y + 12 + i * 8, {
        width: CONTENT_W,
        lineBreak: false,
      });
  });
}

function syncCursor(doc, y) {
  doc.x = MARGIN;
  doc.y = Math.min(Math.max(0, y), PAGE_LIMIT - 8);
}

function ensureSpace(doc, y, need) {
  if (y + need <= PAGE_LIMIT) {
    syncCursor(doc, y);
    return y;
  }
  drawFooter(doc);
  doc.addPage({ margin: 0, size: 'A4' });
  doc._taboaPage = (doc._taboaPage || 1) + 1;
  const ny = drawHeader(doc, doc._taboaGeneratedAt);
  syncCursor(doc, ny);
  return ny;
}

function drawSectionTitle(doc, y, title) {
  y = ensureSpace(doc, y, 26);
  doc.fillColor(NAVY).font(doc._sansBold).fontSize(10)
    .text(title, MARGIN, y, { lineBreak: false });
  doc.moveTo(MARGIN, y + 13).lineTo(PAGE_W - MARGIN, y + 13)
    .strokeColor(GOLD).lineWidth(1.15).stroke();
  syncCursor(doc, y + 20);
  return y + 20;
}

function nextRowSize(remaining) {
  if (remaining <= 0) return 0;
  if (remaining === 4) return 2;
  if (remaining >= 3) return 3;
  return remaining;
}

function measureCellH(doc, it, w) {
  const inner = Math.max(24, w - CELL_PAD_X * 2);
  doc.font(doc._sans).fontSize(8.5);
  const valueH = Math.max(11, doc.heightOfString(txt(it.value), { width: inner, lineGap: 1 }));
  return CELL_PAD_Y + 12 + valueH + CELL_PAD_Y;
}

function drawInfoTable(doc, y, items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return y;
  let i = 0;
  while (i < list.length) {
    if (list[i].fullWidth) {
      const it = list[i];
      const w = CONTENT_W;
      const rowH = Math.max(42, measureCellH(doc, it, w));
      y = ensureSpace(doc, y, rowH + CELL_GAP + 2);
      const ok = it.tone === 'ok';
      doc.save();
      doc.fillColor(ok ? CELL_OK_BG : CELL_BG).strokeColor(ok ? CELL_OK_EDGE : CELL_EDGE).lineWidth(ok ? 0.8 : 0.4);
      doc.roundedRect(MARGIN, y, w, rowH, 2).fillAndStroke();
      doc.restore();
      doc.fillColor(ok ? CELL_OK_TEXT : TEXT).font(doc._sansBold).fontSize(6.5)
        .text(String(it.label || ''), MARGIN + CELL_PAD_X, y + CELL_PAD_Y, {
          width: w - CELL_PAD_X * 2,
          lineBreak: false,
        });
      doc.fillColor(ok ? CELL_OK_TEXT : TEXT).font(doc._sans).fontSize(8.5)
        .text(txt(it.value), MARGIN + CELL_PAD_X, y + CELL_PAD_Y + 12, {
          width: w - CELL_PAD_X * 2,
          lineGap: 1,
        });
      y += rowH + CELL_GAP;
      i += 1;
      syncCursor(doc, y);
      continue;
    }
    const cols = nextRowSize(list.length - i);
    const row = list.slice(i, i + cols);
    const w = (CONTENT_W - CELL_GAP * (cols - 1)) / cols;
    const rowH = Math.max(42, ...row.map((it) => measureCellH(doc, it, w)));
    y = ensureSpace(doc, y, rowH + CELL_GAP + 2);
    row.forEach((it, c) => {
      const x = MARGIN + c * (w + CELL_GAP);
      const ok = it.tone === 'ok';
      doc.save();
      doc.fillColor(ok ? CELL_OK_BG : CELL_BG).strokeColor(ok ? CELL_OK_EDGE : CELL_EDGE).lineWidth(ok ? 0.8 : 0.4);
      doc.roundedRect(x, y, w, rowH, 2).fillAndStroke();
      doc.restore();
      doc.fillColor(ok ? CELL_OK_TEXT : TEXT).font(doc._sansBold).fontSize(6.5)
        .text(String(it.label || ''), x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: w - CELL_PAD_X * 2,
          lineBreak: false,
        });
      doc.fillColor(ok ? CELL_OK_TEXT : TEXT).font(doc._sans).fontSize(8.5)
        .text(txt(it.value), x + CELL_PAD_X, y + CELL_PAD_Y + 12, {
          width: w - CELL_PAD_X * 2,
          lineGap: 1,
        });
    });
    y += rowH + CELL_GAP;
    i += cols;
    syncCursor(doc, y);
  }
  return y + 6;
}

function drawCrossingIcon(doc, cx, cy, id, hit) {
  const c = hit ? GOLD : '#94a3b8';
  doc.save();
  doc.translate(cx, cy);
  doc.strokeColor(c).fillColor(c).lineWidth(1.3);
  if (id === 'uc' || id.startsWith('uc_')) {
    doc.polygon([0, -8], [7, -2], [4, 8], [-4, 8], [-7, -2]).stroke();
    doc.circle(0, 0, 2).fill();
  } else if (id === 'reserva_legal') {
    doc.moveTo(0, 8).lineTo(0, 1).stroke();
    doc.polygon([0, -8], [6, 2], [-6, 2]).stroke();
  } else if (id === 'app') {
    doc.moveTo(-7, -2).bezierCurveTo(-3, -6, 3, 2, 7, -2).stroke();
    doc.moveTo(-7, 4).bezierCurveTo(-3, 0, 3, 8, 7, 4).stroke();
  } else if (id === 'terra_indigena') {
    doc.moveTo(0, -8).lineTo(0, 8).stroke();
    doc.circle(0, -5, 2.4).stroke();
    doc.moveTo(-6, 1).lineTo(0, -1).lineTo(6, 1).stroke();
  } else if (id === 'quilombo') {
    doc.rect(-6, -2, 12, 9).stroke();
    doc.moveTo(-7, -2).lineTo(0, -8).lineTo(7, -2).stroke();
  } else {
    doc.rect(-7, 0, 5, 8).stroke();
    doc.rect(-1, -3, 8, 11).stroke();
  }
  doc.restore();
}

function drawUcTable(doc, y, ucs) {
  const rows = Array.isArray(ucs) ? ucs : [];
  if (!rows.length) return y;

  const title = rows.length === 1
    ? 'Unidade de conservação sobreposta'
    : 'Unidades de conservação sobrepostas';
  const TITLE_BG = '#cfd6dc';
  const TITLE_EDGE = '#b0b8c0';
  const titleH = 24;
  y = ensureSpace(doc, y, titleH + CELL_GAP + 2);
  doc.save();
  doc.fillColor(TITLE_BG).strokeColor(TITLE_EDGE).lineWidth(0.4);
  doc.roundedRect(MARGIN, y, CONTENT_W, titleH, 2).fillAndStroke();
  doc.restore();
  doc.fillColor(NAVY).font(doc._sansBold).fontSize(7.5)
    .text(title, MARGIN + CELL_PAD_X, y + 7, {
      width: CONTENT_W - CELL_PAD_X * 2,
      lineBreak: false,
    });
  y += titleH + CELL_GAP;
  syncCursor(doc, y);

  const wEsfera = 56;
  const wGrupo = 88;
  const wHa = 72;
  const wPct = 70;
  const wNome = CONTENT_W - wEsfera - wGrupo - wHa - wPct - CELL_GAP * 4;
  const cols = [
    { label: 'Esfera', w: wEsfera },
    { label: 'Nome', w: wNome },
    { label: 'Grupo SNUC', w: wGrupo },
    { label: 'Sobreposição', w: wHa },
    { label: '% de Sobreposição', w: wPct },
  ];

  for (const row of rows) {
    const values = [txt(row.esfera), txt(row.nome), txt(row.grupo), formatHa(row.areaHa), formatPct(row.pct)];
    const labelHs = cols.map((col) => {
      const inner = Math.max(18, col.w - CELL_PAD_X * 2);
      doc.font(doc._sansBold).fontSize(6);
      return Math.max(10, doc.heightOfString(col.label, { width: inner, lineGap: 0.3 }));
    });
    const valueHs = cols.map((col, i) => {
      const inner = Math.max(18, col.w - CELL_PAD_X * 2);
      doc.font(doc._sans).fontSize(8);
      return Math.max(11, doc.heightOfString(values[i], { width: inner, lineGap: 1 }));
    });
    const rowH = Math.max(
      48,
      ...cols.map((_, i) => CELL_PAD_Y + labelHs[i] + 2 + valueHs[i] + CELL_PAD_Y),
    );
    y = ensureSpace(doc, y, rowH + CELL_GAP + 2);
    let x = MARGIN;
    cols.forEach((col, i) => {
      const inner = Math.max(18, col.w - CELL_PAD_X * 2);
      doc.save();
      doc.fillColor(CELL_BG).strokeColor(CELL_EDGE).lineWidth(0.4);
      doc.roundedRect(x, y, col.w, rowH, 2).fillAndStroke();
      doc.restore();
      doc.fillColor(TEXT).font(doc._sansBold).fontSize(6)
        .text(col.label, x + CELL_PAD_X, y + CELL_PAD_Y, {
          width: inner,
          lineGap: 0.3,
        });
      doc.fillColor(TEXT).font(doc._sans).fontSize(8)
        .text(values[i], x + CELL_PAD_X, y + CELL_PAD_Y + labelHs[i] + 2, {
          width: inner,
          lineGap: 1,
        });
      x += col.w + CELL_GAP;
    });
    y += rowH + CELL_GAP;
    syncCursor(doc, y);
  }
  return y + 6;
}

function drawCrossingCards(doc, y, cruzamentos) {
  const items = cruzamentos || [];
  const cols = Math.max(items.length, 1);
  const gap = 6;
  const w = (CONTENT_W - gap * (cols - 1)) / cols;
  const h = 56;
  const iconH = 16;
  const innerGap = 3;
  y = ensureSpace(doc, y, h + 4);
  items.forEach((it, i) => {
    const x = MARGIN + i * (w + gap);
    doc.save();
    doc.fillColor(it.hit ? CARD_HIT : CARD).strokeColor(it.hit ? GOLD : LINE).lineWidth(it.hit ? 1.4 : 0.8);
    doc.roundedRect(x, y, w, h, 6).fillAndStroke();
    doc.restore();
    const sub = String(it.sub || '').trim();
    const caption = sub ? `${it.label}\n${sub}` : String(it.label || '');
    doc.font(doc._sansBold).fontSize(5.2);
    const capH = Math.min(
      28,
      Math.max(8, doc.heightOfString(caption, { width: w - 8, align: 'center', lineGap: 1 })),
    );
    const blockH = iconH + innerGap + capH;
    const start = y + Math.max(4, (h - blockH) / 2);
    drawCrossingIcon(doc, x + w / 2, start + iconH / 2, it.id, it.hit);
    doc.fillColor(it.hit ? NAVY : MUTED).font(doc._sansBold).fontSize(5.2)
      .text(caption, x + 4, start + iconH + innerGap, {
        width: w - 8,
        align: 'center',
        lineGap: 1,
        height: capH + 1,
      });
  });
  y += h + 8;
  const hits = items.filter((it) => it.hit);
  const misses = items.filter((it) => !it.hit);
  const otherHits = hits.filter((it) => it.id !== 'uc');
  const ucHit = hits.find((it) => it.id === 'uc');
  if (otherHits.length) {
    y = drawInfoTable(doc, y, otherHits.flatMap((it) => {
      const label = String(it.sub || '').trim() ? `${it.label} (${it.sub})` : it.label;
      if (it.id === 'reserva_legal') {
        const nomes = (it.nomes || []).map((n) => String(n || '').trim()).filter(Boolean);
        let value = nomes.join('\n') || 'área identificada';
        if (it.count > nomes.length) {
          value += `\n+${it.count - nomes.length} reserva(s) legal(is)`;
        }
        return [{
          label: it.label,
          value,
          fullWidth: true,
        }];
      }
      return [{
        label,
        value: `${(it.nomes || []).join(', ') || 'área identificada'}${it.count > (it.nomes || []).length ? '…' : ''}`,
      }];
    }));
  }
  if (ucHit) {
    y = drawUcTable(doc, y, ucHit.ucs || []);
  }
  if (misses.length) {
    const nomes = misses.map((it) => String(it.label || '').trim()).filter(Boolean);
    let lista = nomes.join(', ');
    if (nomes.length === 1) lista = nomes[0];
    else if (nomes.length === 2) lista = `${nomes[0]} e ${nomes[1]}`;
    else if (nomes.length > 2) lista = `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`;
    y = drawInfoTable(doc, y, [{
      label: 'Sem sobreposição',
      value: `Não houve sobreposição com ${lista}.`,
      tone: 'ok',
      fullWidth: true,
    }]);
  }
  return y;
}

function linhasImoveisCadastrais(imoveis) {
  const list = Array.isArray(imoveis) ? imoveis : [];
  if (!list.length) {
    return [{ label: 'Propriedade', value: 'Não identificada no cadastro de imóveis rurais.' }];
  }
  const withPct = list.length > 1;
  if (!withPct) {
    const im = list[0];
    const rows = [{ label: 'Propriedade', value: im.nome || 'Imóvel rural' }];
    if (im.car) rows.push({ label: 'CAR/CEFIR', value: im.car });
    return rows;
  }
  const value = list.map((im) => {
    const car = im.car ? `CAR/CEFIR ${im.car}` : '';
    const pct = formatPct(im.pct);
    const parts = [im.nome || 'Imóvel rural'];
    if (car) parts.push(car);
    parts.push(pct);
    return parts.join(' — ');
  }).join('\n');
  return [{ label: 'Propriedades', value, fullWidth: true }];
}

function geometriaCadastral(raw, prepared) {
  if (prepared.showBuffer && prepared.coord !== '—') {
    return prepared.coord;
  }
  if (raw.source === 'map-polygon' || raw.kind === 'polygon') {
    return 'Área desenhada no mapa';
  }
  if (raw.source === 'kml') {
    return raw.kind === 'point' ? prepared.coord : 'Polígono do arquivo KML';
  }
  if (raw.source === 'imovel-car') {
    return raw.car ? `Polígono do imóvel rural (CAR ${raw.car})` : 'Polígono do imóvel rural (CAR)';
  }
  return prepared.coord !== '—' ? prepared.coord : prepared.origem;
}

function drawAlertLaudo(doc, y, alert, mun, index, total) {
  const title = total > 1 ? `LAUDO DO ALERTA (${index} de ${total})` : 'LAUDO DO ALERTA';
  y = drawSectionTitle(doc, y, title);
  y = drawInfoTable(doc, y, [
    { label: 'Código do alerta', value: alert.codigo || alert.alertCode },
    { label: 'Área do alerta', value: alert.areaOriginal || formatHa(alert.areaHa) },
    { label: 'Fonte do alerta', value: markFonte(alert.fonte || alert.sinal) },
    { label: 'Biomas', value: alert.bioma },
    { label: 'Município / UF', value: alert.municipio || mun },
    { label: 'Data do alerta', value: alert.detectado || alert.detectedAt },
    { label: 'Tamanho da sobreposição', value: alert.areaRecorte || formatHa(alert._clippedAreaHa) },
    { label: 'Sobreposição', value: alert.sobreposicao },
  ]);
  return y;
}

function drawMapa(doc, y, mapImg) {
  const title = 'RESULTADO VISUAL DA CONSULTA';
  const titleH = 22;
  if (mapImg?.png) {
    const ratio = mapImg.height / Math.max(mapImg.width, 1);
    let imgW = CONTENT_W;
    let imgH = imgW * ratio;
    const gap = 8;
    if (y + titleH + imgH + gap > PAGE_LIMIT) {
      y = ensureSpace(doc, y, titleH + imgH + gap);
    }
    const avail = PAGE_LIMIT - y - titleH - gap;
    if (imgH > avail) {
      const scale = Math.max(avail, 160) / imgH;
      imgH *= scale;
      imgW *= scale;
    }
    y = drawSectionTitle(doc, y, title);
    syncCursor(doc, y);
    try {
      doc.image(mapImg.png, MARGIN, y, { width: imgW, height: imgH });
    } catch (_) {
      doc.fillColor(MUTED).font(doc._sans).fontSize(9)
        .text('Não foi possível inserir o mapa de satélite.', MARGIN, y, { lineBreak: false });
      imgH = 14;
    }
    y += imgH + gap;
    syncCursor(doc, y);
    return y;
  }
  y = drawSectionTitle(doc, y, title);
  doc.fillColor(MUTED).font(doc._sans).fontSize(9)
    .text('Mapa indisponível para esta consulta.', MARGIN, y);
  return y + 16;
}

/**
 * @param {object} payload
 * @returns {Promise<Buffer>}
 */
async function buildConsultaPdf(raw = {}) {
  const payload = preparePayload(raw);
  const generatedAt = payload.generatedAt;
  let mapImg = null;
  let cruzamentos = [];
  let municipiosShape = [];
  let imoveisCadastro = [];
  try {
    cruzamentos = await cruzarAreaConsulta(payload.aoi);
  } catch (e) {
    console.error('Falha nos cruzamentos do laudo:', e.message || e);
  }
  try {
    municipiosShape = await identificarMunicipios(payload.aoi);
  } catch (e) {
    console.error('Falha ao identificar município no shape:', e.message || e);
  }
  if (municipiosShape.length) {
    payload.mun = municipiosShape.join(', ');
  }
  try {
    const pt = Array.isArray(payload.point) && payload.point.length >= 2
      ? payload.point
      : [Number(raw.lng), Number(raw.lat)];
    imoveisCadastro = await identificarImoveisCadastrais({
      aoiGeom: payload.aoi,
      point: pt,
      isPoint: !!payload.showBuffer,
    });
  } catch (e) {
    console.error('Falha ao identificar imóvel rural no laudo:', e.message || e);
  }
  const imoveisNoMapa = imoveisCadastro.filter((im) => im.geometry);
  let rlAppImovel = { rl: [], app: [] };
  try {
    rlAppImovel = await identificarRlAppDoImovel(imoveisCadastro);
  } catch (e) {
    console.error('Falha ao identificar RL/APP do imóvel no laudo:', e.message || e);
  }
  try {
    mapImg = await renderSatelliteMap({
      aoi: payload.aoi,
      clips: payload.clips,
      point: payload.point,
      frameGeoms: imoveisNoMapa.map((im) => im.geometry),
      overlays: [
        ...imoveisNoMapa.map((im) => ({
          id: 'imovel_rural',
          legend: 'Imóvel rural',
          fill: '#facc15',
          stroke: '#ca8a04',
          geom: im.geometry,
        })),
        ...(rlAppImovel.rl || []).map((f) => ({
          id: 'reserva_legal',
          legend: 'Reserva legal do imóvel',
          fill: '#86efac',
          stroke: '#166534',
          geom: f.geometry,
        })),
        ...(rlAppImovel.app || []).map((f) => ({
          id: 'app',
          legend: 'APP do imóvel',
          fill: '#67e8f9',
          stroke: '#0e7490',
          geom: f.geometry,
        })),
        ...cruzamentos.flatMap((c) => {
          if (!c.hit) return [];
          const jaTemDoImovel = (c.id === 'reserva_legal' && rlAppImovel.rl?.length)
            || (c.id === 'app' && rlAppImovel.app?.length);
          if (jaTemDoImovel) return [];
          if (Array.isArray(c.overlays) && c.overlays.length) return c.overlays;
          return (c.geoms || []).map((geom) => ({
            id: c.id,
            legend: c.legend,
            fill: c.fill,
            stroke: c.stroke,
            geom,
          }));
        }),
      ],
    });
  } catch (e) {
    console.error('Falha ao montar mapa de satélite do relatório:', e.message || e);
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: true,
      info: {
        Title: 'LAUDO DE ANÁLISE DE ÁREA'.toLocaleUpperCase('pt-BR'),
        Author: 'TABOA',
        Subject: 'Cruzamento de área com alertas MapBiomas e camadas territoriais',
        CreationDate: new Date(),
      },
    });
    doc._taboaGeneratedAt = generatedAt;
    doc._taboaPage = 1;
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    applyFonts(doc);
    doc._taboaFonteNotas = collectFonteNotas(payload.alerts);

    let y = drawHeader(doc, generatedAt);

    y = drawSectionTitle(doc, y, 'INFORMAÇÕES CADASTRAIS');
    const cadastro = [
      { label: 'Nome', value: payload.nome },
      { label: 'CPF', value: payload.cpf },
      { label: 'Origem da inserção', value: payload.origem },
      { label: payload.showBuffer ? 'Coordenadas' : 'Área inserida', value: geometriaCadastral(raw, payload) },
      { label: 'Município / UF', value: payload.mun },
      { label: 'Área de análise', value: payload.areaHa },
    ];
    if (payload.showBuffer) {
      cadastro.push({ label: 'Buffer aplicado', value: '500 m' });
    }
    cadastro.push(...linhasImoveisCadastrais(imoveisCadastro));
    y = drawInfoTable(doc, y, cadastro);

    y = drawSectionTitle(doc, y, 'RESULTADO ANALÍTICO DA CONSULTA');
    const alerts = payload.alerts || [];
    if (!alerts.length) {
      y = drawInfoTable(doc, y, [
        { label: 'Sobreposição com alerta', value: 'Sobreposição não identificada com alertas.', tone: 'ok' },
      ]);
    } else {
      y = drawInfoTable(doc, y, [
        { label: 'Sobreposição com alerta', value: 'Identificada' },
        { label: 'Alertas na área', value: String(alerts.length) },
        { label: 'Tamanho da sobreposição', value: payload.overlapHa },
        { label: 'Percentual sobreposto', value: payload.overlapPct },
      ]);
      alerts.forEach((alert, i) => {
        y = drawAlertLaudo(doc, y, alert, payload.mun, i + 1, alerts.length);
      });
    }

    y = drawSectionTitle(doc, y, 'RESTRIÇÕES LEGAIS ANALISADAS');
    y = drawCrossingCards(doc, y, cruzamentos);

    y = drawMapa(doc, y, mapImg);

    drawFooter(doc);
    doc.end();
  });
}

module.exports = { buildConsultaPdf, nowPtBr, formatHa, formatPct };
