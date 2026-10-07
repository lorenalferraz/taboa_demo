/**
 * Ordem de desenho das camadas da aba Camadas.
 * O primeiro item da lista fica por cima no mapa e recebe o clique do popup.
 */
import L from 'leaflet';

const CHECKBOX_TO_LAYER = {
  chkShape: 'municipios',
  chkMapBiomas: 'alertas',
  chkIncraAssentamentos: 'assentamentos',
  chkInemaImoveisRurais: 'imoveis_rurais',
  chkInemaReservaLegal: 'reserva_legal',
  chkInemaApp: 'app',
  chkFunaiIndigenas: 'indigenas',
  chkIncraQuilombolas: 'quilombolas',
  chkIcmbioUcFederais: 'uc_federais',
  chkInemaUcEstaduais: 'uc_estaduais',
  chkInemaUcMunicipais: 'uc_municipais',
};

/** De cima para baixo na lista e no mapa. */
const DEFAULT_TOP_FIRST = [
  'alertas',
  'app',
  'reserva_legal',
  'imoveis_rurais',
  'assentamentos',
  'indigenas',
  'quilombolas',
  'uc_municipais',
  'uc_estaduais',
  'uc_federais',
  'municipios',
];

const FIXED_Z = {
  registros: 540,
  consulta: 620,
};

const renderers = new Map();
let listEl = null;

export function paneName(id) {
  return `taboa-${id}`;
}

function ensurePane(map, id, zIndex) {
  const name = paneName(id);
  if (!map.getPane(name)) map.createPane(name);
  const pane = map.getPane(name);
  pane.style.zIndex = String(zIndex);
  pane.style.pointerEvents = 'none';
  return name;
}

export function rendererFor(map, id) {
  if (!map) return null;
  if (!renderers.has(id)) {
    const z = FIXED_Z[id] ?? 450;
    const pane = ensurePane(map, id, z);
    renderers.set(id, L.svg({ pane, padding: 0.5 }));
  }
  return renderers.get(id);
}

function applyOrderFromDom(map) {
  if (!map || !listEl) return;
  const ids = [...listEl.querySelectorAll(':scope > [data-layer-id]')].map((el) => el.dataset.layerId);
  ids.forEach((id, i) => {
    ensurePane(map, id, 500 - i);
    const li = listEl.querySelector(`[data-layer-id="${id}"]`);
    const up = li?.querySelector('[data-order="up"]');
    const down = li?.querySelector('[data-order="down"]');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === ids.length - 1;
  });
}

function reorderListToDefault() {
  if (!listEl) return;
  const byId = new Map();
  listEl.querySelectorAll(':scope > [data-layer-id]').forEach((el) => {
    byId.set(el.dataset.layerId, el);
  });
  for (const id of DEFAULT_TOP_FIRST) {
    const el = byId.get(id);
    if (el) listEl.appendChild(el);
  }
}

export function bindLayerList(ul) {
  if (!ul || ul.dataset.orderBound === '1') return;
  ul.dataset.orderBound = '1';
  listEl = ul;
  ul.querySelectorAll('li.layer-row-item').forEach((li) => {
    const input = li.querySelector('input[type="checkbox"]');
    const id = CHECKBOX_TO_LAYER[input?.id];
    if (!id) return;
    li.dataset.layerId = id;
    if (li.querySelector('.layer-order')) return;
    const box = document.createElement('span');
    box.className = 'layer-order';
    box.innerHTML = `
      <button type="button" class="layer-order-btn" data-order="up" aria-label="Trazer esta camada para cima">↑</button>
      <button type="button" class="layer-order-btn" data-order="down" aria-label="Enviar esta camada para baixo">↓</button>`;
    li.appendChild(box);
  });
  reorderListToDefault();
  applyOrderFromDom(window.__taboaLeafletMap || null);
  ul.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('[data-order]');
    if (!btn || !ul.contains(btn)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const li = btn.closest('[data-layer-id]');
    if (!li) return;
    moveListedLayer(li.dataset.layerId, btn.dataset.order === 'up' ? 1 : -1);
  });
}

export function applyLayerOrder(map) {
  applyOrderFromDom(map);
}

function moveListedLayer(id, dir) {
  if (!listEl) return;
  const items = [...listEl.querySelectorAll(':scope > [data-layer-id]')];
  const i = items.findIndex((el) => el.dataset.layerId === id);
  const j = i - dir;
  if (i < 0 || j < 0 || j >= items.length) return;
  const node = items[i];
  const other = items[j];
  if (j < i) listEl.insertBefore(node, other);
  else listEl.insertBefore(node, other.nextSibling);
  const map = window.__taboaLeafletMap || null;
  applyOrderFromDom(map);
}
