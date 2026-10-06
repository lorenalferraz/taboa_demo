/** API local do backend Taboa (sem barra final). */
const LOCAL_API = 'http://127.0.0.1:3000';

/**
 * URL base do backend. Ordem: `VITE_API_BASE` → `window.__TABOA_API_BASE__` → localhost.
 */
export function getApiBase() {
  try {
    const env = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE;
    if (env) return String(env).replace(/\/$/, '');
  } catch (_) {}
  if (typeof window !== 'undefined' && window.__TABOA_API_BASE__) {
    return String(window.__TABOA_API_BASE__).replace(/\/$/, '');
  }
  const h = typeof window !== 'undefined' ? window.location.hostname : '';
  if (h === 'localhost' || h === '127.0.0.1' || !h) {
    try {
      const port = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_PORT;
      if (port) return `http://127.0.0.1:${String(port).replace(/[^0-9]/g, '') || '3000'}`;
    } catch (_) {}
    return LOCAL_API;
  }
  return LOCAL_API;
}
