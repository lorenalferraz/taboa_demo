/** Layout fixo no modo claro — sem alternância de tema. */
export function applyLightTheme() {
  document.documentElement.setAttribute('data-theme', 'light');
  try {
    localStorage.removeItem('mapbiomas_theme');
  } catch (_) {}
}
