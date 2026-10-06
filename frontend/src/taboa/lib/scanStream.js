/**
 * @param {object} o
 * @param {string} o.apiBase
 * @param {() => number} o.getGeneration
 * @param {(msg: string, isError?: boolean) => void} o.onStatus
 * @param {(msg?: string) => void} [o.onScanPrep]
 * @param {(p: { completed: number, total: number, municipality: string }) => void} [o.onScanProgress]
 */
export async function consumeScanAlertsStream(o) {
  const {
    apiBase,
    email,
    password,
    startDate,
    endDate,
    selectedIndices,
    forceRefresh,
    myGen,
    getGeneration,
    onStatus,
    onScanPrep,
    onScanProgress,
  } = o;
  const res = await fetch(`${apiBase}/api/scan-alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      startDate,
      endDate,
      selectedIndices: selectedIndices == null ? null : [...selectedIndices],
      forceRefresh: !!forceRefresh,
    })
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch (_) {
      try { msg = await res.text() || msg; } catch (_) {}
    }
    throw new Error(msg);
  }
  if (!res.body || !res.body.getReader) {
    throw new Error('Stream de resposta não suportado neste browser.');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let payload = null;
  let lastMunProgress = 0;
  function parseBlocks(text) {
    const blocks = text.split('\n\n');
    const rest = blocks.pop() || '';
    for (const block of blocks) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (getGeneration() !== myGen) return { cancelled: true, rest: '' };
        if (msg.type === 'status') {
          if (typeof onScanPrep === 'function') onScanPrep(msg.message);
          else onStatus(msg.message, !!msg.warn);
        }
        if (msg.type === 'progress' && msg.phase === 'municipio_ok') {
          const n = Number(msg.completed) || 0;
          if (n >= lastMunProgress) {
            lastMunProgress = n;
            if (typeof onScanProgress === 'function') {
              onScanProgress({
                completed: n,
                total: Number(msg.nMunicipios) || 0,
                municipality: msg.munNome || '',
              });
            } else if (msg.message) {
              onStatus(msg.message, false);
            }
          }
        }
        if (msg.type === 'result') payload = msg.payload;
        if (msg.type === 'error') throw new Error(msg.message || 'Erro no servidor');
      }
    }
    return { cancelled: false, rest };
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const r = parseBlocks(buf);
    buf = r.rest;
    if (r.cancelled) {
      try { await reader.cancel(); } catch (_) {}
      return null;
    }
  }
  const tail = parseBlocks(buf + '\n\n');
  if (tail.cancelled) return null;
  return payload;
}
