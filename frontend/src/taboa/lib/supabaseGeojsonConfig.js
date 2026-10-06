/**
 * URLs para GeoJSON em backend/shape/ (via API local).
 * Com API, não cai no public/ do Vite — essa pasta pode ter cópia antiga (ex.: Bahia inteira).
 */
export function getInstitutionalGeojsonFetchUrls(filename, { apiBase } = {}) {
  const name = String(filename || '').trim();
  if (apiBase) return [`${String(apiBase).replace(/\/$/, '')}/shape/${name}`];
  return [`shape/${name}`, `./shape/${name}`];
}
