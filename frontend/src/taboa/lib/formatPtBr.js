/**
 * Formatação numérica pt-BR (vírgula decimal).
 * Coordenadas geográficas mantêm ponto — não usar aqui para lat/lng.
 */

export function formatDecimalPtBr(value, decimals = 4) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(decimals).replace('.', ',');
}

/** Hectares para exibição (ex.: painel consulta). */
export function formatHaPtBr(value, decimals = 4, withSuffix = true) {
  const n = formatDecimalPtBr(value, decimals);
  if (n === '—') return n;
  return withSuffix ? `${n} ha` : n;
}

export function formatCentDM(lat, lng) {
  if (lat == null || lng == null) return '—';
  const fmt = (val, isLat) => {
    const hem = isLat ? (val >= 0 ? 'N' : 'S') : (val >= 0 ? 'E' : 'W');
    const v = Math.abs(val);
    const d = Math.floor(v);
    const mf = (v - d) * 60;
    const m = Math.floor(mf);
    const s = ((mf - m) * 60).toFixed(2).replace('.', ',');
    return `${d}°${m}'${s}''${hem}`;
  };
  return `${fmt(Number(lat), true)}; ${fmt(Number(lng), false)}`;
}
