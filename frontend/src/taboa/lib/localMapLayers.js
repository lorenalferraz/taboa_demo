/**
 * Camadas locais no mapa (GeoJSON em backend/shape/).
 */
import { getApiBase } from './config.js';
import { getInstitutionalGeojsonFetchUrls } from './supabaseGeojsonConfig.js';
import { INCRA_LOCAL_LAYERS } from './localIncraCatalog.js';
import { SHAPE_OVERLAY_LAYERS } from './localShapeLayers.js';
import { BY_NOME, normMunNome } from './faixaMunicipiosCatalog.js';
import { buildAssentamentoPopupHtml } from './assentamentoMeta.js';
import * as turf from '@turf/turf';

/** @typedef {{ layer: L.Layer, id: string }} RemoteWmsEntry */

/** @type {L.LayerGroup | null} */
let remoteWmsGroup = null;
/** @type {RemoteWmsEntry[]} */
let remoteWmsEntries = [];
let lastRemoteWmsUf = '';
const localLoadPromises = new Map();
/** Preferência de visibilidade por id. Ausente = desligada. */
const layerVisibility = new Map();
/** CAR selecionado na Consulta — restringe a camada de imóveis rurais. */
let imoveisCarFilter = '';

/** GeoJSON INCRA completo (cache). */
let incraAssentamentosFC = null;
/** Subconjunto sobreposto à AOI (área local) — usado no mapa e no seletor. */
let incraAssentamentosActiveFC = null;
/** Recorte da faixa inteira (sem município) — para reset rápido, sem refazer o turf. */
let incraAssentamentosFaixaFC = null;
/** @type {{ idx: number, layer: L.Layer }[]} */
let incraAssentamentoLeaflets = [];
let incraAssentFilter = '';
/** @type {((meta?: { showAll?: boolean }) => void|Promise<void>) | null} */
let incraAssentamentosPrepareHook = null;
/** @type {L.Map | null} */
let hostMap = null;
const incraAssentListeners = new Set();

function notifyIncraAssentamentos() {
  for (const cb of incraAssentListeners) {
    try { cb(incraAssentamentosActiveFC); } catch (_) {}
  }
}

function asTurfFeature(f) {
  if (!f) return null;
  if (f.type === 'Feature' && f.geometry) return f;
  if (f.geometry) {
    try { return turf.feature(f.geometry); } catch (_) { return null; }
  }
  if (f.type && f.coordinates) {
    try { return turf.feature(f); } catch (_) { return null; }
  }
  return null;
}

function bboxesOverlap(a, b) {
  return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Assentamentos INCRA cuja geometria cruza algum polígono da área local. */
export function filterFeaturesOverlappingAoi(candidates, aoiFeatures) {
  const aoi = [];
  for (const f of aoiFeatures || []) {
    const feat = asTurfFeature(f);
    if (!feat) continue;
    let b = null;
    try { b = turf.bbox(feat); } catch (_) {}
    aoi.push({ feat, b });
  }
  if (!aoi.length) return [];
  const out = [];
  for (const cand of candidates || []) {
    const cFeat = asTurfFeature(cand);
    if (!cFeat) continue;
    let cb = null;
    try { cb = turf.bbox(cFeat); } catch (_) {}
    let hit = false;
    for (const { feat, b } of aoi) {
      if (cb && b && !bboxesOverlap(cb, b)) continue;
      try {
        if (turf.booleanIntersects(cFeat, feat)) {
          hit = true;
          break;
        }
      } catch (_) {}
    }
    if (hit) out.push(cand);
  }
  return out;
}

async function fetchGeojsonBbox(filename, bbox) {
  const base = getApiBase();
  if (!base) return null;
  const q = new URLSearchParams({
    file: filename,
    bbox: bbox.join(','),
    limit: '0',
  });
  const res = await fetch(`${base.replace(/\/$/, '')}/api/shape/features?${q}`, { cache: 'no-store' });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    console.warn('camada shape:', filename, err);
    return null;
  }
  const data = await res.json();
  if (!data?.ok) {
    console.warn('camada shape:', filename, data?.error || 'falha');
    return null;
  }
  return data?.geojson || null;
}

function mapBbox(map) {
  if (!map?.getBounds) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function leafletStyle(style = {}) {
  return {
    color: style.color || '#334155',
    weight: style.weight ?? 1.2,
    opacity: style.opacity ?? 0.9,
    fillColor: style.fillColor || style.color || '#94a3b8',
    fillOpacity: style.fillOpacity ?? 0.22,
    interactive: true,
  };
}

function bindFeaturePopup(layer, html) {
  layer.bindPopup(html, { maxWidth: 380 });
}

async function fetchGeojsonFile(filename) {
  const base = getApiBase();
  const urls = getInstitutionalGeojsonFetchUrls(filename, { apiBase: base });
  for (const url of urls) {
    try {
      const abs = /^https?:\/\//i.test(url) ? url : (base ? `${base.replace(/\/$/, '')}/${url.replace(/^\.\//, '')}` : url);
      const fetchUrl = `${abs}${abs.includes('?') ? '&' : '?'}v=taboa-faixa`;
      const res = await fetch(fetchUrl, { cache: 'no-store' });
      if (!res.ok) continue;
      const gj = await res.json();
      if (gj?.features?.length) return gj;
    } catch (_) {}
  }
  return null;
}

function clipAssentamentosToFaixa(gj) {
  const features = (gj?.features || []).filter((f) => {
    const mun = f?.properties?.municipio || f?.properties?.nm_municip || f?.properties?.nm_municipio || '';
    return BY_NOME.has(normMunNome(mun));
  });
  return { type: 'FeatureCollection', features };
}

let incraAssentamentosFetch = null;

async function fetchIncraAssentamentosFC() {
  if (incraAssentamentosFC?.features?.length) return incraAssentamentosFC;
  if (!incraAssentamentosFetch) {
    incraAssentamentosFetch = (async () => {
      const gj = await fetchGeojsonFile('assentamentos.geojson');
      if (!gj?.features?.length) return null;
      const clipped = clipAssentamentosToFaixa(gj);
      incraAssentamentosFC = clipped;
      return incraAssentamentosFC;
    })();
  }
  return incraAssentamentosFetch;
}

/** Precarrega o GeoJSON completo em silêncio (o seletor só aparece após Aplicar filtros). */
export async function prefetchIncraAssentamentos() {
  return fetchIncraAssentamentosFC();
}

export function getIncraAssentamentosFC() {
  return incraAssentamentosActiveFC;
}

export function getIncraAssentamentosFullFC() {
  return incraAssentamentosFC;
}

export function hasIncraAssentamentosAoi() {
  return incraAssentamentosActiveFC != null;
}

export function getIncraAssentamentoFilter() {
  return incraAssentFilter;
}

export function getSelectedIncraAssentamentoFeature() {
  if (incraAssentFilter === '' || incraAssentFilter === 'all' || incraAssentFilter === 'none') return null;
  const idx = Number(incraAssentFilter);
  if (!Number.isInteger(idx) || idx < 0) return null;
  return incraAssentamentosFC?.features?.[idx]
    || incraAssentamentosActiveFC?.features?.find((f) => Number(f?.__srcIdx) === idx)
    || incraAssentamentosActiveFC?.features?.[idx]
    || null;
}

/** Garante recorte da AOI antes de ligar a camada (registrado pelo bootstrap). */
export function setIncraAssentamentosPrepareHook(fn) {
  incraAssentamentosPrepareHook = typeof fn === 'function' ? fn : null;
}

export function subscribeIncraAssentamentos(cb) {
  incraAssentListeners.add(cb);
  if (incraAssentamentosActiveFC) cb(incraAssentamentosActiveFC);
  return () => incraAssentListeners.delete(cb);
}

function visibleIncraAssentStyle() {
  const style = INCRA_LOCAL_LAYERS.find((c) => c.id === 'assentamentos')?.style || {};
  return {
    color: style.color || '#c2410c',
    weight: style.weight ?? 1.5,
    opacity: 0.85,
    fillColor: style.fillColor || '#fb923c',
    fillOpacity: style.fillOpacity ?? 0.2,
  };
}

function setIncraLeafletStyle(layer, style, interactive) {
  if (!layer) return;
  if (typeof layer.setStyle === 'function') layer.setStyle(style);
  if (typeof layer.eachLayer === 'function') {
    layer.eachLayer((child) => setIncraLeafletStyle(child, style, interactive));
  }
  if (layer._path) layer._path.style.pointerEvents = interactive ? '' : 'none';
  if (!interactive && typeof layer.closePopup === 'function') layer.closePopup();
}

function flyMapToLayer(layer, map, feat) {
  const m = map || hostMap;
  if (!m) return;
  try { m.stop(); } catch (_) {}
  const opts = { padding: [48, 48], maxZoom: 15, duration: 1.45, easeLinearity: 0.22 };
  const fly = (bounds) => {
    try {
      if (typeof m.flyToBounds === 'function') m.flyToBounds(bounds, opts);
      else m.fitBounds(bounds, { padding: opts.padding, maxZoom: opts.maxZoom, animate: true });
    } catch (_) {}
  };
  try {
    if (feat?.geometry) {
      const [w, s, e, n] = turf.bbox(feat);
      if ([w, s, e, n].every(Number.isFinite)) {
        fly([[s, w], [n, e]]);
        return;
      }
    }
  } catch (_) {}
  const b = layer?.getBounds?.();
  if (!b || typeof b.isValid !== 'function' || !b.isValid()) return;
  fly(b);
}

/** Zoom gradual até uma feição GeoJSON (município, assentamento, etc.). */
export function flyToGeojsonFeature(feat, map) {
  if (!feat?.geometry) return false;
  flyMapToLayer(null, map, feat);
  return true;
}

/** Zoom imediato pelo polígono em assentamentos.geojson (não depende da camada no mapa). */
export function flyToIncraAssentamentoIndex(idx, map) {
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0) return false;
  const feat = incraAssentamentosFC?.features?.[i]
    || incraAssentamentosActiveFC?.features?.find((f) => Number(f?.__srcIdx) === i)
    || incraAssentamentosActiveFC?.features?.[i];
  if (!feat?.geometry) return false;
  flyMapToLayer(null, map, feat);
  return true;
}

export function isIncraAssentamentosLayerReady() {
  return incraAssentamentoLeaflets.length > 0
    && remoteWmsEntries.some((e) => e.id === 'local:assentamentos');
}

/**
 * Garante a camada a partir de assentamentos.geojson (sem depender da varredura).
 */
export async function ensureIncraAssentamentosFromFile(map) {
  if (map) hostMap = map;
  if (!remoteWmsGroup && hostMap) {
    remoteWmsGroup = L.layerGroup();
    remoteWmsGroup.addTo(hostMap);
    if (!remoteWmsEntries.length) remoteWmsEntries = [];
  }
  await fetchIncraAssentamentosFC();
  if (!incraAssentamentosFC?.features?.length) return null;
  const nFull = incraAssentamentosFC.features.length;
  const alreadyFull = incraAssentamentosActiveFC === incraAssentamentosFC
    && incraAssentamentoLeaflets.length === nFull
    && remoteWmsEntries.some((e) => e.id === 'local:assentamentos');
  if (!alreadyFull) {
    incraAssentamentosActiveFC = incraAssentamentosFC;
    removeIncraAssentamentosMapLayer();
    ensureIncraAssentamentosLeafletExists();
    notifyIncraAssentamentos();
  } else {
    ensureIncraAssentamentosLeafletExists();
  }
  return incraAssentamentosActiveFC;
}

/**
 * Estilo dos polígonos INCRA conforme a camada (Camada) e o seletor (Filtro).
 * Camada ligada + seletor vazio → todos os sobrepostos.
 * Seletor com um projeto → só esse, com zoom gradual.
 * @param {string|number} [value]
 * @param {{ map?: L.Map, fitMap?: boolean }} [opts]
 */
export function applyIncraAssentamentoFilter(value, opts = {}) {
  if (value != null) {
    const s = String(value);
    incraAssentFilter = s === 'all' || s === 'none' ? '' : s;
  }
  const layerOn = isLayerWantedVisible('local:assentamentos');
  const idx = Number(incraAssentFilter);
  const hasOne = incraAssentFilter !== '' && Number.isInteger(idx) && idx >= 0;
  const hidden = { opacity: 0, fillOpacity: 0, weight: 0 };
  const shown = visibleIncraAssentStyle();

  for (const { idx: i, layer } of incraAssentamentoLeaflets) {
    const on = hasOne ? String(i) === String(idx) : layerOn;
    setIncraLeafletStyle(layer, on ? shown : hidden, on);
  }

  applyLayerVisibility('local:assentamentos');
  if (hasOne && opts.fitMap !== false) {
    const found = incraAssentamentoLeaflets.find((x) => String(x.idx) === String(idx));
    const feat = found?.feat
      || incraAssentamentosFC?.features?.[idx]
      || incraAssentamentosActiveFC?.features?.find((f) => Number(f?.__srcIdx) === idx);
    flyMapToLayer(found?.layer, opts.map, feat);
  }
}

function removeIncraAssentamentosMapLayer() {
  const existingIdx = remoteWmsEntries.findIndex((e) => e.id === 'local:assentamentos');
  if (existingIdx >= 0) {
    try {
      if (remoteWmsGroup) remoteWmsGroup.removeLayer(remoteWmsEntries[existingIdx].layer);
    } catch (_) {}
    remoteWmsEntries.splice(existingIdx, 1);
  }
  incraAssentamentoLeaflets = [];
  localLoadPromises.delete('assentamentos.geojson');
}

function createIncraAssentamentosLeafletLayer(gj) {
  const hidden = { opacity: 0, fillOpacity: 0, weight: 0 };
  incraAssentamentoLeaflets = [];
  return L.geoJSON(gj, {
    style: hidden,
    onEachFeature: (feat, layer) => {
      const idx = gj.features.indexOf(feat);
      const i = Number.isInteger(feat?.__srcIdx)
        ? feat.__srcIdx
        : (idx >= 0 ? idx : incraAssentamentoLeaflets.length);
      layer._featureIndex = i;
      incraAssentamentoLeaflets.push({ idx: i, layer, feat });
      bindFeaturePopup(layer, buildAssentamentoPopupHtml(feat?.properties || {}, escHtml));
    },
  });
}

/**
 * Recorta assentamentos INCRA pela área local (faixa / município) e monta a camada só com os sobrepostos.
 * @param {object[]} aoiFeatures
 * @param {{ cacheAsDefault?: boolean }} [opts] `cacheAsDefault` guarda o recorte da faixa para o Reset
 * @returns {Promise<number>} quantidade sobreposta
 */
export async function applyIncraAssentamentosToAoi(aoiFeatures, opts = {}) {
  await fetchIncraAssentamentosFC();
  const candidates = incraAssentamentosFC?.features || [];
  const overlapping = filterFeaturesOverlappingAoi(candidates, aoiFeatures).map((f) => {
    if (f.__srcIdx == null) f.__srcIdx = candidates.indexOf(f);
    return f;
  });
  const keepFilter = incraAssentFilter;
  incraAssentamentosActiveFC = incraAssentamentosFC || { type: 'FeatureCollection', features: overlapping };
  if (opts.cacheAsDefault) incraAssentamentosFaixaFC = incraAssentamentosActiveFC;
  ensureIncraAssentamentosLeafletExists();
  applyIncraAssentamentoFilter(keepFilter, { fitMap: false });
  notifyIncraAssentamentos();
  return overlapping.length;
}

/**
 * Volta a lista/camada ao recorte da faixa (estado inicial), sem recalcular interseção.
 * @returns {boolean} true se havia cache
 */
export function restoreIncraAssentamentosFaixa() {
  if (!incraAssentamentosFaixaFC) return false;
  incraAssentFilter = '';
  const already = incraAssentamentosActiveFC === incraAssentamentosFaixaFC;
  if (!already) {
    incraAssentamentosActiveFC = incraAssentamentosFaixaFC;
    removeIncraAssentamentosMapLayer();
    if (incraAssentamentosActiveFC.features?.length && remoteWmsGroup) {
      const lyr = createIncraAssentamentosLeafletLayer(incraAssentamentosActiveFC);
      remoteWmsEntries.push({ id: 'local:assentamentos', layer: lyr });
    }
  }
  applyIncraAssentamentoFilter('', { fitMap: false });
  notifyIncraAssentamentos();
  return true;
}

/** Limpa recorte e esconde shapes; a lista permanece. */
export function clearIncraAssentamentosAoi() {
  incraAssentamentosActiveFC = null;
  incraAssentFilter = '';
  removeIncraAssentamentosMapLayer();
  notifyIncraAssentamentos();
}

function ensureIncraAssentamentosLeafletExists() {
  if (!remoteWmsEntries.some((e) => e.id === 'local:assentamentos')) {
    if (!incraAssentamentosActiveFC?.features?.length || !remoteWmsGroup) return;
    const lyr = createIncraAssentamentosLeafletLayer(incraAssentamentosActiveFC);
    remoteWmsEntries.push({ id: 'local:assentamentos', layer: lyr });
  }
  applyLayerVisibility('local:assentamentos');
}

function isLayerWantedVisible(id) {
  return layerVisibility.get(id) === true;
}

function applyLayerVisibility(id) {
  const entry = remoteWmsEntries.find((e) => e.id === id);
  if (!entry?.layer || !remoteWmsGroup) return;
  const keepMounted = id === 'local:assentamentos';
  const visible = keepMounted || isLayerWantedVisible(id);
  const has = remoteWmsGroup.hasLayer(entry.layer);
  if (visible && !has) {
    remoteWmsGroup.addLayer(entry.layer);
    if (typeof entry.layer.redraw === 'function') {
      try { entry.layer.redraw(); } catch (_) {}
    }
  } else if (!visible && has) {
    remoteWmsGroup.removeLayer(entry.layer);
  }
}

/**
 * Liga/desliga uma malha no mapa. Se a camada ainda não carregou, a preferência é aplicada depois.
 * @param {string} id
 * @param {boolean} visible
 * @param {{ showAll?: boolean }} [opts] `showAll` no toggle da aba Camada: mostra todos os sobrepostos
 */
export function setRemoteLayerVisible(id, visible, opts = {}) {
  layerVisibility.set(id, !!visible);
  if (id === 'local:assentamentos' && visible && opts.showAll) {
    incraAssentFilter = '';
    try {
      const sel = document.getElementById('selectAssentamento');
      if (sel) {
        sel.value = '';
        if (sel.dataset) sel.dataset.index = '';
      }
    } catch (_) {}
  }

  const finish = () => {
    if (id === 'local:assentamentos') ensureIncraAssentamentosLeafletExists();
    applyLayerVisibility(id);
    if (id === 'local:assentamentos') {
      applyIncraAssentamentoFilter(undefined, { fitMap: false });
    }
  };

  if (id === 'local:assentamentos' && visible && incraAssentamentosPrepareHook && !opts.skipPrepare) {
    return Promise.resolve(incraAssentamentosPrepareHook({ showAll: !!opts.showAll }))
      .then(finish)
      .catch((e) => {
        console.warn('camada assentamentos:', e);
        finish();
      });
  }

  const overlayId = id.startsWith('local:') ? id.slice(6) : id;
  const overlayCfg = SHAPE_OVERLAY_LAYERS.find((c) => c.id === overlayId);
  if (visible && overlayCfg?.heavy && remoteWmsGroup) {
    localLoadPromises.delete(overlayCfg.geojson);
    return refreshViewportLayer(overlayCfg)
      .then(() => applyLayerVisibility(id))
      .catch((e) => console.warn('camada INEMA:', e));
  }

  if (visible && !remoteWmsEntries.some((e) => e.id === id) && remoteWmsGroup && id !== 'local:assentamentos') {
    return attachAllLocalGeojsonLayers(remoteWmsGroup, remoteWmsEntries)
      .then(() => applyLayerVisibility(id))
      .catch((e) => console.warn('camada local:', e));
  }

  finish();
  return Promise.resolve();
}

/** @param {string} id */
export function getRemoteLayerVisible(id) {
  return isLayerWantedVisible(id);
}

/** Desliga todas as malhas remotas/locais (estado inicial da aba Camada). */
export function setImoveisRuraisCarFilter(car, opts = {}) {
  imoveisCarFilter = String(car || '').trim();
  const cfg = SHAPE_OVERLAY_LAYERS.find((c) => c.id === 'imoveis_rurais');
  if (!cfg) return Promise.resolve();
  if (imoveisCarFilter && opts.enable !== false) {
    layerVisibility.set('local:imoveis_rurais', true);
    const chk = document.getElementById('chkInemaImoveisRurais');
    if (chk) chk.checked = true;
  }
  if (!imoveisCarFilter && opts.enable === false) {
    layerVisibility.set('local:imoveis_rurais', false);
    const chk = document.getElementById('chkInemaImoveisRurais');
    if (chk) chk.checked = false;
  }
  if (!isLayerWantedVisible('local:imoveis_rurais') && !imoveisCarFilter) {
    applyLayerVisibility('local:imoveis_rurais');
    return Promise.resolve();
  }
  return refreshViewportLayer(cfg).catch((e) => console.warn('filtro imóvel rural:', e));
}

export function resetRemoteLayersToDefault() {
  layerVisibility.clear();
  incraAssentFilter = '';
  imoveisCarFilter = '';
  for (const e of remoteWmsEntries) applyLayerVisibility(e.id);
  applyIncraAssentamentoFilter('', { fitMap: false });
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function bindViewportRefresh(cfg) {
  if (!hostMap || cfg._moveBound) return;
  cfg._moveBound = true;
  const onMove = () => {
    if (!isLayerWantedVisible(`local:${cfg.id}`)) return;
    clearTimeout(cfg._moveTimer);
    cfg._moveTimer = setTimeout(() => {
      refreshViewportLayer(cfg).catch((e) => console.warn('camada INEMA:', e));
    }, 450);
  };
  hostMap.on('moveend', onMove);
  cfg._onMove = onMove;
}

async function refreshViewportLayer(cfg) {
  if (!hostMap || !remoteWmsGroup) return;
  const id = `local:${cfg.id}`;
  const bbox = mapBbox(hostMap);
  if (!bbox) return;
  let gj = await fetchGeojsonBbox(cfg.geojson, bbox);
  if (cfg.id === 'imoveis_rurais' && imoveisCarFilter && gj?.features) {
    const key = imoveisCarFilter.toLowerCase();
    gj = {
      ...gj,
      features: gj.features.filter((f) => String(f.properties?.NUMERO_CAR || '').trim().toLowerCase() === key),
    };
  }
  let entry = remoteWmsEntries.find((e) => e.id === id);
  if (!entry) {
    const lyr = L.geoJSON(gj || { type: 'FeatureCollection', features: [] }, {
      renderer: L.canvas({ padding: 0.5 }),
      style: leafletStyle(cfg.style),
      onEachFeature: (feat, layer) => {
        bindFeaturePopup(layer, cfg.buildPopup(feat?.properties || {}, escHtml));
      },
    });
    entry = { id, layer: lyr };
    remoteWmsEntries.push(entry);
    bindViewportRefresh(cfg);
  } else {
    entry.layer.clearLayers();
    if (gj?.features?.length) entry.layer.addData(gj);
  }
  applyLayerVisibility(id);
}

/**
 * Carrega GeoJSON local (backend/shape/).
 * @param {L.LayerGroup} group
 * @param {RemoteWmsEntry[]} next
 * @param {object} cfg
 * @param {(props: object, esc: (s: string) => string) => string} buildPopup
 */
async function attachLocalGeojsonLayer(group, next, cfg, buildPopup) {
  const key = cfg.geojson;
  if (next.some((e) => e.id === `local:${cfg.id}`)) return;
  if (localLoadPromises.has(key)) return localLoadPromises.get(key);

  const promise = (async () => {
    let gj = null;
    if (cfg.id === 'assentamentos') {
      await fetchIncraAssentamentosFC();
      gj = incraAssentamentosActiveFC;
      if (!gj?.features?.length) return;
      const lyr = createIncraAssentamentosLeafletLayer(gj);
      next.push({ id: `local:${cfg.id}`, layer: lyr });
      remoteWmsEntries = next;
      applyLayerVisibility(`local:${cfg.id}`);
      applyIncraAssentamentoFilter(undefined, { fitMap: false });
      return;
    }
    if (cfg.heavy) {
      await refreshViewportLayer(cfg);
      return;
    }
    gj = await fetchGeojsonFile(cfg.geojson);
    if (!gj?.features?.length) return;
    const style = cfg.style || {};
    const lyr = L.geoJSON(gj, {
      style: {
        color: style.color || '#334155',
        weight: style.weight ?? 1.2,
        opacity: 0.85,
        fillColor: style.fillColor || style.color || '#94a3b8',
        fillOpacity: style.fillOpacity ?? 0.22,
        interactive: true,
      },
      onEachFeature: (feat, layer) => {
        bindFeaturePopup(layer, buildPopup(feat?.properties || {}, escHtml));
      },
    });
    next.push({ id: `local:${cfg.id}`, layer: lyr });
    remoteWmsEntries = next;
    applyLayerVisibility(`local:${cfg.id}`);
  })();

  localLoadPromises.set(key, promise);
  return promise;
}

/**
 * Remove camadas WMS remotas do mapa.
 * @param {L.Map} map
 */
export function clearRemoteWmsLayers(map) {
  if (remoteWmsGroup && map) {
    try { map.removeLayer(remoteWmsGroup); } catch (_) {}
  }
  remoteWmsGroup = null;
  remoteWmsEntries = [];
  lastRemoteWmsUf = '';
  localLoadPromises.clear();
  incraAssentamentoLeaflets = [];
  for (const cfg of SHAPE_OVERLAY_LAYERS) {
    if (cfg._onMove && hostMap) {
      try { hostMap.off('moveend', cfg._onMove); } catch (_) {}
    }
    cfg._moveBound = false;
    cfg._onMove = null;
  }
}

/**
 * Monta/atualiza malhas locais (GeoJSON). WMS remoto desativado.
 * @param {L.Map} map
 * @param {string} [uf] sigla UF (INCRA/CAR)
 * @param {{ loadLocalGeojson?: boolean }} [opts]
 */
export function syncRemoteWmsLayers(map, uf, opts = {}) {
  if (!map || !getApiBase()) return;

  hostMap = map;
  const loadLocalGeojson = opts.loadLocalGeojson !== false;
  const ufVal = String(uf || 'BA').trim().toUpperCase();
  if (remoteWmsGroup && lastRemoteWmsUf === ufVal && !loadLocalGeojson) return;

  clearRemoteWmsLayers(map);
  lastRemoteWmsUf = ufVal;
  remoteWmsGroup = L.layerGroup();
  const next = [];

  remoteWmsEntries = next;
  remoteWmsGroup.addTo(map);

  if (loadLocalGeojson) {
    attachAllLocalGeojsonLayers(remoteWmsGroup, next).catch((e) => console.warn('local geojson layers:', e));
  }
}

async function attachAllLocalGeojsonLayers(group, next) {
  const tasks = [
    ...INCRA_LOCAL_LAYERS.map((cfg) => (
      attachLocalGeojsonLayer(group, next, cfg, buildAssentamentoPopupHtml)
    )),
    ...SHAPE_OVERLAY_LAYERS.filter((cfg) => !cfg.heavy).map((cfg) => (
      attachLocalGeojsonLayer(group, next, cfg, cfg.buildPopup)
    )),
  ];
  await Promise.all(tasks);
}

/**
 * Carrega assentamentos locais após a varredura.
 * @param {L.Map} map
 */
export async function loadRemoteWmsLocalGeojsonLayers(map) {
  if (!map || !getApiBase() || !remoteWmsGroup) return;
  await attachAllLocalGeojsonLayers(remoteWmsGroup, remoteWmsEntries);
}
