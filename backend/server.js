const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fetchIncraLayerByBbox } = require('./assentamentos');
const {
  municipioPorCoordenadaForApi,
  municipiosPorCoordenadasForApi,
  loadFeaturesByBbox,
  searchImoveisRurais,
  getImovelByIndex,
  ensureImoveisCatalog,
} = require('./localShapeLoader');
const { pruneScanFileCache } = require('./scanCacheFile');
const { handleConsultaRelatorioPdf } = require('./relatorio');

const PORT = process.env.PORT || 3000;

/** Lê o módulo de varredura na hora do pedido. Desestruturar no topo perde a função na Vercel. */
function scanApi() {
  const loaded = require('./scanMapbiomas');
  if (loaded && typeof loaded.runScan === 'function') return loaded;
  if (loaded && loaded.default && typeof loaded.default.runScan === 'function') return loaded.default;
  return loaded || {};
}

// Root = pasta backend
const ROOT = __dirname;

const MIME = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * Parse de CSV com separador ';' e suporte a campos entre aspas.
 * Converte a string (já decodificada de latin1) em array de objetos.
 */
function parseRegistrosCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  function splitCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = !inQ; }
      } else if (ch === ';' && !inQ) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  const headers = splitCsvLine(lines[0]);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]);
    if (fields.every((f) => !f)) continue;
    const rec = {};
    headers.forEach((h, idx) => { rec[h] = fields[idx] ?? ''; });
    records.push(rec);
  }
  return records;
}

function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

function serveFile(res, filePath, mime, extraHeaders = {}) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      }
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': Buffer.byteLength(data),
      ...CORS_HEADERS,
      ...extraHeaders,
    });
    res.end(data);
  });
}

/**
 * Comprime e envia resposta JSON com gzip quando o cliente aceita.
 * Fallback transparente para res.end(data) quando não há suporte.
 */
function sendJson(req, res, statusCode, headers, body) {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  const acceptEnc = String(req.headers['accept-encoding'] || '');
  const useGzip = acceptEnc.includes('gzip') && data.length > 512 && data.length < 4 * 1024 * 1024;
  if (!useGzip) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
      ...headers,
    });
    res.end(data);
    return;
  }
  zlib.gzip(data, { level: 6 }, (err, compressed) => {
    if (err) {
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
        ...headers,
      });
      res.end(data);
      return;
    }
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      'Vary': 'Accept-Encoding',
      ...headers,
    });
    res.end(compressed);
  });
}

const CORS_PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function readJsonBody(req, maxBytes = 2e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > maxBytes) req.destroy(); });
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let targetPath = url.pathname;

  if (targetPath !== '/' && targetPath.endsWith('/')) {
    targetPath = targetPath.slice(0, -1);
  }

  // CORS preflight (frontend Vite em outra porta)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_PREFLIGHT);
    res.end();
    return;
  }

  // GET /api/health — verificação leve (sem I/O pesado)
  if (targetPath === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true, service: 'taboa-backend', ts: Date.now() }));
    return;
  }

  /** Varredura MapBiomas no servidor (credenciais só aqui); resposta SSE. */
  if (targetPath === '/api/scan-alerts' && req.method === 'POST') {
    (async () => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: 'JSON inválido no corpo do pedido.' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...CORS_HEADERS
      });
      const send = (obj) => {
        try {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch (_) {}
      };
      const shapeDir = path.join(ROOT, 'shape');
      try {
        const runScan = scanApi().runScan;
        if (typeof runScan !== 'function') {
          send({ type: 'error', message: 'Varredura de alertas indisponível neste servidor.' });
        } else {
          await runScan(shapeDir, body, send);
        }
      } catch (e) {
        send({ type: 'error', message: String(e.message || e) });
      } finally {
        send({ type: 'done' });
        res.end();
      }
    })().catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      } else {
        try { res.end(); } catch (_) {}
      }
    });
    return;
  }

  // API: lista arquivos .geojson em backend/shape/
  if (targetPath === '/api/shape-files') {
    const shapeDir = path.join(ROOT, 'shape');
    const files = [];
    try {
      if (fs.existsSync(shapeDir)) {
        const entries = fs.readdirSync(shapeDir);
        for (const f of entries) {
          if (f.toLowerCase().endsWith('.geojson')) {
            files.push(f);
          }
        }
      }
    } catch (err) {
      // ignore
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(files));
    return;
  }

  // GET /api/faixa/geojson — shape oficial 05/06/07 (backend/shape/)
  if (targetPath === '/api/faixa/geojson' && req.method === 'GET') {
    (async () => {
      try {
        const loadFaixaShapeFromDir = scanApi().loadFaixaShapeFromDir;
        if (typeof loadFaixaShapeFromDir !== 'function') {
          throw new Error('loadFaixaShapeFromDir is not a function');
        }
        const loaded = await loadFaixaShapeFromDir(null);
        if (!loaded) {
          res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ ok: false, error: 'Shape oficial da faixa não encontrado em backend/shape/.' }));
          return;
        }
        sendJson(req, res, 200, { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' }, JSON.stringify({
          ok: true,
          geojson: loaded.geojson,
          filename: loaded.faixaName,
          source: loaded.source || 'shape_oficial',
        }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
      }
    })();
    return;
  }

  // /shape/* -> backend/shape/*
  if (targetPath.startsWith('/shape/')) {
    const sub = targetPath.slice('/shape/'.length);
    if (!sub || sub.includes('..')) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Not Found');
      return;
    }
    const filePath = path.join(ROOT, 'shape', sub);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const mime = getMime(sub);
      const cacheHeaders =
        mime.includes('json') || sub.toLowerCase().endsWith('.geojson')
          ? { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
          : {};
      serveFile(res, filePath, mime, cacheHeaders);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      res.end('Not Found');
    }
    return;
  }

  /**
   * Municípios da faixa TABOA (shape local).
   * GET /api/ibge/municipios?uf=BA
   */
  if (targetPath === '/api/ibge/municipios' && req.method === 'GET') {
    const ufParam = String(url.searchParams.get('uf') || 'BA').trim().toUpperCase();
    const all = ufParam === 'ALL';
    const municipios = FAIXA_MUNICIPIOS
      .filter(() => all || ufParam === 'BA')
      .map((m) => ({ id: m.ibge, nome: m.nomMun, uf: 'BA' }));
    sendJson(req, res, 200, { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=86400' }, JSON.stringify({
      ok: true,
      uf: all ? 'ALL' : ufParam,
      municipios,
    }));
    return;
  }

  /**
   * Município da faixa a partir de coordenadas (municipios.geojson).
   * GET ?lat=&lng=
   */
  if (targetPath === '/api/ibge/municipio-por-coordenada' && req.method === 'GET') {
    (async () => {
      const qp = url.searchParams;
      const lat = qp.get('lat') ?? qp.get('latitude');
      const lng = qp.get('lng') ?? qp.get('lon') ?? qp.get('longitude');
      if (lat == null || lng == null || String(lat).trim() === '' || String(lng).trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Parâmetros lat e lng são obrigatórios (WGS84).' }));
        return;
      }
      const out = await municipioPorCoordenadaForApi(lat, lng);
      let status = 200;
      if (!out.ok) {
        if (out.error && (out.error.includes('inválid') || out.error.includes('obrigat') || out.error.includes('fora'))) {
          status = out.error.includes('faixa') ? 404 : 400;
        } else {
          status = 404;
        }
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
      res.end(JSON.stringify(out));
    })().catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  /**
   * Localidades da faixa em lote (aba Consulta).
   * POST JSON { points: [{ id, lat, lng }] }
   */
  if (targetPath === '/api/consulta/localidades' && req.method === 'POST') {
    (async () => {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'JSON inválido no corpo do pedido.' }));
        return;
      }
      const out = await municipiosPorCoordenadasForApi(body.points || []);
      res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(out));
    })().catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  // API: lista arquivos .csv em backend/registros/
  if (targetPath === '/api/registros') {
    const dir = path.join(ROOT, 'registros');
    let files = [];
    try {
      if (fs.existsSync(dir)) {
        files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f));
      }
    } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ files }));
    return;
  }

  // /registros/:filename → parse CSV latin1→UTF-8, retorna JSON
  if (targetPath.startsWith('/registros/')) {
    const filename = path.basename(targetPath.slice('/registros/'.length));
    if (!filename || !filename.endsWith('.csv')) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: 'Arquivo inválido' }));
      return;
    }
    const filePath = path.join(ROOT, 'registros', filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: 'Arquivo não encontrado' }));
      return;
    }
    try {
      const rawBuf = fs.readFileSync(filePath);
      // latin1 = ISO-8859-1: cada byte mapeia diretamente para o code point Unicode
      const text = rawBuf.toString('latin1');
      const records = parseRegistrosCsv(text);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
      res.end(JSON.stringify(records));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  // GET /api/local/incra?layer=assentamentos&uf=BA&bbox=west,south,east,north
  if (targetPath === '/api/local/incra' && req.method === 'GET') {
    (async () => {
      const layer = String(url.searchParams.get('layer') || '').trim();
      const uf = String(url.searchParams.get('uf') || '').trim().toUpperCase();
      const municipio = String(url.searchParams.get('municipio') || '').trim();
      const raw = url.searchParams.get('bbox') || '';
      const parts = raw.split(',').map((s) => parseFloat(s.trim()));
      if (!layer || !uf) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Parâmetros layer e uf são obrigatórios.' }));
        return;
      }
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Parâmetro bbox obrigatório: west,south,east,north' }));
        return;
      }
      const result = await fetchIncraLayerByBbox(layer, uf, parts, { municipioNome: municipio });
      if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: result.error, typeName: result.typeName || null }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({
        ok: true,
        typeName: result.typeName,
        geojson: result.geojson,
        total: result.total,
        totalRaw: result.totalRaw ?? result.total,
        truncated: !!result.truncated,
        filterMode: result.filterMode || 'bbox',
      }));
    })().catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  // GET /api/shape/features?file=app.geojson&bbox=w,s,e,n
  if (targetPath === '/api/shape/features' && req.method === 'GET') {
    const allowed = new Set(['app.geojson', 'reserva_legal.geojson', 'imoveis_rurais.geojson']);
    const file = path.basename(String(url.searchParams.get('file') || ''));
    if (!allowed.has(file)) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: 'Arquivo não permitido.' }));
      return;
    }
    const bbox = String(url.searchParams.get('bbox') || '').split(',').map(Number);
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw == null || limitRaw === '' ? 0 : Number(limitRaw);
    const forMap = String(url.searchParams.get('map') || '1') !== '0';
    (async () => {
      try {
        const geojson = await loadFeaturesByBbox(file, bbox, limit, { map: forMap });
        const feats = geojson.features || [];
        const acceptEnc = String(req.headers['accept-encoding'] || '');
        const useGzip = acceptEnc.includes('gzip');
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS,
          'Cache-Control': 'no-store',
        };
        let sink = res;
        if (useGzip) {
          headers['Content-Encoding'] = 'gzip';
          headers.Vary = 'Accept-Encoding';
          res.writeHead(200, headers);
          sink = zlib.createGzip({ level: 5 });
          sink.pipe(res);
        } else {
          res.writeHead(200, headers);
        }
        sink.write(`{"ok":true,"file":${JSON.stringify(file)},"geojson":{"type":"FeatureCollection","features":[`);
        for (let i = 0; i < feats.length; i++) {
          if (i) sink.write(',');
          sink.write(JSON.stringify(feats[i]));
        }
        const total = Number.isFinite(Number(geojson.total)) ? Number(geojson.total) : feats.length;
        sink.end(`],"truncated":false,"total":${total}}}`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
      }
    })();
    return;
  }

  // GET /api/shape/imoveis?q=&municipio=&limit=
  if (targetPath === '/api/shape/imoveis' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '');
    const municipio = String(url.searchParams.get('municipio') || '');
    const limit = Number(url.searchParams.get('limit') || 40);
    searchImoveisRurais({ q, municipio, limit }).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, ...result }));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }

  // GET /api/shape/imovel?i=
  if (targetPath === '/api/shape/imovel' && req.method === 'GET') {
    const i = Number(url.searchParams.get('i'));
    try {
      const feature = getImovelByIndex(i);
      if (!feature) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: 'Imóvel não encontrado.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true, feature }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  // POST /api/consulta/relatorio — PDF da consulta (código em backend/relatorio)
  if (targetPath === '/api/consulta/relatorio' && req.method === 'POST') {
    handleConsultaRelatorioPdf(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
  res.end('Not Found');
});


server.listen(PORT, () => {
  const shapeDir = path.join(ROOT, 'shape');
  const count = fs.existsSync(shapeDir) ? fs.readdirSync(shapeDir).filter(f => f.toLowerCase().endsWith('.geojson')).length : 0;
  const pruned = pruneScanFileCache(ROOT);
  if (pruned > 0) console.log(`Cache scan: ${pruned} arquivo(s) antigo(s) removido(s).`);
  console.log(`Backend local em http://127.0.0.1:${PORT}`);
  console.log(`Shape indexado: ${count} arquivo(s) .geojson`);
  ensureImoveisCatalog()
    .then((items) => console.log(`Catálogo de imóveis rurais: ${items.length} CAR(s).`))
    .catch((e) => console.warn('Catálogo de imóveis:', e.message || e));
});
