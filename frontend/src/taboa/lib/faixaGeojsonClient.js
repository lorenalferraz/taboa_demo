import { getApiBase } from './config.js';

export async function fetchFaixaGeoJsonFromApi() {
  const base = getApiBase();
  if (!base) return { ok: false, error: 'Backend necessário para carregar a faixa oficial.' };
  const res = await fetch(`${base}/api/faixa/geojson`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) return { ok: false, error: json.error || `HTTP ${res.status}` };
  return json;
}

export async function fetchFaixaGeoJson() {
  return fetchFaixaGeoJsonFromApi();
}
