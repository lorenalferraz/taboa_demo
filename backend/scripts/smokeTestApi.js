'use strict';

/**
 * Smoke test: backend local (shape, municípios, assentamentos).
 * Uso: node backend/scripts/smokeTestApi.js [baseUrl]
 */
const http = require('http');

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { 'User-Agent': 'taboa-smoke/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          contentType: res.headers['content-type'] || '',
          body: Buffer.concat(chunks),
        });
      });
    }).on('error', reject);
  });
}

async function check(name, url, expect) {
  const r = await fetchUrl(url);
  const ok = expect(r);
  console.log(`${ok ? '✓' : '✗'} ${name} — HTTP ${r.status} ${r.contentType.split(';')[0]}`);
  if (!ok) {
    console.log('  URL:', url);
    if (r.body.length < 500) console.log('  Body:', r.body.toString('utf-8').slice(0, 300));
    process.exitCode = 1;
  }
  return ok;
}

async function main() {
  console.log('Smoke test TABOA backend:', BASE, '\n');

  await check(
    'Shape files list',
    `${BASE}/api/shape-files`,
    (r) => r.status === 200 && /json/i.test(r.contentType),
  );

  await check(
    'Município local (Porto Seguro)',
    `${BASE}/api/ibge/municipio-por-coordenada?lat=-16.4497&lng=-39.0647`,
    (r) => r.status === 200 && /json/i.test(r.contentType) && /Porto/i.test(r.body.toString()),
  );

  await check(
    'Assentamentos locais (bbox)',
    `${BASE}/api/local/incra?layer=assentamentos&uf=BA&bbox=-40.5,-17.0,-38.5,-15.5`,
    (r) => {
      if (r.status !== 200 || !/json/i.test(r.contentType)) return false;
      try {
        const j = JSON.parse(r.body.toString('utf-8'));
        return j.ok === true && Array.isArray(j.geojson?.features);
      } catch (_) {
        return false;
      }
    },
  );

  await check(
    'Faixa oficial geojson (62 municípios)',
    `${BASE}/api/faixa/geojson`,
    (r) => {
      if (r.status !== 200 || !/json/i.test(r.contentType)) return false;
      try {
        const j = JSON.parse(r.body.toString('utf-8'));
        const ibge = new Set((j.geojson?.features || []).map((f) => Number(f.properties?.codMun)));
        return j.ok === true && ibge.size === 62;
      } catch (_) {
        return false;
      }
    },
  );

  console.log(process.exitCode ? '\nFalhou.' : '\nOK — backend respondendo.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
