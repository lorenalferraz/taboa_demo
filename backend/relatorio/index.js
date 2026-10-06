/**
 * Relatório PDF da Consulta TABOA.
 * Toda a lógica de geração fica nesta pasta.
 */
const { buildConsultaPdf, nowPtBr } = require('./consultaPdf');

function readJsonBody(req, maxBytes = 8e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxBytes) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

function stamp(payload) {
  return { ...payload, generatedAt: nowPtBr() };
}

/**
 * POST /api/consulta/relatorio
 * Corpo JSON com o resumo da consulta; responde application/pdf.
 */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

async function runProbe(probe) {
  if (probe === 'echo') return { ok: true, probe };
  if (probe === 'req-pdf') return { ok: true, probe, t: typeof require('pdfkit') };
  if (probe === 'req-sharp') return { ok: true, probe, t: typeof require('sharp') };
  if (probe === 'req-turf') return { ok: true, probe, t: typeof require('@turf/turf') };
  if (probe === 'font') {
    const PDFDocument = require('pdfkit');
    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 42 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.font('Helvetica').fontSize(12).text('ok');
      doc.end();
    });
    return { ok: true, probe, bytes: pdf.length };
  }
  if (probe === 'sharp') {
    const sharp = require('sharp');
    const buf = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 20, b: 20 } },
    }).jpeg().toBuffer();
    return { ok: true, probe, bytes: buf.length };
  }
  if (probe === 'turf') {
    const turf = require('@turf/turf');
    const b = turf.bbox(turf.point([-39.29936, -15.864784]));
    return { ok: true, probe, bbox: b };
  }
  return null;
}

async function handleConsultaRelatorioPdf(req, res, probe = '') {
  if (probe) {
    try {
      const found = await runProbe(probe);
      if (!found) {
        sendJson(res, 400, { ok: false, error: 'probe desconhecida' });
        return;
      }
      sendJson(res, 200, found);
    } catch (e) {
      sendJson(res, 500, { ok: false, probe, error: String(e && e.stack || e) });
    }
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify({ ok: false, error: 'JSON inválido no corpo do pedido.' }));
    return;
  }
  try {
    const pdf = await buildConsultaPdf(stamp(body || {}));
    const day = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="consulta-taboa-${day}.pdf"`,
      'Content-Length': pdf.length,
      ...CORS,
    });
    res.end(pdf);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
}

module.exports = {
  handleConsultaRelatorioPdf,
  buildConsultaPdf,
  nowPtBr,
};
