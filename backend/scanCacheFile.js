'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCAN_FILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheDir(root) {
  return path.join(root, '.cache', 'scans');
}

function safeKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function getScanFromFileCache(root, key, forceRefresh) {
  if (forceRefresh) return null;
  const file = path.join(cacheDir(root), `${safeKey(key)}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > SCAN_FILE_CACHE_TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!row?.payload) return null;
    return row.payload;
  } catch (_) {
    return null;
  }
}

function putScanInFileCache(root, key, payload) {
  try {
    const dir = cacheDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeKey(key)}.json`);
    fs.writeFileSync(file, JSON.stringify({ savedAt: Date.now(), payload }), 'utf8');
  } catch (_) {}
}

/** Remove entradas de cache de scan inválidas ou expiradas (libera disco/memória no Render). */
function pruneScanFileCache(root) {
  const dir = cacheDir(root);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > SCAN_FILE_CACHE_TTL_MS) {
        fs.unlinkSync(file);
        removed += 1;
        continue;
      }
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { isScanCachePayloadValid } = require('./scanPipeline');
      if (!isScanCachePayloadValid(row?.payload)) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch (_) {
      try { fs.unlinkSync(file); removed += 1; } catch (_) {}
    }
  }
  return removed;
}

module.exports = { getScanFromFileCache, putScanInFileCache, pruneScanFileCache, SCAN_FILE_CACHE_TTL_MS };
