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
async function handleConsultaRelatorioPdf(req, res) {
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
