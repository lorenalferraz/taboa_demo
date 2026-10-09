/**
 * Popup único com todas as camadas ligadas sob o clique, na ordem da aba Camadas.
 * Sem isso só a camada de cima abre o popup e as de baixo ficam inacessíveis.
 */
import L from 'leaflet';
import * as turf from '@turf/turf';

const sources = [];
let installed = false;
let seq = 0;

/**
 * Fonte assíncrona de popup (ex.: PRODES, que consulta o WFS no clique).
 * @param {{ active: () => boolean, z: () => number, html: (latlng: L.LatLng) => Promise<string|null> }} src
 */
export function registerPopupSource(src) {
  sources.push(src);
}

function paneZ(map, pane) {
  const el = pane ? map.getPane(pane) : null;
  const z = Number(el?.style?.zIndex);
  return Number.isFinite(z) ? z : 400;
}

function isHidden(layer) {
  const o = layer.options || {};
  if (o.opacity === 0 && (o.fillOpacity === 0 || o.fill === false)) return true;
  return layer._path?.style?.pointerEvents === 'none';
}

function hits(layer, latlng) {
  try {
    if (!layer.getBounds().contains(latlng)) return false;
    return turf.booleanPointInPolygon([latlng.lng, latlng.lat], layer.toGeoJSON());
  } catch (_) {
    return false;
  }
}

function contentOf(layer) {
  const c = layer.getPopup()?.getContent();
  const html = typeof c === 'function' ? c(layer) : c;
  if (html instanceof HTMLElement) return html.outerHTML;
  return html ? String(html) : '';
}

function vectorSections(map, latlng) {
  const out = [];
  const seen = new Set();
  map.eachLayer((layer) => {
    if (!(layer instanceof L.Polygon) || !layer.getPopup() || isHidden(layer)) return;
    if (!hits(layer, latlng)) return;
    const html = contentOf(layer);
    if (!html || seen.has(html)) return;
    seen.add(html);
    const pane = layer.options.renderer?.options?.pane || layer.options.pane;
    out.push({ z: paneZ(map, pane), html });
  });
  return out;
}

function render(sections, pending) {
  const parts = [...sections].sort((a, b) => b.z - a.z).map((s) => `<div class="popup-stack-item">${s.html}</div>`);
  if (pending) parts.push('<div class="popup-stack-item popup-stack-loading">Consultando o PRODES…</div>');
  return parts.join('');
}

export async function openStackedPopup(map, latlng) {
  if (!map || !latlng) return;
  const mySeq = ++seq;
  const sections = vectorSections(map, latlng);
  const active = sources.filter((s) => {
    try { return s.active(); } catch (_) { return false; }
  });
  let popup = null;
  const show = (pending) => {
    if (mySeq !== seq) return;
    if (!sections.length) {
      if (popup) map.closePopup(popup);
      return;
    }
    const html = render(sections, pending);
    if (popup && map.hasLayer(popup)) {
      popup.setContent(html);
      popup.update();
      popup._adjustPan?.();
    } else {
      popup = L.popup({ maxWidth: 380, maxHeight: 360, autoPanPadding: [24, 24], className: 'popup-stack' })
        .setLatLng(latlng)
        .setContent(html)
        .openOn(map);
    }
  };
  if (sections.length) show(active.length > 0);
  if (!active.length) return;
  const extra = await Promise.all(active.map(async (s) => {
    try {
      const html = await s.html(latlng);
      return html ? { z: s.z(), html } : null;
    } catch (_) {
      return null;
    }
  }));
  if (mySeq !== seq) return;
  if (popup && !map.hasLayer(popup)) return;
  sections.push(...extra.filter(Boolean));
  show(false);
}

/** Troca o clique de popup dos polígonos pelo popup empilhado. Chamar antes de criar as camadas. */
export function installStackedPopups() {
  if (installed) return;
  installed = true;
  const original = L.Layer.prototype._openPopup;
  L.Layer.include({
    _openPopup(e) {
      const target = e?.layer || e?.target;
      if (!this._map || !(target instanceof L.Polygon) || this !== target) {
        return original.call(this, e);
      }
      L.DomEvent.stop(e);
      openStackedPopup(this._map, e.latlng);
    },
  });
}
