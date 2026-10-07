/**
 * Orquestração DOM/Leaflet da app Taboa. Lógica pura em `./lib/`.
 */
import L from 'leaflet';
import proj4 from 'proj4';
import { registerProj4Defs } from './proj4Defs.js';
import { getApiBase } from './lib/config.js';
import { getInstitutionalGeojsonFetchUrls } from './lib/supabaseGeojsonConfig.js';
import {
  CENTER_BRASIL,
  ZOOM_BRASIL,
  CENTER_FAIXA_TABOA,
  ZOOM_FAIXA_TABOA,
  SHAPE_FILE,
  DEFERRED_SHAPE_GEOJSON_FILES,
  ASSENTAMENTOS_FILE,
  ALERT_STYLE,
  ASSENTAMENTOS_STYLE,
  ASSENTAMENTOS_STANDBY_STYLE,
  MAPBIOMAS_PAGE_LIMIT_FAIXA,
  PDF_GREEN,
  PDF_GREEN_LIGHT
} from './lib/constants.js';
import { tagFeaturesRegiaoTaboa, featureNomePublico, regiaoPlanejamentoLabel, cefirCarFromContainingFeatures, formatCefirCarFromFeatureProperties } from './lib/region.js';
import {
  geomCenter,
  parseCrsFromGeoJSON,
  inferCrsFromCoordinates,
  reprojectToWGS84,
  prepareGeoJsonForDisplay,
  needsReprojectToWgs84,
} from './lib/geoCore.js';
import { wktToGeoJSON, simplifiedPointsToPolygon } from './lib/wktParse.js';
import {
  alertRoughBbox,
  alertGeometryAndPoint,
  alertPointFallbackAssentamentoIndex,
  alertHitsFaixaPlanningArea,
  alertIntersectsAssentamentos,
  getAssentamentoNamesForAlert,
  alertBelongsToFeature,
  alertBelongsToResolvedAoi,
  computeClippedResult,
  resolveAlertClipInShape,
} from './lib/alertsIntersect.js';
import { signInClient, fetchAllAlertsClient, fetchAlertsForMunicipioClient } from './lib/mapbiomasClient.js';
import { consumeScanAlertsStream } from './lib/scanStream.js';
import { fetchFaixaGeoJson } from './lib/faixaGeojsonClient.js';
import { groupFaixaFeaturesByMunicipio } from './lib/faixaScanUtils.js';
import { normalizeFaixaShapeGeoJSON } from './lib/faixaShapeNormalize.js';
import { pickShapeFilename } from './lib/shapePick.js';
import { applyLightTheme } from './lib/theme.js';
import { clearCreds } from './lib/credentials.js';
import { isFaixaAlertsMode, buildFaixaAnalytics, renderFaixaAnalyticsHtml } from './lib/analyticsPanel.js';
import { yieldToMain } from './lib/yieldToMain.js';
import {
  initPeriodFilter,
  localTodayStr,
  resetPeriodFilter,
  syncPeriodInputs,
} from './lib/periodFilter.js';
import { setupMapPopupPlacement } from './lib/popupPlacement.js';
import { applyLayerOrder, bindLayerList, rendererFor } from './lib/layerOrder.js';
import {
  buildRegistrosLayer,
  buildRegistrosBufferLayer,
  parseDMSCoord,
  resolveRegistroCruzamentoAoi,
  REGISTRO_CRUZAMENTO_BUFFER_KM,
} from './lib/registros.js';
import { setupConsultaTab } from './lib/consultaTab.js';
import {
  resolvePrioritizedCruzamentoAoi,
} from './lib/cruzamentoPrioridade.js';
import { mergeCruzamentoCandidatesWithWfsPriority } from './lib/cruzamentoCandidatesMerge.js';
import { filterPropertyCandidatesForCar, linkedImoveisForAlertClip } from './lib/alertLinkedImoveis.js';
import { fetchLocalCruzamentoCandidates } from './lib/localCruzamentoClient.js';
import { BY_NOME, normMunNome } from './lib/faixaMunicipiosCatalog.js';
import {
  loadIbgeMunicipios,
  getMunicipioNamesByUf,
  findMunicipioFeature,
} from './lib/ibgeMunicipios.js';
import { fetchIncraLocalLayer } from './lib/localIncraClient.js';
import {
  syncRemoteWmsLayers,
  clearRemoteWmsLayers,
  loadRemoteWmsLocalGeojsonLayers,
  prefetchIncraAssentamentos,
  subscribeIncraAssentamentos,
  applyIncraAssentamentoFilter,
  getIncraAssentamentosFC,
  getIncraAssentamentosFullFC,
  getSelectedIncraAssentamentoFeature,
  resetRemoteLayersToDefault,
  restoreIncraAssentamentosFaixa,
  setRemoteLayerVisible,
  setImoveisRuraisCarFilter,
  setIncraAssentamentosPrepareHook,
  ensureIncraAssentamentosFromFile,
  flyToIncraAssentamentoIndex,
  flyToGeojsonFeature,
  isIncraAssentamentosLayerReady,
} from './lib/localMapLayers.js';
import { INCRA_LOCAL_LAYERS } from './lib/localIncraCatalog.js';
import { SHAPE_OVERLAY_LAYERS, buildMunicipiosPopupHtml } from './lib/localShapeLayers.js';
import { resolveFilterBbox } from './lib/incraFilterBbox.js';
import { fetchMunicipioPorCoordenada } from './lib/ibgeMunicipioPorCoordenadaClient.js';
import { WFS_MIN_ZOOM, bboxCacheKey, resolveEffectiveWfsContext } from './lib/localBbox.js';
import { collectImoveisAtPointForReport, pickCarCodeFromImovelRow, enrichLocalCamadasHa, enrichCruzamentoWithSettlementOverlap } from './lib/imovelConsulta.js';
import { assentamentoFeatureTitle } from './lib/assentamentoMeta.js';
import { biomaFromAlert, alertSinaisDetail, sinaisFromAlert, alertDetailRows, alertSourceLabel, buildDetailRowsHtml } from './lib/mapbiomasAlertMeta.js';
import * as turf from '@turf/turf';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});
registerProj4Defs(proj4);

let __taboaBootstrapped = false;

// ─── Loading overlay helpers ──────────────────────────────────────────────
function showLoading(msg = 'Processando…') {
  const el = document.getElementById('loadingOverlay');
  const lbl = document.getElementById('loadingLabel');
  if (!el) return;
  if (lbl) lbl.textContent = msg;
  el.classList.remove('hidden');
}
function updateLoading(msg) {
  const lbl = document.getElementById('loadingLabel');
  if (lbl) lbl.textContent = msg;
}
function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.classList.add('hidden');
}

// ─── Web Worker helper ────────────────────────────────────────────────────
/**
 * Executa a interseção de alertas ó assentamentos no Worker e devolve o resultado.
 * Fallback síncrono (loop direto) se o Worker falhar.
 *
 * @param {object[]} inRegion - alertas pré-filtrados pela faixa
 * @param {object[]} allFeatures - features GeoJSON dos assentamentos
 * @param {Array<number[]|null>} featBboxes - bboxes pré-computados
 * @param {(msg:string) => void} onProgress
 * @returns {Promise<{alertsByPolygon: object, allAlertCodes: string[]}>}
 */
async function runIntersectWorker(inRegion, allFeatures, featBboxes, onProgress) {
  const preparedAlerts = inRegion.map((a) => {
    const { geojson, point } = alertGeometryAndPoint(a);
    const roughBbox = alertRoughBbox(a);
    return { alertCode: a.alertCode, geojson, point, roughBbox };
  });
  const preparedFeatures = allFeatures.map((f, idx) => ({
    idx,
    geometry: f?.geometry ?? null,
    bbox: featBboxes[idx] ?? null
  }));

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL('./workers/intersect.worker.js', import.meta.url), { type: 'module' });
    } catch (_) {
      resolve(fallbackIntersect(inRegion, allFeatures, featBboxes));
      return;
    }
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        onProgress?.(`Cruzando alertas ${e.data.processed}/${e.data.total}…`);
      } else if (e.data.type === 'result') {
        worker.terminate();
        resolve(e.data);
      }
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(fallbackIntersect(inRegion, allFeatures, featBboxes));
    };
    worker.postMessage({ alerts: preparedAlerts, features: preparedFeatures });
  });
}

/** Interseção síncrona (fallback sem Worker) */
function fallbackIntersect(inRegion, allFeatures, featBboxes) {
  const nFeat = allFeatures.length;
  const alertsByPolygon = {};
  const allAlertCodes = [];
  const seenCodes = new Set();
  for (let i = 0; i < nFeat; i++) alertsByPolygon[i] = [];

  for (const a of inRegion) {
    const ab = alertRoughBbox(a);
    if (!ab) {
      const idx0 = alertPointFallbackAssentamentoIndex(a, allFeatures);
      if (idx0 >= 0) {
        alertsByPolygon[idx0].push(a.alertCode);
        if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      }
      continue;
    }
    const [ax0, ay0, ax1, ay1] = ab;
    let matched = false;
    for (let oi = 0; oi < nFeat; oi++) {
      const bb = featBboxes[oi];
      if (!bb || ax1 < bb[0] || ax0 > bb[2] || ay1 < bb[1] || ay0 > bb[3]) continue;
      if (!alertBelongsToFeature(a, allFeatures[oi])) continue;
      alertsByPolygon[oi].push(a.alertCode);
      if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      matched = true;
    }
    if (!matched) {
      const idx = alertPointFallbackAssentamentoIndex(a, allFeatures);
      if (idx >= 0) {
        alertsByPolygon[idx].push(a.alertCode);
        if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertCodes.push(a.alertCode); }
      }
    }
  }
  return { alertsByPolygon, allAlertCodes };
}

/** Inicializa mapa, listeners e rotinas Taboa. */
export function bootstrapTaboa() {
  if (__taboaBootstrapped) return;
  __taboaBootstrapped = true;
  applyLightTheme();

    const API_BASE = getApiBase();
    let loadedGeoJSONByFile = {}; // { filename: geojson } - arquivos carregados em memória
    let shapeFolderLoadInFlight = null;
    /** GeoJSONs complementares (assentamentos, UCs, etc.) — após varredura. */
    let deferredShapesLoadInFlight = null;
    let deferredShapesLoaded = false;
    let shapeFolderListSignature = '';

    function setAssentamentosLayerStandby(standby) {
      if (!assentamentosLayer) return;
      const st = standby ? ASSENTAMENTOS_STANDBY_STYLE : ASSENTAMENTOS_STYLE;
      assentamentosLayer.eachLayer((layer) => {
        if (layer.setStyle) layer.setStyle(st);
      });
    }

    function removeFaixaSearchLayerFromMap() {
      if (faixaSearchLayer && map) {
        try { map.removeLayer(faixaSearchLayer); } catch (_) {}
        faixaSearchLayer = null;
      }
    }

    /** Mostra no mapa os polígonos da faixa (referência da varredura); fica atrás dos assentamentos. */
    function showFaixaSearchLayerOnMap() {
      removeFaixaSearchLayerFromMap();
      if (!map || !faixaPlanejamentoGeoJSON?.features?.length) return;
      const st = { color: '#22d3ee', weight: 1.25, opacity: 0.95, fillColor: '#0891b2', fillOpacity: 0.2 };
      faixaSearchLayer = L.geoJSON(faixaPlanejamentoGeoJSON, { style: st, interactive: false });
      faixaSearchLayer.addTo(map);
      try {
        if (typeof faixaSearchLayer.bringToBack === 'function') faixaSearchLayer.bringToBack();
        if (assentamentosLayer && typeof assentamentosLayer.bringToFront === 'function') assentamentosLayer.bringToFront();
      } catch (_) {}
    }

    let scanStatusActive = false;

    function setStatus(msg, isError = false) {
      const el = document.getElementById('status');
      if (!el) return;
      el.textContent = msg;
      el.className = 'status-pill' + (isError ? ' error' : (msg.startsWith('✓') ? ' success' : ''));
      el.hidden = true;
      if (isError) hideScanStatus();
    }

    function hideScanStatus() {
      scanStatusActive = false;
      const wrap = document.getElementById('scanStatus');
      if (wrap) {
        wrap.hidden = true;
        wrap.classList.remove('is-indeterminate');
      }
      const el = document.getElementById('status');
      if (el) el.hidden = true;
    }

    function showScanStatusPrep(message) {
      const wrap = document.getElementById('scanStatus');
      const raw = String(message || '');
      if (/alerta\(s\) MapBiomas na faixa/i.test(raw)) return;
      if (/falha em /i.test(raw)) return;
      if (/instável|tentativa/i.test(raw) && wrap && !wrap.hidden && !wrap.classList.contains('is-indeterminate')) {
        const metaEl = document.getElementById('scanStatusMeta');
        if (metaEl) metaEl.textContent = 'Reconectando à API…';
        return;
      }
      scanStatusActive = true;
      const pill = document.getElementById('status');
      const titleEl = document.getElementById('scanStatusTitle');
      const metaEl = document.getElementById('scanStatusMeta');
      const pctEl = document.getElementById('scanStatusPct');
      const fill = document.getElementById('scanStatusFill');
      const track = document.getElementById('scanStatusTrack');
      if (pill) pill.hidden = true;
      if (!wrap) return;
      wrap.hidden = false;
      if (titleEl) titleEl.textContent = 'Status';
      if (/cache/i.test(raw)) {
        wrap.classList.remove('is-indeterminate');
        if (metaEl) metaEl.textContent = 'Resultado em cache';
        if (pctEl) pctEl.textContent = '100%';
        if (fill) {
          fill.style.transform = 'none';
          fill.style.width = '100%';
        }
        if (track) track.setAttribute('aria-valuenow', '100');
        return;
      }
      wrap.classList.add('is-indeterminate');
      if (metaEl) {
        metaEl.textContent = /instável|tentativa/i.test(raw)
          ? 'Reconectando à API…'
          : 'Consultando municípios da faixa…';
      }
      if (pctEl) pctEl.textContent = '…';
      if (fill) fill.style.width = '36%';
      if (track) track.setAttribute('aria-valuenow', '0');
    }

    function updateScanStatusProgress({ completed = 0, total = 0, municipality = '' } = {}) {
      scanStatusActive = true;
      const wrap = document.getElementById('scanStatus');
      const pill = document.getElementById('status');
      const titleEl = document.getElementById('scanStatusTitle');
      const metaEl = document.getElementById('scanStatusMeta');
      const pctEl = document.getElementById('scanStatusPct');
      const fill = document.getElementById('scanStatusFill');
      const track = document.getElementById('scanStatusTrack');
      if (pill) pill.hidden = true;
      if (!wrap) return;
      wrap.hidden = false;
      wrap.classList.remove('is-indeterminate');
      const tot = Math.max(0, Number(total) || 0);
      const done = Math.max(0, Number(completed) || 0);
      const pct = tot > 0 ? Math.min(100, Math.round((done / tot) * 100)) : 0;
      const mun = String(municipality || '').trim();
      if (titleEl) titleEl.textContent = 'Status';
      if (metaEl) {
        metaEl.textContent = tot > 0
          ? (mun ? `${mun} · ${done} de ${tot} municípios` : `${done} de ${tot} municípios`)
          : (mun || 'Consultando municípios da faixa…');
      }
      if (pctEl) pctEl.textContent = tot > 0 ? `${pct}%` : '…';
      if (fill) {
        fill.style.transform = 'none';
        fill.style.width = `${pct}%`;
      }
      if (track) {
        track.setAttribute('aria-valuenow', String(pct));
        track.setAttribute('aria-valuemax', '100');
      }
    }

    function showLogin() {}

    function hideLogin() {}

    function setupAjudaConsulta() {
      const tab = document.getElementById('btnAjudaConsulta');
      const pageAjuda = document.getElementById('pageOrientacoes');
      const pageMapa = document.getElementById('pageMapa');
      const btnVoltar = document.getElementById('btnAjudaVoltar');
      if (!tab || !pageAjuda || !pageMapa) return;

      const isAjudaHash = () => {
        const h = String(location.hash || '').replace(/^#\/?/, '');
        return h === 'orientacoes';
      };

      const syncAjudaPage = () => {
        const on = isAjudaHash();
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-pressed', on ? 'true' : 'false');
        pageAjuda.hidden = !on;
        pageMapa.hidden = on;
        if (!on && map) {
          requestAnimationFrame(() => map.invalidateSize());
        }
      };

      tab.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isAjudaHash()) return;
        location.hash = 'orientacoes';
      });
      btnVoltar?.addEventListener('click', (ev) => {
        ev.preventDefault();
        location.hash = '';
      });
      document.getElementById('topbarHome')?.addEventListener('click', (ev) => {
        if (!isAjudaHash()) return;
        ev.preventDefault();
        location.hash = '';
      });
      window.addEventListener('hashchange', syncAjudaPage);
      syncAjudaPage();
    }

    /** Mensagem pós-varredura na faixa (MapBiomas Alerta). */
    function formatFaixaAlertsStatus() {
      return '✓ Alertas carregados com sucesso';
    }

    let map = null, alertsLayer = null, assentamentosLayer = null, assentamentosGeoJSON = null;
    /** Camada só visual durante a varredura MapBiomas (municípios da faixa). */
    let faixaSearchLayer = null;
    /** Municípios da faixa 05/06/07 (shape oficial) em WGS84. */
    let faixaPlanejamentoGeoJSON = null;
    const featureLayersByIndex = new Map(); // índice -> layer Leaflet para mostrar/esconder shape individual
    const alertLayersByCode = new Map();
    const selectedShapeIndices = new Set();
    let currentAlertsFlat = [];
    let currentDetailIndex = 0;
    let currentAlertsByPolygon = {};
    let currentAllFeatures = [];
    /** Alertas únicos na faixa 05/06/07 — base da síntese regional no PDF. */
    let currentAlertsNaFaixaPlanejamento = [];
    let runLoadAlertsGeneration = 0;
    /** Promise da varredura MapBiomas em andamento (consulta aguarda antes de cruzar). */
    let loadAlertsInFlight = null;
    /** Camadas de registros (CRA, FIAGRO…) carregadas do backend. */
    let registrosLayerGroup = null;
    let registrosBufferLayerGroup = null;
    let consultaTabApi = null;
    /** Polígonos WFS + camada da faixa no mapa — cruzamento por menor área. */
    let cruzamentoCandidates = [];
    /** Polígonos WFS já carregados — reutilizados no cruzamento local. */
    let wfsLocalCandidates = [];
    /** Cache de candidatos WFS remotos por bbox (cruzamento). */
    const wfsCruzamentoCache = new Map();
    /**
     * Registro de dados WFS em background — contém GeoJSON de TODAS as camadas
     * (INCRA + CAR), independente de toggle. Chave = cacheKey de bbox+camada.
     * Usado como fonte de AOI para MapBiomas e para cruzamento.
     */
    const wfsBackgroundRegistry = new Map();
    let wfsBackgroundLoadInFlight = false;
    /** Bbox grossa (precisão 2) do último preload — evita limpar registry ao refrescar WMS. */
    let lastWfsPreloadBboxKey = null;

    function clearWfsCruzamentoCache() {
      wfsCruzamentoCache.clear();
    }

    let wfsBgMoveHandler = null;
    let wfsBgLoadTimer = null;
    let remoteLayersRefreshTimer = null;

    function attachWfsBackgroundPreloadHandler() {
      if (!map || wfsBgMoveHandler) return;
      wfsBgMoveHandler = () => {
        clearTimeout(wfsBgLoadTimer);
        wfsBgLoadTimer = setTimeout(() => {
          resolveFilterBbox().then((filterCtx) => {
            if (filterCtx?.bbox && filterCtx.uf && API_BASE) {
              preloadAllWfsLayersInBackground(filterCtx).catch(() => {});
            }
          });
        }, 550);
      };
      map.on('moveend', wfsBgMoveHandler);
    }

    function scheduleRemoteLayersRefresh(delayMs = 400) {
      clearTimeout(remoteLayersRefreshTimer);
      remoteLayersRefreshTimer = setTimeout(() => {
        refreshRemoteLayersAndPreload().catch((e) => console.warn(e));
      }, delayMs);
    }

    async function refreshRemoteLayersAndPreload(opts = {}) {
      const loadLocalGeojson = opts.loadLocalGeojson !== false;
      if (!API_BASE) return;
      await initMap();
      const filterCtx = await resolveFilterBbox();
      const uf = filterCtx?.uf || document.getElementById('filterEstado')?.value?.trim().toUpperCase() || 'BA';
      if (map) {
        syncRemoteWmsLayers(map, uf, { loadLocalGeojson });
      }
      if (!loadLocalGeojson) return;
      const effective = map && filterCtx?.bbox
        ? resolveEffectiveWfsContext(map, filterCtx)
        : null;
      const preloadBbox = effective?.effectiveBbox || filterCtx?.bbox;
      const newPreloadKey = preloadBbox ? bboxCacheKey(preloadBbox, 2) : null;
      if (newPreloadKey !== lastWfsPreloadBboxKey) {
        wfsBackgroundRegistry.clear();
        lastWfsPreloadBboxKey = newPreloadKey;
      }
      if (filterCtx?.bbox && filterCtx.uf) {
        await preloadAllWfsLayersInBackground(filterCtx);
      }
    }

    function incraKindForCruzamento(layerId) {
      if (layerId === 'assentamentos') return 'assentamento';
      return 'outros';
    }

    function registerWfsGeojsonForCruzamento(sourceLabel, geojson, kind) {
      wfsLocalCandidates = wfsLocalCandidates.filter((c) => c.sourceFile !== sourceLabel);
      const feats = geojson?.features || [];
      for (let i = 0; i < feats.length; i++) {
        const f = feats[i];
        const t = f?.geometry?.type;
        if (!f?.geometry || (t !== 'Polygon' && t !== 'MultiPolygon')) continue;
        let bbox = null;
        try { bbox = turf.bbox(f); } catch (_) {}
        wfsLocalCandidates.push({
          feature: f,
          sourceFile: sourceLabel,
          kind,
          featureIndex: i,
          bbox,
          _wfsLocal: true,
          sourceTier: 1,
        });
      }
    }

    /**
     * Retorna todas as feições do registry WFS em background como candidatos de cruzamento.
     * Exclui FUNAI (indígenas). Usado como AOI para MapBiomas e cruzamento direto.
     */
    function getWfsBackgroundCandidates() {
      const out = [];
      for (const [key, entry] of wfsBackgroundRegistry) {
        const { geojson, sourceLabel, kind } = entry;
        const feats = geojson?.features || [];
        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          const t = f?.geometry?.type;
          if (!f?.geometry || (t !== 'Polygon' && t !== 'MultiPolygon')) continue;
          let bbox = null;
          try { bbox = turf.bbox(f); } catch (_) {}
          out.push({ feature: f, sourceFile: sourceLabel, kind, featureIndex: i, bbox, _wfsBackground: true, sourceTier: 1 });
        }
      }
      return out;
    }

    /**
     * Calcula a bbox união de todas as feições carregadas em background pelo WFS
     * (INCRA + CAR). Retorna null se vazio.
     */
    function getWfsBackgroundAoiBbox() {
      const pts = [];
      for (const { geojson } of wfsBackgroundRegistry.values()) {
        const feats = geojson?.features || [];
        for (const f of feats) {
          if (!f?.geometry) continue;
          try {
            const bb = turf.bbox(f);
            pts.push([bb[0], bb[1]], [bb[2], bb[3]]);
          } catch (_) {}
        }
      }
      if (!pts.length) return null;
      const lngs = pts.map((p) => p[0]);
      const lats = pts.map((p) => p[1]);
      return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
    }

    /**
     * Pré-carrega WFS (backend) para cruzamento — todas as malhas INCRA + CAR.
     * Visualização no mapa é GeoJSON local (localMapLayers.js).
     */
    async function preloadAllWfsLayersInBackground(filterCtx) {
      if (!API_BASE || !filterCtx?.bbox || !filterCtx.uf) return;
      if (loadAlertsInFlight) return;
      if (wfsBackgroundLoadInFlight) return;

      const effective = resolveEffectiveWfsContext(map, filterCtx);
      if (!effective.zoomOk || !effective.effectiveBbox) return;
      const loadBbox = effective.effectiveBbox;

      wfsBackgroundLoadInFlight = true;
      try {
        const tasks = [];

        for (const cfg of INCRA_LOCAL_LAYERS) {
          const cacheKey = `bg:incra:${cfg.id}:${filterCtx.uf}:${bboxCacheKey(loadBbox)}`;
          if (wfsBackgroundRegistry.has(cacheKey)) continue;
          tasks.push((async () => {
            try {
              const json = await fetchIncraLocalLayer(cfg.id, filterCtx.uf, loadBbox, {
                municipio: filterCtx.municipio || undefined,
              });
              const geojson = json.geojson;
              if (geojson?.features?.length) {
                const sourceLabel = cfg.local ? cfg.label : `WFS INCRA ${cfg.label}`;
                wfsBackgroundRegistry.set(cacheKey, { geojson, sourceLabel, kind: incraKindForCruzamento(cfg.id) });
                registerWfsGeojsonForCruzamento(sourceLabel, geojson, incraKindForCruzamento(cfg.id));
              }
            } catch (_) {}
          })());
        }

        await Promise.all(tasks);
      } finally {
        wfsBackgroundLoadInFlight = false;
      }
    }

    function wfsCruzamentoCacheKey(uf, bbox, ibgeId) {
      return `${uf}:${(bbox || []).map((n) => Number(n).toFixed(3)).join(',')}:${ibgeId || ''}`;
    }

    async function fetchRemoteCruzamentoCandidates(aoi, filterCtx) {
      if (!API_BASE || !filterCtx?.uf || !aoi) return [];
      let bbox;
      try {
        bbox = turf.bbox(aoi);
        const pad = 0.05;
        const latPad = Math.max((bbox[3] - bbox[1]) * pad, 0.003);
        const lngPad = Math.max((bbox[2] - bbox[0]) * pad, 0.003);
        bbox = [bbox[0] - lngPad, bbox[1] - latPad, bbox[2] + lngPad, bbox[3] + latPad];
      } catch (_) {
        return [];
      }
      const key = wfsCruzamentoCacheKey(filterCtx.uf, bbox, filterCtx.ibgeId);
      if (wfsCruzamentoCache.has(key)) return wfsCruzamentoCache.get(key);
      try {
        const json = await fetchLocalCruzamentoCandidates({
          uf: filterCtx.uf,
          bbox,
          ibgeId: filterCtx.ibgeId,
          municipio: filterCtx.municipio || undefined,
        });
        const cands = json.candidates || [];
        wfsCruzamentoCache.set(key, cands);
        return cands;
      } catch (e) {
        console.warn('WFS cruzamento:', e);
        return [];
      }
    }

    function bindPopupLazy(lyr, feat, htmlFn) {
      lyr.on('click', () => {
        if (!lyr.getPopup()) {
          lyr.bindPopup(htmlFn(feat), { maxWidth: 340 });
        }
        lyr.openPopup();
      });
    }

    let registrosVisible = true;
    /** Todos os registros carregados — mantidos para reaplicar filtro sem novo fetch. */
    let currentRegistrosRecords = [];

    async function initMap() {
      if (map) return;
      const el = document.getElementById('map');
      if (!el) return;
      if (window.__taboaLeafletMap && window.__taboaLeafletMap !== map) {
        try { window.__taboaLeafletMap.remove(); } catch (_) {}
        window.__taboaLeafletMap = null;
      }
      if (el._leaflet_id) {
        try {
          el.replaceChildren();
          delete el._leaflet_id;
        } catch (_) {}
      }
      map = L.map(el, { zoomControl: false, preferCanvas: false }).setView(CENTER_FAIXA_TABOA, ZOOM_FAIXA_TABOA);
      window.__taboaLeafletMap = map;
      setupMapPopupPlacement(map);
      applyLayerOrder(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19,
        crossOrigin: 'anonymous',
        updateWhenIdle: true,
        keepBuffer: 2,
      }).addTo(map);
      if (API_BASE) {
        const uf = document.getElementById('filterEstado')?.value?.trim().toUpperCase() || 'BA';
        syncRemoteWmsLayers(map, uf);
        attachWfsBackgroundPreloadHandler();
        map.on('zoomend', () => scheduleRemoteLayersRefresh(300));
      }
    }

    function fitMapToFaixaBounds() {
      if (!map || !faixaPlanejamentoGeoJSON?.features?.length) return;
      try {
        if (!fitMapToFaixaBounds._cached || !fitMapToFaixaBounds._cached.isValid()) {
          const tmp = L.geoJSON(faixaPlanejamentoGeoJSON);
          fitMapToFaixaBounds._cached = tmp.getBounds();
        }
        const b = fitMapToFaixaBounds._cached;
        if (b.isValid()) {
          map.fitBounds(b, { padding: [28, 28], maxZoom: 10, animate: false });
        }
      } catch (_) {}
    }

    function mergeActiveCruzamentoCandidates(wfsRemote = []) {
      const bgCands = getWfsBackgroundCandidates();
      return mergeCruzamentoCandidatesWithWfsPriority({
        shape: cruzamentoCandidates || [],
        wfsLocal: bgCands.length ? bgCands : (wfsLocalCandidates || []),
        wfsRemote,
      });
    }

    function processAndDisplayGeoJSON(geojson) {
      if (!map || !geojson) return null;
      const prepared = prepareGeoJsonForDisplay(geojson);
      if (!prepared) return null;
      geojson = prepared;
      const sourceCrs = parseCrsFromGeoJSON(geojson) || inferCrsFromCoordinates(geojson);
      const needsReproject = needsReprojectToWgs84(sourceCrs);
      tagFeaturesRegiaoTaboa(geojson);
      assentamentosGeoJSON = geojson;
      selectedShapeIndices.clear();
      const features = geojson.features || [];
      for (let i = 0; i < features.length; i++) selectedShapeIndices.add(i);
      if (assentamentosLayer) { map.removeLayer(assentamentosLayer); assentamentosLayer = null; }
      featureLayersByIndex.clear();
      let featureIndex = 0;
      assentamentosLayer = L.geoJSON(geojson, {
        style: ASSENTAMENTOS_STYLE,
        interactive: true,
        renderer: rendererFor(map, 'municipios'),
        onEachFeature: (f, layer) => {
          const idx = featureIndex++;
          layer._featureIndex = idx;
          featureLayersByIndex.set(idx, layer);
          layer.bindPopup(buildMunicipiosPopupHtml(f.properties || {}, escConsultaHtml), { maxWidth: 380 });
        }
      });
      // Fase 1: camada amarela local não é adicionada ao mapa por padrão;
      // o toggle chkShape (se ativo) ainda permite mostrar manualmente.
      const chkShape = document.getElementById('chkShape');
      if (chkShape?.checked) assentamentosLayer.addTo(map);
      const crsInfo = needsReproject ? ' (' + sourceCrs + ' → WGS84)' : '';
      setStatus('✓ GeoJSON carregado' + crsInfo + '. Marque os shapes para varredura e clique em Atualizar.');
      syncCruzamentoCandidates();
      return assentamentosGeoJSON;
    }

    function resolveBackendUrl(path) {
      if (!API_BASE) return path.startsWith('/') ? path : '/' + path;
      return API_BASE + (path.startsWith('/') ? path : '/' + path);
    }

    const FETCH_OPTS = API_BASE && typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(90000) }
      : {};

    async function listGeoJSONPathsFromShapeFolder() {
      try {
        const r = await fetch(resolveBackendUrl('/api/shape-files'), FETCH_OPTS);
        if (r && r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length > 0)
            return arr.map(f => (f.includes('/') ? f : 'shape/' + f));
        }
      } catch (_) {}
      const dirUrls = API_BASE ? [resolveBackendUrl('shape/')] : ['shape/', './shape/'];
      for (const url of dirUrls) {
        try {
          const r = await fetch(url);
          if (!r || !r.ok) continue;
          const html = await r.text();
          const found = [];
          const re = /href=["']([^"']*\.geojson)["']/gi;
          let m;
          while ((m = re.exec(html)) !== null) {
            const name = m[1].replace(/^\.\//, '').split('/').pop();
            if (name && !found.includes(name)) found.push(name);
          }
          if (found.length > 0) return found.map(n => (url.startsWith('./') ? './shape/' : 'shape/') + n);
        } catch (_) {}
      }
      return [];
    }

    function syncCruzamentoCandidates() {
      cruzamentoCandidates = [];
      if (assentamentosGeoJSON?.features?.length) {
        for (let i = 0; i < assentamentosGeoJSON.features.length; i++) {
          const f = assentamentosGeoJSON.features[i];
          if (!f?.geometry) continue;
          const t = f.geometry.type;
          if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
          let bbox = null;
          try { bbox = turf.bbox(f.geometry); } catch (_) {}
          cruzamentoCandidates.push({
            feature: f,
            sourceFile: '_camada_mapa_atual_',
            kind: 'assentamento',
            featureIndex: i,
            bbox,
            sourceTier: 2,
          });
        }
      }
    }

    /**
     * Carrega todos os .geojson listados em shape/. Evita pedidos repetidos: em voo deduplicado,
     * mesma assinatura de pastas + mesmo conjunto de chaves → reutiliza `loadedGeoJSONByFile`.
     * @param {{ force?: boolean }} opts — force: ignora cache em memória.
     */
    async function loadAllGeoJSONFromShape(opts) {
      if (shapeFolderLoadInFlight) return shapeFolderLoadInFlight;
      shapeFolderLoadInFlight = (async () => {
        try {
          return await loadAllGeoJSONFromShapeCore(opts || {});
        } finally {
          shapeFolderLoadInFlight = null;
        }
      })();
      return shapeFolderLoadInFlight;
    }

    async function loadAllGeoJSONFromShapeCore(opts) {
      const force = opts && opts.force === true;
      const deferredOnly = opts && opts.deferredOnly === true;
      if (!map) return [];
      const allPaths = await listGeoJSONPathsFromShapeFolder();
      const deferredSet = new Set(DEFERRED_SHAPE_GEOJSON_FILES);
      const skipGeneric = new Set([
        SHAPE_FILE,
        'alertas.geojson',
        'municipios.geojson',
        ASSENTAMENTOS_FILE,
        ...SHAPE_OVERLAY_LAYERS.map((c) => c.geojson),
      ]);
      const paths = (deferredOnly
        ? allPaths.filter((p) => deferredSet.has(p.split('/').pop()))
        : allPaths.filter((p) => !deferredSet.has(p.split('/').pop()) || force)
      ).filter((p) => !skipGeneric.has(p.split('/').pop()));
      if (paths.length === 0) {
        return [];
      }
      const sig = paths.map((p) => p.split('/').pop()).filter(Boolean).sort().join('|');
      const keysSorted = Object.keys(loadedGeoJSONByFile).sort().join('|');
      if (!force && !deferredOnly && shapeFolderListSignature === sig && keysSorted === sig && Object.keys(loadedGeoJSONByFile).length > 0) {
        return Object.keys(loadedGeoJSONByFile);
      }
      const pending = deferredOnly
        ? paths.filter((p) => !loadedGeoJSONByFile[p.split('/').pop()])
        : paths;
      if (!pending.length) return Object.keys(loadedGeoJSONByFile);
      if (!deferredOnly) {
        setStatus('Indexando pasta shape…');
        loadedGeoJSONByFile = {};
      }
      setStatus(`Carregando ${pending.length === 1 ? '1 arquivo' : pending.length + ' arquivo(s)'} de camadas…`);
      const results = await Promise.all(pending.map(async (p) => {
        const name = p.split('/').pop();
        const urls = getInstitutionalGeojsonFetchUrls(name, { apiBase: API_BASE });
        for (const url of urls) {
          try {
            const fetchUrl = /^https?:\/\//i.test(url) ? url : resolveBackendUrl(url);
            const r = await fetch(fetchUrl, FETCH_OPTS);
            if (!r || !r.ok) continue;
            const geojson = await r.json();
            if (geojson && (geojson.type === 'FeatureCollection' || geojson.type === 'Feature' || geojson.features)) {
              return { name, geojson };
            }
          } catch (_) {}
        }
        return null;
      }));
      for (const x of results) {
        if (x) loadedGeoJSONByFile[x.name] = x.geojson;
      }
      const keys = Object.keys(loadedGeoJSONByFile);
      if (keys.length === 0 && !deferredOnly) {
        setStatus('Erro ao carregar os arquivos.');
        shapeFolderListSignature = '';
        return [];
      }
      if (!deferredOnly) {
        const loadedSig = keys.sort().join('|');
        shapeFolderListSignature = loadedSig === sig ? sig : '';
      }
      queueMicrotask(() => {
        try { syncCruzamentoCandidates(); } catch (e) { console.warn(e); }
      });
      return keys;
    }

    /** Camadas fundiárias pesadas — só após varredura MapBiomas (não compete com scan). */
    async function loadDeferredShapeAssets() {
      if (deferredShapesLoaded) return;
      if (deferredShapesLoadInFlight) return deferredShapesLoadInFlight;
      deferredShapesLoadInFlight = (async () => {
        try {
          await loadAllGeoJSONFromShape({ deferredOnly: true });
          if (map && API_BASE) {
            await loadRemoteWmsLocalGeojsonLayers(map);
            const filterCtx = await resolveFilterBbox();
            if (filterCtx?.bbox && filterCtx.uf) {
              await preloadAllWfsLayersInBackground(filterCtx);
            }
          }
          deferredShapesLoaded = true;
        } catch (e) {
          console.warn('loadDeferredShapeAssets:', e);
        } finally {
          deferredShapesLoadInFlight = null;
        }
      })();
      return deferredShapesLoadInFlight;
    }

    function scheduleDeferredShapeAssetsAfterScan() {
      loadDeferredShapeAssets().catch((e) => console.warn('deferred shapes:', e));
    }

    /** Prepara cópia do GeoJSON da faixa (reprojeta UTM→WGS84; mantém 4326/4674/4979). */
    function prepareFaixaFC(raw) {
      const fg = prepareGeoJsonForDisplay(raw);
      if (!fg) return null;
      const normalized = normalizeFaixaShapeGeoJSON(fg);
      if (!normalized?.features?.length) return null;
      return normalized;
    }

    /**
     * Garante faixaPlanejamentoGeoJSON — municípios da faixa TABOA.
     */
    async function ensureFaixaPlanejamentoReady(options = {}) {
      const quiet = !!options.quiet;
      if (!map) return false;

      try {
        if (!quiet) setStatus('A carregar faixa oficial (Supabase)…');
        const resp = await fetchFaixaGeoJson();
        if (resp.ok && resp.geojson) {
          const prepared = prepareFaixaFC(resp.geojson);
          if (prepared?.features?.length) {
            faixaPlanejamentoGeoJSON = prepared;
            const nMun = groupFaixaFeaturesByMunicipio(prepared.features).length;
            if (!quiet) {
              setStatus(`✓ Faixa oficial (${nMun} municípios 05/06/07) — varredura MapBiomas unificada.`);
            }
            fitMapToFaixaBounds();
            return true;
          }
        }
        if (!quiet && resp.error) console.warn('Faixa oficial:', resp.error);
      } catch (e) {
        console.warn('Faixa oficial:', e);
      }

      faixaPlanejamentoGeoJSON = null;
      if (!quiet) {
        setStatus(`Shape da faixa (${SHAPE_FILE}) não encontrado no Supabase.`, true);
      }
      return false;
    }

    /**
     * Só faixa oficial (API) — leve no startup e antes da varredura.
     */
    async function bootstrapFaixaMinimal() {
      if (!map) return false;
      const ok = await ensureFaixaPlanejamentoReady({ quiet: true });
      if (ok && faixaPlanejamentoGeoJSON) {
        processAndDisplayGeoJSON(faixaPlanejamentoGeoJSON);
      }
      setStatus('✓ Pronto. Varrendo alertas MapBiomas na faixa 05/06/07.');
      return ok;
    }

    /**
     * Modo sem backend: carrega todos os shapes locais (inclui faixa em disco).
     */
    async function bootstrapTaboaShapes() {
      if (!map) return false;
      await loadAllGeoJSONFromShape().catch(() => []);
      const ok = await ensureFaixaPlanejamentoReady({ quiet: true });
      if (ok && faixaPlanejamentoGeoJSON) {
        processAndDisplayGeoJSON(faixaPlanejamentoGeoJSON);
      }
      await loadDeferredShapeAssets();
      setStatus('✓ Pronto. Varrendo alertas MapBiomas na faixa 05/06/07.');
      return ok;
    }

    function syncAllShapeLayersVisibility() {
      const f = assentamentosGeoJSON?.features || [];
      for (let i = 0; i < f.length; i++) toggleShapeVisibility(i, selectedShapeIndices.has(i));
    }

    function foldFilterText(s) {
      return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }

    async function refreshIncraAssentamentosForCurrentAoi() {
      await ensureIncraAssentamentosFromFile(map);
      populateAssentamentoSelect();
      return getIncraAssentamentosFullFC()?.features?.length || 0;
    }

    /** Itens do seletor pesquisável de assentamentos INCRA. */
    let _assentamentoComboboxItems = [];

    function assentamentoItemLabel(f) {
      const title = assentamentoFeatureTitle(f.properties);
      const mun = f.properties?.municipio || f.properties?.nm_municip || '';
      return mun ? `${title} (${mun})` : title;
    }

    function populateAssentamentoSelect() {
      const section = document.getElementById('shapesScanSection');
      const input = document.getElementById('selectAssentamento');
      if (!section || !input) return;
      section.style.display = 'block';
      const features = (getIncraAssentamentosFullFC()?.features
        || getIncraAssentamentosFC()?.features
        || []).filter((f) => BY_NOME.has(normMunNome(
          f.properties?.municipio || f.properties?.nm_municip || f.properties?.nm_municipio || '',
        )));
      const mun = foldFilterText(document.getElementById('filterMunicipio')?.value);
      const prevIdx = input.dataset.index || '';
      const allItems = features
        .map((f, i) => {
          const srcIdx = Number.isInteger(f?.__srcIdx) ? f.__srcIdx : i;
          const label = assentamentoItemLabel(f);
          const extra = [
            f.properties?.codigo_sipra,
            f.properties?.cd_sipra,
            f.properties?.sipra,
            f.properties?.municipio,
            f.properties?.nm_municip,
          ].filter(Boolean).join(' ');
          return { i: srcIdx, label, search: foldFilterText(`${label} ${extra}`) };
        })
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
      const filtered = mun ? allItems.filter((item) => item.search.includes(mun)) : allItems;
      _assentamentoComboboxItems = filtered.length ? filtered : allItems;

      const kept = _assentamentoComboboxItems.find((x) => String(x.i) === String(prevIdx));
      if (kept) {
        input.value = kept.label;
        input.dataset.index = String(kept.i);
      } else {
        input.value = '';
        input.dataset.index = '';
      }
    }

    function renderAssentamentoDropdown(items) {
      const ul = document.getElementById('assentamentosDropdown');
      const input = document.getElementById('selectAssentamento');
      if (!ul) return;
      const selectedIdx = input?.dataset.index || '';
      ul.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('li');
        empty.className = 'filter-combobox-empty';
        empty.textContent = 'Nenhum resultado';
        ul.appendChild(empty);
        return;
      }
      for (const item of items) {
        const li = document.createElement('li');
        li.dataset.index = String(item.i);
        li.textContent = item.label;
        li.title = item.label;
        if (String(item.i) === selectedIdx) li.setAttribute('aria-selected', 'true');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          pickAssentamentoItem(item);
          ul.hidden = true;
        });
        ul.appendChild(li);
      }
      const current = ul.querySelector('li[aria-selected="true"]');
      if (current) current.scrollIntoView({ block: 'nearest' });
    }

    function pickAssentamentoItem(item) {
      const input = document.getElementById('selectAssentamento');
      if (input) {
        input.value = item.label;
        input.dataset.index = String(item.i);
      }
      const flew = flyToIncraAssentamentoIndex(Number(item.i), map);
      applyAssentamentoSelect(String(item.i), { fit: !flew }).catch((e) => console.warn('assentamento:', e));
    }

    function positionAssentamentoDropdown(ul, input) {
      if (ul.parentElement !== document.body) document.body.appendChild(ul);
      const rect = input.getBoundingClientRect();
      const gap = 4;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const openDown = spaceBelow >= 140 || spaceBelow >= spaceAbove;
      const maxH = Math.max(140, Math.min(280, openDown ? spaceBelow : spaceAbove));
      ul.style.position = 'fixed';
      ul.style.left = `${Math.round(rect.left)}px`;
      ul.style.width = `${Math.round(rect.width)}px`;
      ul.style.right = 'auto';
      ul.style.zIndex = '4000';
      ul.style.maxHeight = `${maxH}px`;
      if (openDown) {
        ul.style.top = `${Math.round(rect.bottom + gap)}px`;
        ul.style.bottom = 'auto';
      } else {
        ul.style.top = 'auto';
        ul.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      }
    }

    function openAssentamentoDropdown({ filter = false } = {}) {
      const ul = document.getElementById('assentamentosDropdown');
      const input = document.getElementById('selectAssentamento');
      if (!ul || !input) return;
      const q = foldFilterText(input.value);
      const selected = _assentamentoComboboxItems.find((x) => String(x.i) === (input.dataset.index || ''));
      const isSelectedLabel = selected && foldFilterText(selected.label) === q;
      const filtered = filter && q && !isSelectedLabel
        ? _assentamentoComboboxItems.filter((x) => x.search.includes(q))
        : _assentamentoComboboxItems;
      renderAssentamentoDropdown(filtered);
      ul.hidden = false;
      positionAssentamentoDropdown(ul, input);
    }

    function setupAssentamentoCombobox() {
      const input = document.getElementById('selectAssentamento');
      const toggleBtn = document.getElementById('btnAssentamentoToggle');
      const ul = document.getElementById('assentamentosDropdown');
      if (!input || !ul) return;

      input.addEventListener('focus', () => openAssentamentoDropdown({ filter: false }));
      input.addEventListener('click', () => openAssentamentoDropdown({ filter: false }));
      input.addEventListener('input', () => {
        if (!input.value.trim()) {
          input.dataset.index = '';
          applyAssentamentoSelect('', { fit: false });
        }
        openAssentamentoDropdown({ filter: true });
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          ul.hidden = true;
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = ul.querySelector('li[data-index]');
          if (!first) return;
          const item = _assentamentoComboboxItems.find((x) => String(x.i) === first.dataset.index);
          if (item) pickAssentamentoItem(item);
          ul.hidden = true;
        }
      });
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.preventDefault();
          if (ul.hidden) {
            input.focus();
            openAssentamentoDropdown({ filter: false });
          } else {
            ul.hidden = true;
          }
        });
      }
      input.addEventListener('blur', () => {
        setTimeout(() => {
          ul.hidden = true;
          const idx = input.dataset.index;
          if (idx) {
            const item = _assentamentoComboboxItems.find((x) => String(x.i) === idx);
            if (item) input.value = item.label;
          } else {
            input.value = '';
          }
        }, 150);
      });

      const closeAssentList = () => { ul.hidden = true; };
      input.closest('.filter-tab-content')?.addEventListener('scroll', closeAssentList, { passive: true });
      window.addEventListener('resize', closeAssentList);
    }

    function alertsForCurrentIncraFilter(alerts) {
      const feat = getSelectedIncraAssentamentoFeature();
      if (!feat) return alerts || [];
      return (alerts || []).filter((a) => alertBelongsToFeature(a, feat));
    }

    function redrawAlertsForIncraFilter() {
      const source = currentAlertsNaFaixaPlanejamento.length
        ? currentAlertsNaFaixaPlanejamento
        : currentAlertsFlat;
      if (!map || !source?.length) return;
      const filtered = alertsForCurrentIncraFilter(source);
      addAlertsToMap(
        { collection: filtered, metadata: { totalCount: filtered.length } },
        null,
        false,
        currentAlertsByPolygon,
        currentAllFeatures,
        { fullGeometry: false, faixaPanel: true, requireShapeSelection: false, fitMap: false },
      );
    }

    let _assentamentoRedrawTimer = null;

    async function applyAssentamentoSelect(value, { fit = true } = {}) {
      const v = value == null ? '' : String(value);
      const idx = Number(v);
      const hasOne = v !== '' && v !== 'all' && v !== 'none' && Number.isInteger(idx) && idx >= 0;
      if (fit && hasOne) flyToIncraAssentamentoIndex(idx, map);
      if (hasOne) {
        const chk = document.getElementById('chkIncraAssentamentos');
        if (chk) chk.checked = true;
      }
      if (!isIncraAssentamentosLayerReady()) {
        await ensureIncraAssentamentosFromFile(map);
      }
      if (hasOne) setRemoteLayerVisible('local:assentamentos', true, { skipPrepare: true });
      applyIncraAssentamentoFilter(hasOne ? v : '', { map, fitMap: false });
      if (_assentamentoRedrawTimer) clearTimeout(_assentamentoRedrawTimer);
      _assentamentoRedrawTimer = setTimeout(() => {
        redrawAlertsForIncraFilter();
        applyRegistrosFilter();
      }, 1600);
    }

    function updateShapesScanList(features) {
      populateAssentamentoSelect();
    }

    function selectSingleShape(idx) {
      const input = document.getElementById('selectAssentamento');
      const item = _assentamentoComboboxItems.find((x) => String(x.i) === String(idx));
      if (input) {
        input.value = item?.label || '';
        input.dataset.index = item ? String(item.i) : '';
      }
      applyAssentamentoSelect(String(idx), { fit: true }).catch((e) => console.warn('assentamento:', e));
    }

    function clearMunicipioFromMap() {
      const features = assentamentosGeoJSON?.features || [];
      selectedShapeIndices.clear();
      for (let i = 0; i < features.length; i++) {
        selectedShapeIndices.add(i);
        toggleShapeVisibility(i, true);
      }
      const chk = document.getElementById('chkShape');
      if (chk) chk.checked = false;
      toggleShapeLayer(false);
    }

    function resetMapViewToDefault() {
      if (!map) return;
      try { map.closePopup(); } catch (_) {}
      removeFaixaSearchLayerFromMap();
      clearMunicipioFromMap();
      if (faixaPlanejamentoGeoJSON?.features?.length) {
        fitMapToFaixaBounds();
        return;
      }
      try { map.setView(CENTER_FAIXA_TABOA, ZOOM_FAIXA_TABOA); } catch (_) {}
    }

    function syncLayerCheckboxesToDefault() {
      const shape = document.getElementById('chkShape');
      if (shape) shape.checked = false;
      const alerts = document.getElementById('chkMapBiomas');
      if (alerts) alerts.checked = true;
      document.querySelectorAll('#remoteWmsLayersWrap .remote-wms-legend input[type="checkbox"]').forEach((inp) => {
        if (inp.id === 'chkShape' || inp.id === 'chkMapBiomas') return;
        inp.checked = false;
      });
    }

    function resetAppToDefaults() {
      resetPeriodFilter();
      try { refreshFilterMunicipiosCombobox(); } catch (_) {}
      const munEl = document.getElementById('filterMunicipio');
      if (munEl) munEl.value = '';
      document.querySelectorAll('.filter-combobox-list').forEach((ul) => { ul.hidden = true; });

      const selAssent = document.getElementById('selectAssentamento');
      if (selAssent) {
        selAssent.value = '';
        selAssent.dataset.index = '';
      }

      const f = assentamentosGeoJSON?.features || [];
      selectedShapeIndices.clear();
      for (let i = 0; i < f.length; i++) selectedShapeIndices.add(i);

      try { resetRemoteLayersToDefault(); } catch (_) {}
      try {
        if (!restoreIncraAssentamentosFaixa()) {
          refreshIncraAssentamentosForCurrentAoi().catch((e) => console.warn('reset assentamentos:', e));
        }
      } catch (_) {}
      if (selAssent) {
        selAssent.value = '';
        selAssent.dataset.index = '';
      }

      syncLayerCheckboxesToDefault();
      toggleShapeLayer(false);
      toggleMapBiomasLayer(true);
      resetMapViewToDefault();
      setStatus('Filtros e mapa restaurados ao padrão.');

      requestAnimationFrame(() => {
        try { redrawAlertsForIncraFilter(); } catch (e) { console.warn('reset alertas:', e); }
        try { applyRegistrosFilter(); } catch (e) { console.warn('reset registros:', e); }
      });
    }

    function toggleShapeVisibility(idx, visible) {
      const layer = featureLayersByIndex.get(idx);
      if (!layer || !assentamentosLayer) return;
      if (layer.setStyle) {
        if (visible) {
          layer.setStyle(ASSENTAMENTOS_STYLE);
          if (layer._path) layer._path.style.pointerEvents = '';
        } else {
          if (layer.closePopup) layer.closePopup();
          layer.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
          if (layer._path) layer._path.style.pointerEvents = 'none';
        }
      }
    }

    function toggleShapeLayer(visible) {
      if (!map || !assentamentosLayer) return;
      if (visible) map.addLayer(assentamentosLayer); else map.removeLayer(assentamentosLayer);
    }

    function toggleMapBiomasLayer(visible) {
      if (!map || !alertsLayer) return;
      if (visible) map.addLayer(alertsLayer); else map.removeLayer(alertsLayer);
    }

    function applyLayerToggleColors(labelEl, style) {
      const fill = style?.fillColor || style?.color || '#94a3b8';
      const stroke = style?.color || fill;
      labelEl.style.setProperty('--layer-fill', fill);
      labelEl.style.setProperty('--layer-stroke', stroke);
    }

    function buildLayerToggleLabel(cfg) {
      const labelWrap = document.createElement('span');
      labelWrap.className = 'layer-toggle-label-wrap';
      const swatch = document.createElement('span');
      swatch.className = 'layer-toggle-swatch';
      swatch.setAttribute('aria-hidden', 'true');
      swatch.title = `Cor no mapa: ${cfg.label}`;
      const spanLabel = document.createElement('span');
      spanLabel.className = 'layer-toggle-label';
      spanLabel.textContent = cfg.label;
      labelWrap.appendChild(swatch);
      labelWrap.appendChild(spanLabel);
      return labelWrap;
    }

    function clearAlerts() {
      if (alertsLayer && map) { map.removeLayer(alertsLayer); alertsLayer = null; }
      alertLayersByCode.clear();
      updateAlertsPanelByPolygon({}, []);
    }

    /** Foca o alerta no mapa: centraliza, dá zoom e abre o popup sobre o alerta. */
    function focusAlertOnMap(alertCode) {
      const layer = alertLayersByCode.get(alertCode);
      if (!map || !layer) return;
      const b = layer.getBounds ? layer.getBounds() : null;
      if (!b) return;
      map.closePopup();
      const center = b.getCenter();
      map.fitBounds(b, { padding: [80, 80], maxZoom: 16, animate: true });
      const openPopup = (l) => { if (l && l.openPopup) l.openPopup(center); };
      map.once('moveend', () => {
        if (layer.openPopup) openPopup(layer);
        else openPopup(layer.getLayers ? layer.getLayers()[0] : null);
      });
    }

    /** Alertas atribuídos ao polígono `idx` (chave numérica ou string após JSON/API). */
    function alertsArrayForFeatureIndex(alertsByPolygon, idx) {
      if (!alertsByPolygon || idx == null) return [];
      const n = Number(idx);
      if (Number.isNaN(n)) return [];
      const a = alertsByPolygon[n];
      if (Array.isArray(a)) return a;
      const b = alertsByPolygon[String(n)];
      return Array.isArray(b) ? b : [];
    }

    function updatePolygonPopups() {
      if (!assentamentosLayer) return;
      const allFeatures = currentAllFeatures?.length
        ? currentAllFeatures
        : (assentamentosGeoJSON?.features || []);
      assentamentosLayer.eachLayer((layer) => {
        const i = layer._featureIndex;
        if (i == null) return;
        const f = allFeatures[i];
        const html = buildMunicipiosPopupHtml(f?.properties || {}, escConsultaHtml);
        if (layer.getPopup()) layer.setPopupContent(html);
        else layer.bindPopup(html, { maxWidth: 380 });
      });
    }

    function refreshAlertsPanel() {
      updateAlertsPanelByPolygon(currentAlertsByPolygon, currentAllFeatures);
    }

    function updateAlertsPanelByPolygon(alertsByPolygon, allFeatures) {
      const abp = alertsByPolygon || {};
      currentAlertsByPolygon = abp;
      currentAllFeatures = allFeatures || [];
      const header = document.getElementById('alertsCount');
      const tabPolygon = document.getElementById('alertsTabPolygon');
      if (!header || !tabPolygon) return;
      const selectedSorted = [...selectedShapeIndices].sort((a, b) => a - b);
      /** Com dados de varredura (`abp` não vazio), listar todos os assentamentos selecionados, mesmo com 0 alertas ou chave em falta no objeto. */
      let entries = Object.keys(abp).length === 0
        ? []
        : selectedSorted.map((idx) => [String(idx), alertsArrayForFeatureIndex(abp, idx)]);
      const totalAlerts = entries.reduce((s, [, arr]) => s + arr.length, 0);
      header.textContent = totalAlerts;
      const seen = new Set();
      currentAlertsFlat = [];
      for (const [, arr] of entries) {
        for (const a of arr) {
          if (!seen.has(a.alertCode)) { seen.add(a.alertCode); currentAlertsFlat.push(a); }
        }
      }
      currentAlertsFlat.sort((a, b) => (b.detectedAt || '').localeCompare(a.detectedAt || ''));
      currentDetailIndex = 0;
      tabPolygon.innerHTML = '';
      if (entries.length === 0) {
        const div = document.createElement('div');
        div.className = 'alerts-panel-empty';
        div.textContent = Object.keys(abp).length > 0
          ? 'Marque ao menos um shape para ver os alertas.'
          : 'Carregue os dados para visualizar os alertas.';
        tabPolygon.appendChild(div);
        updateAlertsDetailContent();
        updatePolygonPopups();
        return;
      }
      for (const [idxStr, alerts] of entries) {
        const idx = parseInt(idxStr, 10);
        const f = allFeatures[idx];
        const nome = featureNomePublico(f, idx);
        const mun = f?.properties?.municipio || f?.properties?.nomMun;
        const munDisp = mun ? ` (${mun})` : '';
        const section = document.createElement('div');
        section.className = 'alerts-polygon-section';
        const byYear = {};
        for (const a of alerts) {
          const yr = a.detectedAt ? String(a.detectedAt).slice(0, 4) : '?';
          byYear[yr] = (byYear[yr] || 0) + 1;
        }
        const yearLine = Object.entries(byYear).sort((x, y) => y[0].localeCompare(x[0])).map(([y, n]) => `${y}:${n}`).join(' ');
        const sortedAlerts = [...alerts].sort((a, b) => (b.detectedAt || '').localeCompare(a.detectedAt || ''));
        section.innerHTML = `
          <div class="alerts-polygon-header">${nome}${munDisp}</div>
          <div class="alerts-polygon-summary">${alerts.length} alerta(s)${yearLine ? ' · ' + yearLine : ''}</div>
        `;
        for (const a of sortedAlerts) {
          const div = document.createElement('div');
          div.className = 'alerts-panel-item';
          div.dataset.alertCode = a.alertCode;
          div.innerHTML = buildAlertPanelItemHtml(a);
          div.addEventListener('click', () => focusAlertOnMap(a.alertCode));
          section.appendChild(div);
        }
        tabPolygon.appendChild(section);
      }
      updateAlertsDetailContent();
      updatePolygonPopups();
      updateAnalyticPanel();
    }

    function updateAnalyticPanel() {
      const body = document.getElementById('analyticsPanelBody');
      const countEl = document.getElementById('analyticsAlertsCount');
      if (!body) return;

      const alerts = currentAlertsFlat;
      const abp = currentAlertsByPolygon;
      const allFeatures = currentAllFeatures;
      const selectedSorted = [...selectedShapeIndices].sort((a, b) => a - b);

      if (countEl) countEl.textContent = alerts.length || '—';

      if (alerts.length === 0) {
        body.innerHTML = '<div class="analytic-empty">Carregue os dados para visualizar o painel analítico.</div>';
        return;
      }

      // â”€â”€ Agrega dados por shape (usa área recortada) â”€â”€â”€â”€â”€â”€â”€
      // Área e gráficos usam alertsByPolygon por shape para somar apenas a
      // porção de cada alerta que cai dentro daquele shape (_clippedAreaHa).
      // Contagem de alertas usa currentAlertsFlat (deduplicado por alertCode).
      if (isFaixaAlertsMode(alerts)) {
        body.innerHTML = renderFaixaAnalyticsHtml(buildFaixaAnalytics(alerts));
        return;
      }

      let areaTotal = 0;
      const byYear = {};       // year → { count, area }
      const byYearMonth = {};  // `${year}-${month}` → area
      const seenForCount = new Set();
      for (const idx of selectedSorted) {
        for (const a of alertsArrayForFeatureIndex(abp, idx)) {
          const ha = Number(a._clippedAreaHa ?? a.areaHa) || 0;
          areaTotal += ha;
          const dt = a.detectedAt || '';
          if (dt) {
            const yr = dt.slice(0, 4);
            const mo = dt.slice(5, 7);
            if (!byYear[yr]) byYear[yr] = { count: 0, area: 0 };
            byYear[yr].area += ha;
            const ym = `${yr}-${mo}`;
            byYearMonth[ym] = (byYearMonth[ym] || 0) + ha;
            // count deduplica por alertCode
            if (!seenForCount.has(a.alertCode)) {
              seenForCount.add(a.alertCode);
              byYear[yr].count += 1;
            }
          }
        }
      }
      const years = Object.keys(byYear).sort();

      // Média diária global
      let mediaDiaria = 0;
      const sortedDates = alerts.map((a) => a.detectedAt).filter(Boolean).sort();
      if (sortedDates.length > 1) {
        const days = Math.max(1, Math.ceil((new Date(sortedDates[sortedDates.length - 1]) - new Date(sortedDates[0])) / 86400000));
        mediaDiaria = areaTotal / days;
      }

      // ── Maior Desmatamento e Maior Velocidade por shape ──
      let maiorDesmatShape = null, maiorDesmatHa = 0;
      let maiorVelShape = null, maiorVelHaDia = 0;
      for (const idx of selectedSorted) {
        const f = allFeatures[idx];
        const nome = featureNomePublico(f, idx);
        const mun = f?.properties?.municipio || f?.properties?.nomMun || '';
        const label = nome + (mun ? `, ${mun}` : '');
        const shapeAlerts = alertsArrayForFeatureIndex(abp, idx);
        if (!shapeAlerts.length) continue;
        const shapeArea = shapeAlerts.reduce((s, a) => s + (Number(a._clippedAreaHa ?? a.areaHa) || 0), 0);
        if (shapeArea > maiorDesmatHa) { maiorDesmatHa = shapeArea; maiorDesmatShape = label; }
        const sd = shapeAlerts.map((a) => a.detectedAt).filter(Boolean).sort();
        let vel = shapeArea;
        if (sd.length > 1) {
          const d = Math.max(1, Math.ceil((new Date(sd[sd.length - 1]) - new Date(sd[0])) / 86400000));
          vel = shapeArea / d;
        }
        if (vel > maiorVelHaDia) { maiorVelHaDia = vel; maiorVelShape = label; }
      }

      // â”€â”€ Gráfico: Evolução do total de alertas (anual) â”€â”€â”€â”€
      const maxYearCount = years.length ? Math.max(...years.map((y) => byYear[y].count)) : 1;
      function fmtK(n) { return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n); }
      const yGridPcts = [0, 25, 50, 75, 100];
      const yGridLines = yGridPcts.map((p) =>
        `<div class="ap-ygrid-line" style="bottom:${p}%"><span>${fmtK(Math.round(maxYearCount * p / 100))}</span></div>`
      ).join('');
      const yearCols = years.map((y) => {
        const pct = maxYearCount > 0 ? (byYear[y].count / maxYearCount) * 100 : 0;
        return `<div class="ap-ycol">
          <div class="ap-ycol-bar-wrap">
            <div class="ap-ycol-bar" style="height:${Math.max(3, pct)}%" title="${y}: ${byYear[y].count} alertas"></div>
          </div>
          <div class="ap-ycol-lbl">${y}</div>
        </div>`;
      }).join('');

      // â”€â”€ Gráfico: Evolução mensal agrupada por ano â”€â”€â”€â”€â”€â”€â”€â”€
      const YEAR_COLORS = ['#ef4444','#3b82f6','#06b6d4','#f97316','#22d3ee','#22c55e','#eab308','#a855f7'];
      const MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'];
      const maxMonthly = Math.max(1, ...MONTHS.flatMap((mo) => years.map((y) => byYearMonth[`${y}-${mo}`] || 0)));
      const monthGroups = MONTHS.map((mo, mi) => {
        const bars = years.map((y, yi) => {
          const v = byYearMonth[`${y}-${mo}`] || 0;
          const pct = (v / maxMonthly) * 100;
          return `<div class="ap-mbar" style="height:${Math.max(2, pct)}%;background:${YEAR_COLORS[yi % YEAR_COLORS.length]}" title="${y}/${mo}: ${v.toFixed(0)} ha"></div>`;
        }).join('');
        return `<div class="ap-mgroup">
          <div class="ap-mgroup-bars">${bars}</div>
          <div class="ap-mgroup-lbl">${String(mi + 1).padStart(2, '0')}</div>
        </div>`;
      }).join('');
      function fmtHa(n) {
        if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
        return n.toFixed(0);
      }
      const yGridMonthly = yGridPcts.map((p) =>
        `<div class="ap-ygrid-line" style="bottom:${p}%"><span>${fmtHa(maxMonthly * p / 100)}</span></div>`
      ).join('');
      const legend = years.map((y, i) =>
        `<span class="ap-legend-item"><span class="ap-legend-dot" style="background:${YEAR_COLORS[i % YEAR_COLORS.length]}"></span>${y}</span>`
      ).join('');

      // ── Por shape ────────────────────────────────────────
      const shapeRows = selectedSorted.map((idx) => {
        const f = allFeatures[idx];
        const nome = featureNomePublico(f, idx);
        const mun = f?.properties?.municipio || f?.properties?.nomMun || '';
        const shapeAlerts = alertsArrayForFeatureIndex(abp, idx);
        if (!shapeAlerts.length) return '';
        const shapeArea = shapeAlerts.reduce((s, a) => s + (Number(a._clippedAreaHa ?? a.areaHa) || 0), 0);
        const byYS = {};
        for (const a of shapeAlerts) {
          const yr = a.detectedAt ? a.detectedAt.slice(0, 4) : '?';
          byYS[yr] = (byYS[yr] || 0) + 1;
        }
        const yrLine = Object.entries(byYS).sort((x, y) => y[0].localeCompare(x[0])).map(([y, n]) => `${y.slice(2)}:${n}`).join(' ');
        return `<div class="ap-shape-row">
          <div class="ap-shape-name">${nome}${mun ? `<span class="ap-shape-mun"> · ${mun}</span>` : ''}</div>
          <div class="ap-shape-stats">
            <span class="ap-shape-pill">${shapeAlerts.length} alertas</span>
            <span class="ap-shape-pill">${shapeArea.toFixed(1)} ha</span>
          </div>
          ${yrLine ? `<div class="ap-shape-years">${yrLine}</div>` : ''}
        </div>`;
      }).filter(Boolean).join('');

      // ── Renderiza ─────────────────────────────────────────
      body.innerHTML = `
        <div class="ap-metrics">
          <div class="ap-metric">
            <div class="ap-metric-val">${alerts.length.toLocaleString('pt-BR')}</div>
            <div class="ap-metric-lbl">alertas</div>
          </div>
          <div class="ap-metric">
            <div class="ap-metric-val">${areaTotal.toFixed(1).replace('.', ',')}</div>
            <div class="ap-metric-lbl">hectares</div>
          </div>
          <div class="ap-metric">
            <div class="ap-metric-val">${mediaDiaria.toFixed(1).replace('.', ',')}</div>
            <div class="ap-metric-lbl">ha/dia</div>
          </div>
        </div>

        ${years.length > 0 ? `
        <div class="ap-section">
          <div class="ap-section-title">Evolução do total de alertas</div>
          <div class="ap-year-chart">
            <div class="ap-ygrid">${yGridLines}</div>
            <div class="ap-ycols">${yearCols}</div>
          </div>
          ${(maiorDesmatShape || maiorVelShape) ? `
          <div class="ap-highlights">
            ${maiorDesmatShape ? `
            <div class="ap-highlight">
              <div class="ap-highlight-title">Maior Desmatamento</div>
              <div class="ap-highlight-val">${maiorDesmatHa.toFixed(1).replace('.', ',')}<span> ha</span></div>
              <div class="ap-highlight-sub">${maiorDesmatShape}</div>
            </div>` : ''}
            ${maiorVelShape ? `
            <div class="ap-highlight">
              <div class="ap-highlight-title">Maior Velocidade</div>
              <div class="ap-highlight-val">${maiorVelHaDia.toFixed(1).replace('.', ',')}<span> ha/dia</span></div>
              <div class="ap-highlight-sub">${maiorVelShape}</div>
            </div>` : ''}
          </div>` : ''}
        </div>

        <div class="ap-section">
          <div class="ap-section-title">Evolução mensal da área de desmatamento</div>
          <div class="ap-year-chart">
            <div class="ap-ygrid">${yGridMonthly}</div>
            <div class="ap-monthly-chart">${monthGroups}</div>
          </div>
          <div class="ap-legend">${legend}</div>
        </div>
        ` : ''}

        ${shapeRows ? `
        <div class="ap-section">
          <div class="ap-section-title">Por shape selecionado</div>
          <div class="ap-shape-list">${shapeRows}</div>
        </div>` : ''}
      `;
    }

    function updateAlertsDetailContent() {
      const card = document.getElementById('alertsDetailCard');
      const counter = document.getElementById('alertsDetailCounter');
      const btnPrev = document.getElementById('btnAlertPrev');
      const btnNext = document.getElementById('btnAlertNext');
      if (!card || !counter) return;
      const total = currentAlertsFlat.length;
      if (total === 0) {
        counter.textContent = '— / —';
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        card.innerHTML = '<div class="alerts-panel-empty">Nenhum alerta para exibir.</div>';
        return;
      }
      const idx = Math.max(0, Math.min(currentDetailIndex, total - 1));
      currentDetailIndex = idx;
      const a = currentAlertsFlat[idx];
      const areaValDet = a._clippedAreaHa ?? a.areaHa;
      const area = areaValDet != null ? `${Number(areaValDet).toFixed(2)} ha${a._clippedAreaHa != null ? ' ✂' : ''}` : '—';
      const lat = a.coordenates?.latitude, lng = a.coordenates?.longitude;
      const coords = (lat != null && lng != null) ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : '—';
      const bioma = biomaFromAlert(a);
      const sinaisDet = alertSinaisDetail(a);
      const src = alertSourceLabel(a);
      const detailRows = alertDetailRows(a, { bioma, sinaisDet })
        .filter((r) => r.label !== 'Fonte');
      card.innerHTML = `
        <div class="card-title">Alerta #${a.alertCode} <span class="alerts-source-badge alerts-source-mapbiomas">${escConsultaHtml(src)}</span></div>
        <div class="card-row"><span>Área</span><span>${area}</span></div>
        ${buildDetailRowsHtml(detailRows, escConsultaHtml, 'card-row')}
        <div class="card-row"><span>Coordenadas</span><span>${coords}</span></div>
        <div class="alerts-panel-item-btn" style="margin-top:12px">Clique para centralizar no mapa</div>
      `;
      card.onclick = () => focusAlertOnMap(a.alertCode);
      card.style.cursor = 'pointer';
      counter.textContent = `${idx + 1} / ${total}`;
      if (btnPrev) btnPrev.disabled = idx <= 0;
      if (btnNext) btnNext.disabled = idx >= total - 1;
    }

    function setupFilterTabs() {
      const tabs = document.querySelectorAll('.filter-tabs-bar .alerts-tab');
      const contents = [
        document.getElementById('filterTabFiltro'),
        document.getElementById('filterTabConsulta'),
        document.getElementById('filterTabCamada'),
      ];
      const filtroRow = document.getElementById('filtroActionRow');
      const consultaRow = document.getElementById('consultaActionRow');
      const syncReportRow = (which) => {
        if (filtroRow) filtroRow.hidden = true;
        if (consultaRow) consultaRow.hidden = which !== 'consulta';
      };
      const applyFilterTab = (which) => {
        if (!which) which = 'consulta';
        tabs.forEach((t) => {
          const on = t.dataset.ftab === which;
          t.classList.toggle('active', on);
          t.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        contents.forEach((c) => {
          if (!c) return;
          const show = c.id === `filterTab${which.charAt(0).toUpperCase() + which.slice(1)}`;
          c.classList.toggle('active', show);
          c.hidden = !show;
        });
        syncReportRow(which);
        if (which !== 'consulta') consultaTabApi?.cancelMapMode();
      };
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => applyFilterTab(tab.dataset.ftab));
      });
      const activeTab = document.querySelector('.filter-tabs-bar .alerts-tab.active');
      applyFilterTab(activeTab?.dataset.ftab || 'consulta');
    }

    function escConsultaHtml(s) {
      return String(s ?? '—')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    const consultaScanByCoord = new Map();

    function consultaCoordKey(lat, lng) {
      return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    }

    let consultaRunGeneration = 0;

    function syncConsultaExecutarButton() {
      consultaTabApi?.syncExecutarButton();
    }

    function buildAlertFeaturePairsForCruzamento(alertsFlat) {
      const out = [];
      for (const a of alertsFlat || []) {
        const { geojson } = alertGeometryAndPoint(a);
        if (!geojson) continue;
        try {
          out.push({ alert: a, feat: turf.feature(geojson) });
        } catch (_) {}
      }
      return out;
    }

    function assentamentoShapeIndicesForPoint(lng, lat, allFeatures) {
      const out = [];
      if (!allFeatures?.length) return out;
      let pt;
      try {
        pt = turf.point([lng, lat]);
      } catch (_) {
        return out;
      }
      for (let i = 0; i < allFeatures.length; i++) {
        const f = allFeatures[i];
        if (!f?.geometry) continue;
        try {
          if (turf.booleanPointInPolygon(pt, turf.feature(f.geometry))) out.push(i);
        } catch (_) {}
      }
      return out;
    }

    async function resolveConsultaAoiAtPoint(lng, lat, filterCtx) {
      let remote = [];
      if (API_BASE && filterCtx?.uf) {
        try {
          const pt = turf.point([lng, lat]);
          const searchAoi = turf.buffer(pt, 2.5, { units: 'kilometers' });
          remote = await fetchRemoteCruzamentoCandidates(searchAoi, filterCtx);
        } catch (e) {
          console.warn('WFS consulta ponto:', e);
        }
      }
      const candidates = mergeActiveCruzamentoCandidates(remote);
      return resolvePrioritizedCruzamentoAoi(lng, lat, candidates, REGISTRO_CRUZAMENTO_BUFFER_KM);
    }

    function collectAlertsForCruzamento(alertsFlat, resolved, scanCtx) {
      if (scanCtx) return scanCtx.alerts || [];
      const out = [];
      const seen = new Set();
      for (const a of alertsFlat || []) {
        if (!a?.alertCode || seen.has(a.alertCode)) continue;
        if (!alertBelongsToResolvedAoi(a, resolved)) continue;
        seen.add(a.alertCode);
        out.push(a);
      }
      return out;
    }

    async function cruzarCoordenadaComAlertasFeatures(lat, lng, alertsFlat, shapeFeatsParaCruzamento, allFeaturesIndexed, localidade = null, runGeneration = null) {
      const cancelled = () => runGeneration != null && runGeneration !== consultaRunGeneration;
      let filterCtx;
      if (localidade?.uf) {
        filterCtx = {
          uf: String(localidade.uf).trim().toUpperCase(),
          municipio: localidade.municipio || '',
          ibgeId: localidade.codMunicipioIbge ? Number(localidade.codMunicipioIbge) : null,
          bbox: null,
          label: localidade.municipio
            ? `${localidade.municipio} (${localidade.uf})`
            : localidade.uf,
        };
      } else {
        filterCtx = await resolveFilterBbox();
        if (!filterCtx.uf) {
          filterCtx.uf = (document.getElementById('filterEstado')?.value || 'BA').trim().toUpperCase();
          filterCtx.municipio = '';
        }
      }

      const scanCtx = consultaScanByCoord.get(consultaCoordKey(lat, lng));
      let resolved = scanCtx?.resolved || await resolveConsultaAoiAtPoint(lng, lat, filterCtx);
      if (!resolved.containing?.length && shapeFeatsParaCruzamento?.length) {
        const fallback = resolveRegistroCruzamentoAoi(lng, lat, shapeFeatsParaCruzamento, REGISTRO_CRUZAMENTO_BUFFER_KM);
        if (fallback.mode === 'assentamento') {
          resolved = { ...fallback, mode: 'poligono' };
        }
      }

      let { mode, aoi, labels: assentamentoLabels, aoiMeta } = resolved;
      if (mode === 'assentamento') mode = 'poligono';
      const alertasNoBuffer = [];
      const clipsNoBuffer = [];
      let areaDesmatadaHa = 0;
      const cefirCarFromShape =
        (aoiMeta && aoiMeta.cefirCar) ||
        (resolved.containing?.length ? cefirCarFromContainingFeatures(resolved.containing) : '') ||
        '';
      const imovelReport = collectImoveisAtPointForReport(resolved);
      const cefirCarFinal =
        (cefirCarFromShape && cefirCarFromShape.trim()) ||
        pickCarCodeFromImovelRow(imovelReport.primaryCar) ||
        pickCarCodeFromImovelRow(imovelReport.primaryImovel) ||
        '';
      const allCandidates = mergeActiveCruzamentoCandidates();
      enrichLocalCamadasHa(
        imovelReport.camadasHa,
        resolved.aoi,
        allCandidates,
        resolved.primaryKey || null,
      );
      const { settlementOverlap } = enrichCruzamentoWithSettlementOverlap(
        imovelReport,
        resolved,
        allCandidates,
      );
      const propCandsCar = filterPropertyCandidatesForCar(allCandidates);
      const alertsToProcess = collectAlertsForCruzamento(alertsFlat, resolved, scanCtx);
      for (let ai = 0; ai < alertsToProcess.length; ai++) {
        if (ai > 0 && ai % 35 === 0) {
          if (cancelled()) break;
          await yieldToMain();
        }
        const a = alertsToProcess[ai];
        try {
          const clipResult = resolveAlertClipInShape(a, aoi.geometry);
          if (!clipResult?.areaHa) continue;
          const areaClip = clipResult.areaHa;
          const clipGeom = clipResult.geom;
          areaDesmatadaHa += areaClip;
          let linkedImoveis = [];
          if (clipGeom) {
            try {
              linkedImoveis = linkedImoveisForAlertClip(clipGeom, propCandsCar);
            } catch (_) {}
          }
          alertasNoBuffer.push({
            alertCode: a.alertCode,
            detectedAt: a.detectedAt || '—',
            areaHa: areaClip,
            linkedImoveis,
          });
          if (clipGeom) clipsNoBuffer.push(clipGeom);
        } catch (_) {}
      }
      const assentamentoShapeIndices = resolved.containing?.length
        ? []
        : allFeaturesIndexed?.length
          ? assentamentoShapeIndicesForPoint(lng, lat, allFeaturesIndexed)
          : [];
      return {
        lat,
        lng,
        mode,
        assentamentoLabels,
        aoiMeta,
        assentamentoShapeIndices,
        regionGeoJSON: aoi,
        clipsNoBuffer,
        alertasNoBuffer,
        areaDesmatadaHa,
        afetado: alertasNoBuffer.length > 0,
        cefirCarFromShape: cefirCarFinal,
        imoveisNoPonto: imovelReport.imoveisNoPonto,
        primaryImovel: imovelReport.primaryImovel,
        primaryCar: imovelReport.primaryCar,
        camadasHa: imovelReport.camadasHa,
        settlementOverlap,
        prioritizedHits: resolved.prioritizedHits || [],
        containing: resolved.containing || [],
      };
    }

    function buildAlertPanelItemHtml(a) {
      const areaVal = a._clippedAreaHa ?? a.areaHa;
      const area = areaVal != null ? `${Number(areaVal).toFixed(2)} ha${a._clippedAreaHa != null ? ' ✂' : ''}` : '—';
      const bioma = biomaFromAlert(a);
      const sinaisDet = alertSinaisDetail(a);
      const src = alertSourceLabel(a);
      const srcBadge = `<span class="alerts-source-badge alerts-source-mapbiomas">${escConsultaHtml(src)}</span>`;
      const detailRows = alertDetailRows(a, { bioma, sinaisDet });
      const extraRows = detailRows
        .filter((r) => !['Fonte', 'Bioma', 'Sinal'].includes(r.label))
        .slice(0, 4)
        .map((r) => `<div class="alerts-panel-item-row"><span>${escConsultaHtml(r.label)}</span><span>${escConsultaHtml(r.value)}</span></div>`)
        .join('');
      const muns = (a._munNomesInFaixa || []).join(', ');
      const munRow = muns
        ? `<div class="alerts-panel-item-row"><span>Município(s)</span><span>${escConsultaHtml(muns)}</span></div>`
        : '';
      const lat = a.coordenates?.latitude;
      const lng = a.coordenates?.longitude;
      const coords = (lat != null && lng != null) ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : '';
      const coordsRow = coords
        ? `<div class="alerts-panel-item-row"><span>Coordenadas</span><span>${coords}</span></div>`
        : '';
      return `
        <div class="alerts-panel-item-title">Alerta #${a.alertCode} ${srcBadge}</div>
        <div class="alerts-panel-item-row"><span>Área</span><span>${area}</span></div>
        ${bioma !== '—' ? `<div class="alerts-panel-item-row"><span>Bioma</span><span>${escConsultaHtml(bioma)}</span></div>` : ''}
        ${sinaisDet ? `<div class="alerts-panel-item-row"><span>Sinal</span><span>${escConsultaHtml(sinaisDet)}</span></div>` : ''}
        ${extraRows}
        ${munRow}
        <div class="alerts-panel-item-row"><span>Detectado</span><span>${a.detectedAt || '—'}</span></div>
        ${a.publishedAt ? `<div class="alerts-panel-item-row"><span>Publicado</span><span>${a.publishedAt}</span></div>` : ''}
        ${coordsRow}
        <div class="alerts-panel-item-btn">Clique para centralizar no mapa</div>`;
    }

    function setupConsultaCadastro() {
      consultaTabApi = setupConsultaTab({
        getMap: () => map,
        getAlerts: () => currentAlertsFlat,
        isScanInFlight: () => !!loadAlertsInFlight,
        setStatus,
        showLoading,
        updateLoading,
        hideLoading,
        fetchMunicipio: (lat, lng) => fetchMunicipioPorCoordenada(lat, lng),
        resetMapView: () => resetMapViewToDefault(),
        clearSelectorMap: () => {
          if (!map) return;
          try { map.closePopup(); } catch (_) {}
          removeFaixaSearchLayerFromMap();
          clearMunicipioFromMap();
        },
        onImovelSelected: (feat) => {
          const car = String(feat?.properties?.NUMERO_CAR || '').trim();
          setImoveisRuraisCarFilter(car || '', { enable: !!car });
        },
        onImovelCleared: () => {
          setImoveisRuraisCarFilter('', { enable: false });
        },
      });
    }

    function setupAlertsTabs() {
      const tabs = document.querySelectorAll('#alertsPanelTabs .alerts-tab[data-tab]');
      const contents = document.querySelectorAll('#alertsPanelBody .alerts-tab-content');
      const btnPrev = document.getElementById('btnAlertPrev');
      const btnNext = document.getElementById('btnAlertNext');
      tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const which = tab.dataset.tab;
          tabs.forEach(t => { t.classList.toggle('active', t.dataset.tab === which); t.setAttribute('aria-pressed', t.dataset.tab === which); });
          contents.forEach(c => {
            const isPolygon = c.id === 'alertsTabPolygon';
            const show = (which === 'polygon' && isPolygon) || (which === 'detail' && c.id === 'alertsTabDetail');
            c.classList.toggle('active', show);
            c.hidden = !show;
          });
        });
      });
      if (btnPrev) btnPrev.addEventListener('click', () => { currentDetailIndex = Math.max(0, currentDetailIndex - 1); updateAlertsDetailContent(); });
      if (btnNext) btnNext.addEventListener('click', () => { currentDetailIndex = Math.min(currentAlertsFlat.length - 1, currentDetailIndex + 1); updateAlertsDetailContent(); });
    }

    /**
     * Recebe a lista raw de alertas para o mapa e o mapa alertsByPolygon (sem
     * geometrias recortadas), calcula _clippedGeom e _clippedAreaHa no cliente
     * e retorna { listForMap, alertsByPolygonClipped } prontos para renderização.
     */
    function _buildClippedPayload(rawListForMap, rawAlertsByPolygon, featuresArr) {
      const abpRaw = rawAlertsByPolygon || {};
      const alertsByPolygonClipped = {};
      const clippedByCode = new Map();

      for (const [idxStr, rawAlerts] of Object.entries(abpRaw)) {
        const oi = parseInt(idxStr, 10);
        const shapeGeom = featuresArr[oi]?.geometry ?? null;
        alertsByPolygonClipped[idxStr] = (rawAlerts || []).map((a) => {
          const r = computeClippedResult(a, shapeGeom);
          if (r != null) {
            const ca = { ...a, _clippedAreaHa: r.areaHa, _clippedGeom: r.geom };
            if (!clippedByCode.has(a.alertCode)) clippedByCode.set(a.alertCode, []);
            clippedByCode.get(a.alertCode).push(ca);
            return ca;
          }
          return a;
        });
      }

      const seen = new Set();
      const listForMap = [];
      for (const raw of (rawListForMap || [])) {
        if (seen.has(raw.alertCode)) continue;
        seen.add(raw.alertCode);
        const clips = clippedByCode.get(raw.alertCode);
        if (!clips || clips.length === 0) {
          listForMap.push(raw);
        } else if (clips.length === 1) {
          listForMap.push(clips[0]);
        } else {
          let unionGeom = clips[0]._clippedGeom;
          let totalArea = clips[0]._clippedAreaHa || 0;
          for (let ci = 1; ci < clips.length; ci++) {
            try {
              const u = turf.union(turf.feature(unionGeom), turf.feature(clips[ci]._clippedGeom));
              if (u) unionGeom = u.geometry;
            } catch (_) {}
            totalArea += clips[ci]._clippedAreaHa || 0;
          }
          listForMap.push({ ...raw, _clippedGeom: unionGeom, _clippedAreaHa: totalArea });
        }
      }

      return { listForMap, alertsByPolygonClipped };
    }

    function updateAlertsPanelByFaixa(faixaAlerts, alertsByPolygon, allFeatures) {
      currentAlertsByPolygon = alertsByPolygon || {};
      currentAllFeatures = allFeatures || [];
      const header = document.getElementById('alertsCount');
      const tabPolygon = document.getElementById('alertsTabPolygon');
      if (!header || !tabPolygon) return;

      const sorted = [...(faixaAlerts || [])].sort((a, b) => (b.detectedAt || '').localeCompare(a.detectedAt || ''));
      currentAlertsFlat = sorted;
      currentDetailIndex = 0;
      header.textContent = sorted.length;

      const groups = [
        { key: 'litoral_sul', title: '05 – Litoral Sul' },
        { key: 'baixo_sul', title: '06 – Baixo Sul' },
        { key: 'extremo_sul', title: '07 – Extremo Sul' },
        { key: 'divisa', title: 'Divisa entre regiões' },
      ];

      tabPolygon.innerHTML = '';
      if (!sorted.length) {
        const div = document.createElement('div');
        div.className = 'alerts-panel-empty';
        div.textContent = 'Nenhum alerta MapBiomas na faixa neste período.';
        tabPolygon.appendChild(div);
        updateAlertsDetailContent();
        updateAnalyticPanel();
        return;
      }

      for (const g of groups) {
        const list = sorted.filter((a) => (a._regiaoTaboa || '') === g.key);
        if (!list.length) continue;
        const section = document.createElement('div');
        section.className = 'alerts-polygon-section';
        section.innerHTML = `<div class="alerts-polygon-header">${g.title}</div><div class="alerts-polygon-summary">${list.length} alerta(s) na região</div>`;
        for (const a of list) {
          const div = document.createElement('div');
          div.className = 'alerts-panel-item';
          div.dataset.alertCode = a.alertCode;
          div.innerHTML = buildAlertPanelItemHtml(a);
          div.addEventListener('click', () => focusAlertOnMap(a.alertCode));
          section.appendChild(div);
        }
        tabPolygon.appendChild(section);
      }

      const semReg = sorted.filter((a) => !a._regiaoTaboa || !groups.some((g) => g.key === a._regiaoTaboa));
      if (semReg.length) {
        const section = document.createElement('div');
        section.className = 'alerts-polygon-section';
        section.innerHTML = `<div class="alerts-polygon-header">Sem região</div><div class="alerts-polygon-summary">${semReg.length} alerta(s)</div>`;
        for (const a of semReg) {
          const div = document.createElement('div');
          div.className = 'alerts-panel-item';
          div.dataset.alertCode = a.alertCode;
          div.innerHTML = buildAlertPanelItemHtml(a);
          div.addEventListener('click', () => focusAlertOnMap(a.alertCode));
          section.appendChild(div);
        }
        tabPolygon.appendChild(section);
      }

      updateAlertsDetailContent();
      updateAnalyticPanel();
    }

    function addAlertsToMap(alerts, assentamentosFeatures, filterByIntersection, alertsByPolygon, allFeaturesForPanel, opts = {}) {
      const requireShapeSelection = opts.requireShapeSelection !== false;
      const fullGeometry = !!opts.fullGeometry;
      const faixaPanel = !!opts.faixaPanel;
      const lightMarkers = !!opts.lightMarkers;
      if (!map) return 0;
      clearAlerts();

      const nFeat = allFeaturesForPanel?.length ?? 0;

      if (requireShapeSelection && !faixaPanel && selectedShapeIndices.size === 0) {
        alertsLayer = L.featureGroup();
        if (faixaPanel && alerts.collection?.length) {
          updateAlertsPanelByFaixa(alerts.collection, alertsByPolygon, allFeaturesForPanel);
        } else if (alertsByPolygon && allFeaturesForPanel) {
          updateAlertsPanelByPolygon(alertsByPolygon, allFeaturesForPanel);
        }
        return 0;
      }

      let activeShapeFilter = null;
      // Em modo faixaPanel todos os alertas da coleção já foram filtrados pelo backend/client;
      // não aplicar filtro por selectedShapeIndices (que fica vazio após varredura de faixa).
      if (!fullGeometry && !faixaPanel && nFeat > 0 && selectedShapeIndices.size < nFeat) {
        activeShapeFilter = selectedShapeIndices;
      }

      let allowedAlertCodes = null;
      if (!fullGeometry && activeShapeFilter && alertsByPolygon) {
        allowedAlertCodes = new Set();
        for (const idx of activeShapeFilter) {
          for (const a of alertsArrayForFeatureIndex(alertsByPolygon, idx)) {
            if (a?.alertCode) allowedAlertCodes.add(a.alertCode);
          }
        }
      }

      const alertShapeGeoms = new Map();
      if (!fullGeometry && alertsByPolygon && allFeaturesForPanel) {
        for (const [idxStr, shapeAlerts] of Object.entries(alertsByPolygon)) {
          const oi = parseInt(idxStr, 10);
          if (activeShapeFilter && !activeShapeFilter.has(oi)) continue;
          const sg = allFeaturesForPanel[oi]?.geometry;
          if (!sg) continue;
          for (const sa of shapeAlerts || []) {
            if (!alertShapeGeoms.has(sa.alertCode)) alertShapeGeoms.set(sa.alertCode, []);
            alertShapeGeoms.get(sa.alertCode).push(sg);
          }
        }
      }

      const group = L.featureGroup();
      const alertRenderer = rendererFor(map, 'alertas');
      let added = 0;
      for (const a of alerts.collection || []) {
        if (allowedAlertCodes && !allowedAlertCodes.has(a.alertCode)) continue;
        let geojson = null;
        if (!lightMarkers) {
          if (a.geometryGeojson) geojson = a.geometryGeojson;
          if (!geojson && a.geometryWkt) geojson = wktToGeoJSON(a.geometryWkt);
          if (!geojson && a.alertGeometry?.simplifiedPoints?.length)
            geojson = simplifiedPointsToPolygon(a.alertGeometry.simplifiedPoints);
        }
        let lat = a.coordenates?.latitude, lng = a.coordenates?.longitude;
        if ((lat == null || lng == null) && geojson) { const c = geomCenter(geojson); if (c) { lat = c[0]; lng = c[1]; } }
        if (lat == null || lng == null) continue;
        const fallbackPoint = [lat, lng];
        if (filterByIntersection && assentamentosFeatures && assentamentosFeatures.length > 0) {
          if (!alertIntersectsAssentamentos(geojson, assentamentosFeatures, fallbackPoint)) continue;
        }

        const style = ALERT_STYLE;
        let layer = null;

        if (lightMarkers) {
          const markerColor = style.color || '#ef4444';
          layer = L.circleMarker([lat, lng], {
            radius: 5,
            fillColor: markerColor,
            color: markerColor,
            weight: 2,
            fillOpacity: 0.85,
            interactive: true,
            renderer: alertRenderer,
          });
        } else {
        let renderGeom = fullGeometry ? null : (a._clippedGeom ?? null);
        if (!renderGeom && geojson) {
          if (!fullGeometry) {
            const shapeGeoms = alertShapeGeoms.get(a.alertCode);
            if (shapeGeoms && shapeGeoms.length > 0) {
              let alertFeat = null;
              try { alertFeat = turf.feature(geojson); } catch (_) {}
              if (alertFeat) {
                for (const sg of shapeGeoms) {
                  try {
                    const clip = turf.intersect(alertFeat, turf.feature(sg));
                    if (!clip) continue;
                    renderGeom = renderGeom
                      ? (turf.union(turf.feature(renderGeom), clip)?.geometry ?? renderGeom)
                      : clip.geometry;
                  } catch (_) {}
                }
              }
            }
          }
        }
        renderGeom = renderGeom ?? geojson;
        if (!layer) {
        if (renderGeom && (renderGeom.coordinates || renderGeom.type === 'MultiPolygon')) {
          try { layer = L.geoJSON(renderGeom, { style, interactive: true, renderer: alertRenderer }); } catch (_) {}
        }
        if (!layer) {
          const markerColor = style.color || '#ef4444';
          layer = L.circleMarker([lat, lng], {
            radius: 6,
            fillColor: markerColor,
            color: markerColor,
            weight: 2,
            fillOpacity: 0.85,
            interactive: true,
            renderer: alertRenderer,
          });
        }
        }
        }
        const assentamentos = getAssentamentoNamesForAlert(geojson, assentamentosFeatures || [], fallbackPoint);
        const areaValPop = fullGeometry ? a.areaHa : (a._clippedAreaHa ?? a.areaHa);
        const area = areaValPop != null ? `${Number(areaValPop).toFixed(2)} ha${!fullGeometry && a._clippedAreaHa != null ? ' ✂' : ''}` : '—';
        const detected = a.detectedAt || '—';
        const published = a.publishedAt || '—';
        const bioma = biomaFromAlert(a);
        const sinaisDet = alertSinaisDetail(a);
        const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        const regiaoLine = a._regiaoTaboa
          ? `<div class="popup-row">Região: ${escConsultaHtml(regiaoPlanejamentoLabel(a._regiaoTaboa))}</div>`
          : '';
        const munLine = (a._munNomesInFaixa || []).length
          ? `<div class="popup-row">Município(s): ${escConsultaHtml((a._munNomesInFaixa || []).join(', '))}</div>`
          : '';
        const srcLine = `<div class="popup-row">Fonte: ${escConsultaHtml(alertSourceLabel(a))}</div>`;
        layer.bindPopup(`
          <div class="popup-title">Alerta #${a.alertCode}</div>
          ${srcLine}
          ${regiaoLine}
          ${munLine}
          <div class="popup-row">Área: ${area}</div>
          ${bioma !== '—' ? `<div class="popup-row">Bioma: ${escConsultaHtml(bioma)}</div>` : ''}
          ${sinaisDet ? `<div class="popup-row">Sinal: ${escConsultaHtml(sinaisDet)}</div>` : ''}
          <div class="popup-row">Detectado: ${detected}</div>
          <div class="popup-row">Publicado: ${published}</div>
          <div class="popup-row">Coordenadas: ${coords}</div>
          ${assentamentos.length ? `<div class="popup-row">Shape(s): ${assentamentos.join('; ')}</div>` : ''}
        `, { maxWidth: 360, autoPan: false });
        group.addLayer(layer);
        alertLayersByCode.set(a.alertCode, layer);
        added++;
      }
      alertsLayer = group;
      const chk = document.getElementById('chkMapBiomas');
      if (chk && !chk.checked) chk.checked = true;
      if (map) map.addLayer(alertsLayer);
      if (faixaPanel) {
        updateAlertsPanelByFaixa(alerts.collection || [], alertsByPolygon, allFeaturesForPanel);
      } else if (alertsByPolygon && allFeaturesForPanel) {
        updateAlertsPanelByPolygon(alertsByPolygon, allFeaturesForPanel);
      }
      if (opts.fitMap !== false) {
        if (added > 0) {
          try { map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 14 }); } catch (_) {}
        } else if (assentamentosLayer) {
          try { map.fitBounds(assentamentosLayer.getBounds(), { padding: [50, 50], maxZoom: 16, animate: true }); } catch (_) {}
        }
      }
      return added;
    }

    async function runLoadAlerts(opts = {}) {
      const job = runLoadAlertsJob(opts);
      loadAlertsInFlight = job;
      syncConsultaExecutarButton();
      try {
        return await job;
      } finally {
        if (loadAlertsInFlight === job) loadAlertsInFlight = null;
        syncConsultaExecutarButton();
      }
    }

    async function runLoadAlertsJob({ forceRefresh = false } = {}) {
      syncPeriodInputs();
      let startDate = document.getElementById('startDate').value;
      let endDate = document.getElementById('endDate').value;
      if (!startDate) startDate = '2020-01-01';
      if (!endDate) endDate = localTodayStr();
      const btnPanel = document.getElementById('btnAplicarFiltros');
      if (btnPanel) btnPanel.disabled = true;
      const myGen = ++runLoadAlertsGeneration;
      showScanStatusPrep();
      initMap();
      try {
        if (API_BASE) {
          await ensureFaixaPlanejamentoReady({ quiet: true });
          if (faixaPlanejamentoGeoJSON && !assentamentosLayer) {
            processAndDisplayGeoJSON(faixaPlanejamentoGeoJSON);
          }
        } else {
          await bootstrapTaboaShapes().catch(() => {});
          await ensureFaixaPlanejamentoReady({ quiet: true });
        }
        if (myGen !== runLoadAlertsGeneration) return;

        if (API_BASE) {
          setAssentamentosLayerStandby(true);
          showScanStatusPrep();
          let payload;
          let serverFailed = false;
          try {
            payload = await consumeScanAlertsStream({
              apiBase: API_BASE,
              startDate,
              endDate,
              selectedIndices: [...selectedShapeIndices],
              forceRefresh,
              myGen,
              getGeneration: () => runLoadAlertsGeneration,
              onStatus: setStatus,
              onScanPrep: showScanStatusPrep,
              onScanProgress: updateScanStatusProgress,
            });
          } catch (err) {
            serverFailed = true;
            setAssentamentosLayerStandby(false);
            if (myGen !== runLoadAlertsGeneration) return;
            setStatus('Servidor indisponível ou erro na varredura: ' + (err.message || String(err)), true);
            return;
          }
          if (myGen !== runLoadAlertsGeneration) {
            setAssentamentosLayerStandby(false);
            return;
          }
          if (payload) {
            currentAlertsNaFaixaPlanejamento = payload.alerts || payload.currentAlertsNaFaixaPlanejamento || [];
            selectedShapeIndices.clear();
            for (const i of (payload.selectedIndices || [])) selectedShapeIndices.add(i);
            const allFeatures = assentamentosGeoJSON?.features || [];
            syncAllShapeLayersVisibility();
            updateShapesScanList(allFeatures);
            const useFaixaSweep = !!payload.useFaixaSweep;
            const faixaAlerts = payload.alerts || payload.currentAlertsNaFaixaPlanejamento || [];
            const rawListForMap = useFaixaSweep && faixaAlerts.length
              ? faixaAlerts
              : (payload.alerts || payload.allAlertsForMap || (payload.collection && payload.collection.collection) || []);
            const { listForMap, alertsByPolygonClipped } = _buildClippedPayload(
              useFaixaSweep ? faixaAlerts : rawListForMap,
              payload.alertsByPolygon,
              allFeatures,
            );
            const collectionForMap = alertsForCurrentIncraFilter(
              useFaixaSweep && faixaAlerts.length ? faixaAlerts : listForMap,
            );
            const alerts = { collection: collectionForMap, metadata: { totalCount: collectionForMap.length } };
            const mapOpts = useFaixaSweep
              ? { fullGeometry: false, faixaPanel: true, requireShapeSelection: false }
              : {};
            addAlertsToMap(alerts, null, false, alertsByPolygonClipped, allFeatures, mapOpts);
            if (useFaixaSweep && !(faixaAlerts.length > 0)) {
              setStatus('Nenhum alerta MapBiomas na faixa 05/06/07 neste período.', true);
            } else {
              setStatus(formatFaixaAlertsStatus());
            }
            setAssentamentosLayerStandby(false);
            return;
          }
          if (!serverFailed && payload === null) {
            setAssentamentosLayerStandby(false);
          }
          return;
        }

        setStatus('A varredura de alertas precisa do servidor.', true);
        return;

        // ── Modo sem backend: varredura client-side usando AOI do WFS background ──
        let allFeatures = assentamentosGeoJSON?.features || [];
        const bgCands = getWfsBackgroundCandidates();
        const aoiBbox = getWfsBackgroundAoiBbox();

        // Usa a faixa local se ainda existir (legado), senão AOI do WFS
        const useFaixaSweep = faixaPlanejamentoGeoJSON?.features?.length > 0;
        const useWfsAoi = !useFaixaSweep && bgCands.length > 0 && aoiBbox;

        const onMapbiomasRetry = (msg) => showScanStatusPrep(msg);
        const token = await signInClient(email, password, onMapbiomasRetry);
        if (myGen !== runLoadAlertsGeneration) return;
        const alertsByPolygon = {};
        const seenCodes = new Set();
        const allAlertsForMap = [];
        currentAlertsNaFaixaPlanejamento = [];

        if (useFaixaSweep) {
          const faixaFeatures = faixaPlanejamentoGeoJSON.features || [];
          const municipios = groupFaixaFeaturesByMunicipio(faixaFeatures);
          const nMunicipios = municipios.length;
          if (nMunicipios === 0) {
            setStatus('Faixa sem municípios.', true);
            return;
          }
          setAssentamentosLayerStandby(true);
          showFaixaSearchLayerOnMap();
          const seenFaixaCodes = new Set();
          const allFaixaRaw = [];
          const alertCodeToObj = new Map();
          let anyPartial = false;
          showScanStatusPrep();
          for (let mi = 0; mi < nMunicipios; mi++) {
            if (myGen !== runLoadAlertsGeneration) { removeFaixaSearchLayerFromMap(); setAssentamentosLayerStandby(false); return; }
            const { ibgeId, munNome: nomeMun, regiaoTaboa, munBbox, feats: munFeats } = municipios[mi];
            updateScanStatusProgress({
              completed: mi + 1,
              total: nMunicipios,
              municipality: nomeMun,
            });
            try {
              const result = await fetchAlertsForMunicipioClient(token, {
                startDate, endDate, limit: MAPBIOMAS_PAGE_LIMIT_FAIXA, ibgeId, munBbox, munFeats,
              }, null, onMapbiomasRetry);
              if (result.metadata?.partial) anyPartial = true;
              for (const a of result.collection || []) {
                if (!seenFaixaCodes.has(a.alertCode)) {
                  seenFaixaCodes.add(a.alertCode);
                  a._regiaoTaboa = regiaoTaboa;
                  a._munNomesInFaixa = [nomeMun];
                  allFaixaRaw.push(a);
                  alertCodeToObj.set(a.alertCode, a);
                } else {
                  const existing = alertCodeToObj.get(a.alertCode);
                  if (existing && !existing._munNomesInFaixa?.includes(nomeMun)) {
                    if (!existing._munNomesInFaixa) existing._munNomesInFaixa = [];
                    existing._munNomesInFaixa.push(nomeMun);
                    if (regiaoTaboa && existing._regiaoTaboa && existing._regiaoTaboa !== regiaoTaboa && existing._regiaoTaboa !== 'divisa') existing._regiaoTaboa = 'divisa';
                  }
                }
              }
            } catch (fetchErr) { console.warn(`Erro ao buscar alertas para ${nomeMun}:`, fetchErr); }
            await yieldToMain();
          }
          if (myGen !== runLoadAlertsGeneration) { removeFaixaSearchLayerFromMap(); setAssentamentosLayerStandby(false); return; }
          if (anyPartial) { setStatus('Aviso: varredura parcial — limite de páginas da API.', true); await yieldToMain(); }
          let inRegion = allFaixaRaw.filter((a) => alertHitsFaixaPlanningArea(a, faixaPlanejamentoGeoJSON));
          currentAlertsNaFaixaPlanejamento = inRegion;
          removeFaixaSearchLayerFromMap();
          setAssentamentosLayerStandby(false);
          if (myGen !== runLoadAlertsGeneration) return;
          // Cruzamento com assentamentos (painel por polígono); mapa usa geometria integral MapBiomas
          const crossFeats = allFeatures.length ? allFeatures : bgCands.map((c) => c.feature);
          for (let origIdx = 0; origIdx < crossFeats.length; origIdx++) {
            const feat = crossFeats[origIdx];
            if (!feat?.geometry) { alertsByPolygon[origIdx] = []; continue; }
            const filtered = inRegion.filter((a) => alertBelongsToFeature(a, feat));
            alertsByPolygon[origIdx] = filtered.map((a) => {
              const r = computeClippedResult(a, feat.geometry);
              const aClipped = r != null ? { ...a, _clippedAreaHa: r.areaHa, _clippedGeom: r.geom } : a;
              if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertsForMap.push(aClipped); }
              return aClipped;
            });
          }
        } else if (useWfsAoi) {
          // ── Novo caminho: AOI das camadas WFS ──
          setAssentamentosLayerStandby(true);
          setStatus('Varrendo área das camadas WFS…');
          showLoading('Buscando alertas MapBiomas na área das camadas…');
          const onProgress = ({ page, totalCount, fetched }) => {
            const t = totalCount != null ? ` / ${totalCount}` : '';
            setStatus(`Alertas MapBiomas · p.${page} (${fetched}${t})`);
          };
          try {
            const result = await fetchAllAlertsClient(token, { startDate, endDate, limit: 800, boundingBox: aoiBbox }, onProgress, onMapbiomasRetry);
            if (myGen !== runLoadAlertsGeneration) { setAssentamentosLayerStandby(false); return; }
            const rawAlerts = result.collection || [];
            currentAlertsNaFaixaPlanejamento = rawAlerts;
            // Cruzamento com polígonos WFS
            for (let origIdx = 0; origIdx < bgCands.length; origIdx++) {
              const feat = bgCands[origIdx].feature;
              if (!feat?.geometry) { alertsByPolygon[origIdx] = []; continue; }
              const filtered = rawAlerts.filter((a) => alertBelongsToFeature(a, feat));
              alertsByPolygon[origIdx] = filtered.map((a) => {
                const r = computeClippedResult(a, feat.geometry);
                const aClipped = r != null ? { ...a, _clippedAreaHa: r.areaHa, _clippedGeom: r.geom } : a;
                if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertsForMap.push(aClipped); }
                return aClipped;
              });
            }
          } finally {
            hideLoading();
            setAssentamentosLayerStandby(false);
          }
        } else {
          // Sem faixa e sem WFS: varredura por bbox de cada shape local
          setAssentamentosLayerStandby(true);
          const selectedIndices = allFeatures.length
            ? ([...selectedShapeIndices].length ? [...selectedShapeIndices] : allFeatures.map((_, i) => i))
            : [];
          const featBboxes = allFeatures.map((f) => { try { return turf.bbox(f.geometry); } catch (_) { return null; } });
          setStatus('Varrendo cada polígono local…');
          showLoading('Varrendo alertas…');
          try {
            for (const origIdx of selectedIndices) {
              if (myGen !== runLoadAlertsGeneration) { setAssentamentosLayerStandby(false); return; }
              const f = allFeatures[origIdx];
              const bb = featBboxes[origIdx];
              if (!f?.geometry || !bb) { alertsByPolygon[origIdx] = []; continue; }
              const nomeFeat = f.properties?.nome_proje || f.properties?.denominaca || `Polígono ${origIdx + 1}`;
              setStatus(`${nomeFeat}…`);
              const onProg = ({ page, fetched }) => setStatus(`${nomeFeat} · p.${page} (${fetched})`);
              const result = await fetchAllAlertsClient(token, { startDate, endDate, limit: 500, boundingBox: bb }, onProg, onMapbiomasRetry);
              const raw = result.collection || [];
              const filtered = raw.filter((a) => alertBelongsToFeature(a, f));
              alertsByPolygon[origIdx] = filtered.map((a) => {
                const r = computeClippedResult(a, f.geometry);
                const aClipped = r != null ? { ...a, _clippedAreaHa: r.areaHa, _clippedGeom: r.geom } : a;
                if (!seenCodes.has(a.alertCode)) { seenCodes.add(a.alertCode); allAlertsForMap.push(aClipped); }
                return aClipped;
              });
              await yieldToMain();
            }
            for (let i = 0; i < allFeatures.length; i++) {
              if (!selectedIndices.includes(i)) alertsByPolygon[i] = [];
            }
          } finally {
            hideLoading();
            setAssentamentosLayerStandby(false);
          }
          currentAlertsNaFaixaPlanejamento = [];
        }

        if (myGen !== runLoadAlertsGeneration) return;

        const faixaMapOpts = useFaixaSweep
          ? { fullGeometry: false, faixaPanel: true, requireShapeSelection: false }
          : {};
        const collectionForMap = alertsForCurrentIncraFilter(
          useFaixaSweep && currentAlertsNaFaixaPlanejamento.length
            ? currentAlertsNaFaixaPlanejamento
            : allAlertsForMap,
        );
        const alerts = { collection: collectionForMap, metadata: { totalCount: collectionForMap.length } };
        const usedFeats = allFeatures.length ? allFeatures : (bgCands.length ? bgCands.map((c) => c.feature) : []);
        addAlertsToMap(alerts, null, false, alertsByPolygon, usedFeats, faixaMapOpts);
        if (useFaixaSweep) {
          const nFaixa = currentAlertsNaFaixaPlanejamento.length;
          setStatus(nFaixa
            ? formatFaixaAlertsStatus()
            : 'Nenhum alerta MapBiomas na faixa 05/06/07 neste período.', !nFaixa);
        } else {
          setStatus(formatFaixaAlertsStatus());
        }
      } catch (e) {
        if (myGen === runLoadAlertsGeneration) {
          hideLoading();
          removeFaixaSearchLayerFromMap();
          setAssentamentosLayerStandby(false);
          setStatus('Erro: ' + (e.message || String(e)), true);
          console.error(e);
        }
      } finally {
        hideLoading();
        hideScanStatus();
        if (btnPanel && myGen === runLoadAlertsGeneration) btnPanel.disabled = false;
        if (API_BASE && myGen === runLoadAlertsGeneration) {
          scheduleDeferredShapeAssetsAfterScan();
        }
      }
    }

    initPeriodFilter();
    // ─────────────────────────────────────────────────────────────────────────────

    document.getElementById('btnLogin')?.addEventListener('click', () => {
      hideLogin();
      runLoadAlerts().catch((e) => setStatus('Erro na varredura: ' + (e.message || e), true));
    });

    document.getElementById('btnLoginCancel')?.addEventListener('click', () => {
      hideLogin();
    });

    setupAjudaConsulta();

    function onAtualizar() { runLoadAlerts({ forceRefresh: true }); }
    // Listener principal de "Aplicar Filtros" registrado abaixo (setupCombobox / registros section)

    setupAlertsTabs();
    setupFilterTabs();
    bindLayerList(document.querySelector('#remoteWmsLayersWrap .remote-wms-legend'));
    setupConsultaCadastro();

    document.getElementById('chkShape').addEventListener('change', function () {
      toggleShapeLayer(this.checked);
    });

    document.getElementById('chkMapBiomas')?.addEventListener('change', function () {
      toggleMapBiomasLayer(this.checked);
    });

    document.getElementById('chkIncraAssentamentos')?.addEventListener('change', function () {
      setRemoteLayerVisible('local:assentamentos', this.checked, this.checked ? { showAll: true } : undefined);
    });
    for (const cfg of SHAPE_OVERLAY_LAYERS) {
      const inp = document.getElementById(cfg.checkboxId);
      inp?.addEventListener('change', function () {
        setRemoteLayerVisible(`local:${cfg.id}`, this.checked);
      });
      if (cfg.defaultOn === false) {
        if (inp) inp.checked = false;
        setRemoteLayerVisible(`local:${cfg.id}`, false);
      }
    }

    document.getElementById('sidebarToggle').addEventListener('click', function () {
      document.getElementById('sidebarWrap').classList.toggle('collapsed');
    });

    function setAnalyticsOpen(open) {
      const wrap = document.getElementById('analyticsWrap');
      const toggle = document.getElementById('analyticsToggle');
      if (!wrap) return;
      wrap.classList.toggle('collapsed', !open);
      if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }

    document.getElementById('analyticsToggle')?.addEventListener('click', function () {
      setAnalyticsOpen(true);
    });
    document.getElementById('analyticsClose')?.addEventListener('click', function () {
      setAnalyticsOpen(false);
    });

    // ─── Registros ────────────────────────────────────────────────────────────

    /**
     * Busca lista de arquivos CSV disponíveis no backend e popula o <select>.
     */
    // â”€â”€ Combobox customizado (Município / CPF) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const _comboboxAllItems = {};

    function refreshFilterMunicipiosCombobox() {
      fillCombobox('municipiosDropdown', getMunicipioNamesByUf());
    }

    async function initIbgeMunicipios() {
      try {
        await loadIbgeMunicipios();
        refreshFilterMunicipiosCombobox();
      } catch (e) {
        console.warn('IBGE municípios:', e);
      }
    }

    function _renderComboboxList(ul, items, onSelect) {
      if (!ul) return;
      if (!items.length) {
        ul.innerHTML = '<li class="filter-combobox-empty">Nenhum resultado</li>';
      } else {
        ul.innerHTML = items.map(
          (v) => `<li data-value="${v.replace(/"/g, '&quot;')}">${v}</li>`
        ).join('');
        ul.querySelectorAll('li[data-value]').forEach((li) => {
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            onSelect(li.dataset.value);
            ul.hidden = true;
          });
        });
      }
    }

    function _openComboboxElements(ul, input, allItems) {
      if (!ul || !input) return;
      const q = foldFilterText(input.value);
      const filtered = q ? allItems.filter((v) => foldFilterText(v).startsWith(q)) : allItems;
      _renderComboboxList(ul, filtered, (val) => {
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      ul.hidden = false;
      if (ul.parentElement !== document.body) document.body.appendChild(ul);
      const rect = input.getBoundingClientRect();
      const gap = 4;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const maxH = Math.max(160, Math.min(280, spaceBelow));
      ul.style.position = 'fixed';
      ul.style.left = `${Math.round(rect.left)}px`;
      ul.style.width = `${Math.round(rect.width)}px`;
      ul.style.right = 'auto';
      ul.style.top = `${Math.round(rect.bottom + gap)}px`;
      ul.style.bottom = 'auto';
      ul.style.zIndex = '4000';
      ul.style.maxHeight = `${maxH}px`;
    }

    function fillCombobox(dropdownId, items) {
      _comboboxAllItems[dropdownId] = items;
      _renderCombobox(dropdownId, items);
    }

    function _renderCombobox(dropdownId, items) {
      const ul = document.getElementById(dropdownId);
      if (!ul) return;
      const input = document.getElementById('filterMunicipio');
      _renderComboboxList(ul, items, (val) => {
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }

    function _openCombobox(dropdownId, inputId) {
      const ul = document.getElementById(dropdownId);
      const input = document.getElementById(inputId);
      if (!ul || !input) return;
      const all = _comboboxAllItems[dropdownId] || [];
      _openComboboxElements(ul, input, all);
    }

    function setupCombobox(inputId, dropdownId, toggleBtnId) {
      const input = document.getElementById(inputId);
      const toggleBtn = document.getElementById(toggleBtnId);
      const ul = document.getElementById(dropdownId);
      if (!input || !ul) return;

      // Abre ao focar
      input.addEventListener('focus', () => _openCombobox(dropdownId, inputId));

      // Filtra enquanto digita
      input.addEventListener('input', () => {
        _openCombobox(dropdownId, inputId);
      });

      // Seta abre/fecha
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          if (ul.hidden) { _openCombobox(dropdownId, inputId); } else { ul.hidden = true; }
        });
      }

      // Fecha ao perder foco (blur com delay para permitir click no item)
      input.addEventListener('blur', () => setTimeout(() => { ul.hidden = true; }, 150));
      input.closest('.filter-tab-content')?.addEventListener('scroll', () => { ul.hidden = true; }, { passive: true });
      window.addEventListener('resize', () => { ul.hidden = true; });
      document.addEventListener('pointerdown', (ev) => {
        if (ul.hidden) return;
        const t = ev.target;
        if (ul.contains(t) || input.contains(t) || toggleBtn?.contains(t)) return;
        ul.hidden = true;
      }, true);
    }

    setupCombobox('filterMunicipio', 'municipiosDropdown', 'btnMunicipioToggle');
    setupAssentamentoCombobox();
    // ── fim combobox ───────────────────────────────────────────────────────

    // ── Cruzamento registros × alertas ─────────────────────────────────────
    /** Última análise de cruzamento realizada — usada para recolorir buffers. */
    let _cruzamentoResults = null;
    /** Cruzamento «Consulta cadastro» com quadro manual para PDF — prioridade sobre CRA ao gerar relatório. */
    let _consultaPdfRows = null;

    /**
     * Cruzamento CRA × alertas por registro: se o ponto estiver dentro de algum polígono
     * de assentamento carregado (fazenda, INCRA, SIGEF, etc.), usa essa geometria para
     * reter todo alerta que intersecta o assentamento; senão usa buffer de 500 m (1 km Ø).
     * Atualiza a camada de áreas de análise e o modal de resultados.
     */
    async function cruzarRegistrosComAlertas() {
      const btn = document.getElementById('btnCruzarDados');
      const statusEl = document.getElementById('cruzamentoStatus');

      if (!currentRegistrosRecords.length) {
        setStatus('Carregue os registros antes de cruzar.', true); return;
      }
      if (!currentAlertsFlat.length) {
        setStatus('Carregue os alertas antes de cruzar.', true); return;
      }

      if (btn) btn.disabled = true;
      if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Calculando (shapes locais + WFS CAR/INCRA)…'; }

      // Pequeno delay para o browser pintar o status antes do loop pesado
      await new Promise((r) => setTimeout(r, 30));

      const shapeFeatsParaCruzamento = assentamentosGeoJSON?.features?.length
        ? assentamentosGeoJSON.features.filter((f) => f?.geometry)
        : null;

      const results = [];

      for (const rec of currentRegistrosRecords) {
        const lat = parseDMSCoord(rec['Latitude']  ?? rec['latitude']);
        const lng = parseDMSCoord(rec['Longitude'] ?? rec['longitude']);
        if (lat == null || lng == null) continue;

        const r = await cruzarCoordenadaComAlertasFeatures(lat, lng, currentAlertsFlat, shapeFeatsParaCruzamento, assentamentosGeoJSON?.features);
        results.push({
          rec,
          lat,
          lng,
          mode: r.mode,
          aoiMeta: r.aoiMeta,
          assentamentoLabels: r.assentamentoLabels,
          assentamentoShapeIndices: r.assentamentoShapeIndices,
          regionGeoJSON: r.regionGeoJSON,
          clipsNoBuffer: r.clipsNoBuffer,
          alertasNoBuffer: r.alertasNoBuffer,
          areaDesmatadaHa: r.areaDesmatadaHa,
          afetado: r.afetado,
          cefirCarFromShape: r.cefirCarFromShape,
          imoveisNoPonto: r.imoveisNoPonto,
          primaryImovel: r.primaryImovel,
          primaryCar: r.primaryCar,
          camadasHa: r.camadasHa,
          settlementOverlap: r.settlementOverlap || null,
          prioritizedHits: r.prioritizedHits,
          containing: r.containing,
          apaRows: r.apaRows,
          lat: r.lat,
          lng: r.lng,
        });
      }

      _cruzamentoResults = results;
      _consultaPdfRows = null;

      // Re-renderiza buffers com cores de status
      _renderBuffersComStatus(results);

      if (statusEl) {
        const afetados = results.filter((r) => r.afetado).length;
        statusEl.textContent = `${afetados} de ${results.length} registros com desmatamento na área analisada (assentamento ou buffer).`;
      }
      if (btn) btn.disabled = false;

      showCruzamentoModal(results);
    }

    /** Reconstrói a camada de buffers colorindo verde/vermelho conforme resultado do cruzamento. */
    function _renderBuffersComStatus(results) {
      if (!map) return;
      if (registrosBufferLayerGroup) {
        try { map.removeLayer(registrosBufferLayerGroup); } catch (_) {}
      }
      const layers = [];
      for (const { regionGeoJSON, clipsNoBuffer, afetado, rec, alertasNoBuffer, areaDesmatadaHa, mode, assentamentoLabels, aoiMeta } of results) {
        const color = afetado ? '#ef4444' : '#22c55e';
        const borderAssent = mode === 'poligono';
        const tipo  = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '';
        const nome  = rec['Nome'] || '—';
        const mun   = rec['Município'] || rec['Municipio'] || '—';
        const alertList = alertasNoBuffer.length
          ? alertasNoBuffer.map((a) => `#${a.alertCode} (${a.areaHa} ha, ${a.detectedAt})`).join('<br>')
          : 'Nenhum';
        const areaDesc = borderAssent && aoiMeta
          ? `<b>Área (prioritária):</b> ${aoiMeta.humanKind} — ${aoiMeta.label} (${aoiMeta.areaHa.toFixed(2)} ha)<br>`
          : borderAssent && (assentamentoLabels || []).length
            ? `<b>Área (polígono):</b> ${assentamentoLabels.join('; ')}<br>`
            : '<b>Área:</b> buffer 1 km de diâmetro (500 m de raio)<br>';
        const popupHtml =
          `<b>${nome}</b><br><small>${tipo} · ${mun}</small><hr style="margin:4px 0">
           ${areaDesc}
           <b>Alertas na área:</b><br>${alertList}
           ${afetado ? `<br><b>Área total:</b> ${Number(areaDesmatadaHa).toFixed(4)} ha` : ''}`;

        layers.push(
          L.geoJSON(regionGeoJSON, {
            interactive: true,
            renderer: rendererFor(map, 'registros'),
            style: {
              color: borderAssent ? '#7c3aed' : color,
              weight: borderAssent ? 2.5 : 2,
              opacity: 0.85,
              fillColor: color,
              fillOpacity: afetado ? 0.15 : 0.08,
              interactive: true,
            },
          }).bindPopup(popupHtml, { maxWidth: 280 })
        );

        // Fatias dos alertas recortadas exatamente ao buffer (sobrepostas em vermelho escuro)
        for (const clipGeom of clipsNoBuffer || []) {
          try {
            layers.push(
              L.geoJSON(clipGeom, {
                interactive: true,
                renderer: rendererFor(map, 'registros'),
                style: { color: '#b91c1c', weight: 1.5, opacity: 0.9, fillColor: '#ef4444', fillOpacity: 0.45, interactive: true },
              }).bindPopup(popupHtml, { maxWidth: 280 })
            );
          } catch (_) {}
        }
      }
      registrosBufferLayerGroup = L.layerGroup(layers);
      if (registrosVisible) registrosBufferLayerGroup.addTo(map);
    }

    /** Exibe o modal com tabela de resultados do cruzamento. */
    function showCruzamentoModal(results) {
      const modal    = document.getElementById('modalCruzamento');
      const tbody    = document.getElementById('cruzamentoTableBody');
      const summary  = document.getElementById('cruzamentoModalSummary');
      if (!modal || !tbody) return;

      const total    = results.length;
      const afetados = results.filter((r) => r.afetado).length;
      const limpos   = total - afetados;
      const areaTotal = results.reduce((s, r) => s + r.areaDesmatadaHa, 0);

      summary.innerHTML = `
        <span style="color:#ef4444">⚠ ${afetados} com desmatamento</span>
        <span style="color:#22c55e">✔ ${limpos} sem desmatamento</span>
        <span>Área total desmatada nas áreas analisadas: <span>${Number(areaTotal).toFixed(4)} ha</span></span>`;

      tbody.innerHTML = results.map((r) => {
        const { rec, alertasNoBuffer, areaDesmatadaHa, afetado, aoiMeta } = r;
        const nome  = rec['Nome']      || '—';
        const cpf   = rec['CPF/CNPJ'] || rec['CPF'] || '—';
        const mun   = rec['Município'] || rec['Municipio'] || '—';
        const tipo  = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '—';
        const aoiShort = aoiMeta
          ? `${aoiMeta.humanKind}: ${aoiMeta.label}`
          : (r.mode === 'poligono' ? 'Polígono' : 'Buffer 1 km');
        const badge = afetado
          ? `<span class="crz-badge-alert">⚠ Afetado</span>`
          : `<span class="crz-badge-ok">✔ Limpo</span>`;
        return `<tr>
          <td>${nome}</td>
          <td><code>${cpf}</code></td>
          <td>${mun}</td>
          <td>${tipo}</td>
          <td>${aoiShort}</td>
          <td>${alertasNoBuffer.length}</td>
          <td>${afetado ? Number(areaDesmatadaHa).toFixed(4) : '—'}</td>
          <td>${badge}</td>
        </tr>`;
      }).join('');

      modal.classList.remove('hidden');
    }

    document.getElementById('btnCruzarDados')?.addEventListener('click', () => {
      cruzarRegistrosComAlertas().catch((e) => {
        console.error(e);
        setStatus('Erro no cruzamento: ' + (e.message || e), true);
        const btn = document.getElementById('btnCruzarDados');
        if (btn) btn.disabled = false;
      });
    });

    document.getElementById('btnCruzamentoFechar')?.addEventListener('click', () => {
      document.getElementById('modalCruzamento')?.classList.add('hidden');
    });
    // ── fim cruzamento ─────────────────────────────────────────────────────

    async function populateRegistrosSelect() {
      const sel = document.getElementById('selectRegistroFile');
      if (!sel) return;
      if (!API_BASE) {
        // Sem backend: oculta a seção
        const sec = document.getElementById('registrosSection');
        if (sec) sec.style.display = 'none';
        return;
      }
      try {
        const resp = await fetch(`${API_BASE}/api/registros`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const { files } = await resp.json();
        sel.innerHTML = '<option value="">-- escolher --</option>';
        for (const f of files) {
          const opt = document.createElement('option');
          opt.value = f;
          opt.textContent = f.replace(/\.csv$/i, '');
          sel.appendChild(opt);
        }
      } catch (e) {
        console.warn('[registros] erro ao listar arquivos:', e);
        const sec = document.getElementById('registrosSection');
        if (sec) sec.style.display = 'none';
      }
    }

    /**
     * Determina se um registro (campo "Está no CRA") corresponde ao filtro selecionado.
     * Mapeamento dropdown → valores no CSV:
     *   CRA2           → contém "2024" e NÃO contém "REV"
     *   CRA2-Revol2024 → contém "2024" E contém "REV"
     *   CRA1           → contém "CRA", NÃO contém "2024", NÃO contém "REV", NÃO contém "FIAGRO"
     *   CRA1-Revol     → contém "CRA", NÃO contém "2024", contém "REV"
     *   FIAGRO         → contém "FIAGRO"
     */
    function matchesOperacaoFilter(filtroVal, tipo) {
      if (filtroVal === 'all' || !filtroVal) return true;
      if (!tipo) return false;
      const t = String(tipo).toUpperCase();
      switch (filtroVal) {
        case 'CRA1':           return /CRA/.test(t) && !t.includes('2024') && !t.includes('REV') && !t.includes('FIAGRO');
        case 'CRA1-Revol':     return /CRA/.test(t) && !t.includes('2024') && t.includes('REV');
        case 'CRA2':           return t.includes('2024') && !t.includes('REV');
        case 'CRA2-Revol2024': return t.includes('2024') && t.includes('REV');
        case 'FIAGRO':         return t.includes('FIAGRO');
        default:               return t.includes(filtroVal.toUpperCase());
      }
    }

    /** Mapa UF → nome completo para comparar com o campo "Estado" do CSV. */
    const UF_NOMES = {
      AC:'ACRE', AL:'ALAGOAS', AP:'AMAPÁ', AM:'AMAZONAS',
      BA:'BAHIA', CE:'CEARÁ', DF:'DISTRITO FEDERAL', ES:'ESPÍRITO SANTO',
      GO:'GOIÁS', MA:'MARANHÃO', MT:'MATO GROSSO', MS:'MATO GROSSO DO SUL',
      MG:'MINAS GERAIS', PA:'PARÁ', PB:'PARAÍBA', PR:'PARANÁ',
      PE:'PERNAMBUCO', PI:'PIAUÍ', RJ:'RIO DE JANEIRO', RN:'RIO GRANDE DO NORTE',
      RS:'RIO GRANDE DO SUL', RO:'RONDÔNIA', RR:'RORAIMA',
      SC:'SANTA CATARINA', SP:'SÃO PAULO', SE:'SERGIPE', TO:'TOCANTINS',
    };

    /** Remove acentos e lowercases — para comparação tolerante a acentuação. */
    function normStr(s) {
      return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    }

    /**
     * Reconstrói a camada de registros aplicando TODOS os filtros ativos:
     * Operações, CPF, Município e Estado.
     */
    function applyRegistrosFilter() {
      if (!currentRegistrosRecords.length) return;

      const filtroOp     = document.getElementById('filterOperacao')?.value || 'all';
      const filtroCPF    = normStr(document.getElementById('filterCPF')?.value).replace(/\D/g, '');
      const filtroUF     = (document.getElementById('filterEstado')?.value || '').trim().toUpperCase();

      // UF selecionada → nome completo normalizado para comparar com o CSV
      const filtroEstadoNorm = filtroUF ? normStr(UF_NOMES[filtroUF] || filtroUF) : '';

      const filtered = currentRegistrosRecords.filter((rec) => {
        // â”€â”€ Operações â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const tipo = rec['Está no CRA'] || rec['Esta no CRA'] || rec['CRA'] || '';
        if (!matchesOperacaoFilter(filtroOp, tipo)) return false;

        // â”€â”€ CPF (parcial, só dígitos) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (filtroCPF) {
          const cpfRec = normStr(rec['CPF/CNPJ'] || rec['CPF'] || '').replace(/\D/g, '');
          if (!cpfRec.includes(filtroCPF)) return false;
        }

        // ── Estado (UF → nome completo) ────────────────────────────────────
        if (filtroEstadoNorm) {
          const estRec = normStr(rec['Estado'] || '');
          if (!estRec.includes(filtroEstadoNorm) && normStr(filtroUF) !== estRec) return false;
        }

        const incraFeat = getSelectedIncraAssentamentoFeature();
        if (incraFeat?.geometry) {
          const lat = parseDMSCoord(rec['Latitude'] ?? rec['latitude']);
          const lng = parseDMSCoord(rec['Longitude'] ?? rec['longitude']);
          if (lat == null || lng == null) return false;
          try {
            if (!turf.booleanPointInPolygon(turf.point([lng, lat]), turf.feature(incraFeat.geometry))) return false;
          } catch (_) {
            return false;
          }
        }

        return true;
      });

      // Remove camadas anteriores
      if (registrosBufferLayerGroup && map) {
        try { map.removeLayer(registrosBufferLayerGroup); } catch (_) {}
      }
      if (registrosLayerGroup && map) {
        try { map.removeLayer(registrosLayerGroup); } catch (_) {}
      }

      // Buffer (abaixo dos pontos)
      registrosBufferLayerGroup = buildRegistrosBufferLayer(
        filtered,
        assentamentosGeoJSON?.features?.filter((f) => f?.geometry),
        cruzamentoCandidates && cruzamentoCandidates.length ? cruzamentoCandidates : null
      );
      const { layer, withCoords } = buildRegistrosLayer(filtered, {
        renderer: map ? rendererFor(map, 'registros') : null,
      });
      registrosLayerGroup = layer;

      if (map && registrosVisible) {
        registrosBufferLayerGroup.addTo(map);
        registrosLayerGroup.addTo(map);
      }

      const ativos = [
        filtroOp !== 'all' ? `op:${filtroOp}` : null,
        filtroCPF ? `cpf:${filtroCPF}` : null,
        filtroMun ? `mun:${filtroMun}` : null,
        filtroEstadoNorm ? `uf:${filtroUF}` : null,
      ].filter(Boolean);

      const labelFiltros = ativos.length ? ` [${ativos.join(', ')}]` : '';
      setStatus(`Registros${labelFiltros}: ${withCoords} ponto(s) no mapa`);
    }

    /**
     * Carrega o CSV escolhido do backend, salva em memória e aplica filtro.
     */
    async function loadRegistros() {
      const sel = document.getElementById('selectRegistroFile');
      const filename = sel?.value;
      if (!filename) { setStatus('Escolha um arquivo de registros.', true); return; }

      const btn = document.getElementById('btnCarregarRegistros');
      if (btn) btn.disabled = true;
      setStatus(`Carregando registros: ${filename}…`);

      try {
        const resp = await fetch(`${API_BASE}/registros/${encodeURIComponent(filename)}`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const records = await resp.json();

        currentRegistrosRecords = records;
        registrosVisible = true;

        refreshFilterMunicipiosCombobox();

        // Atualiza checkbox de visibilidade
        const chk = document.getElementById('chkRegistros');
        if (chk) { chk.disabled = false; chk.checked = true; }

        // Mostra seção de cruzamento de dados
        const cruzSec = document.getElementById('cruzamentoSection');
        if (cruzSec) cruzSec.style.display = '';
        const cruzStatus = document.getElementById('cruzamentoStatus');
        if (cruzStatus) { cruzStatus.hidden = true; cruzStatus.textContent = ''; }

        // Aplica filtro atual (respeita o que está selecionado no dropdown)
        // applyRegistrosFilter já chama setStatus com a contagem real via withCoords
        applyRegistrosFilter();
      } catch (e) {
        setStatus('Erro ao carregar registros: ' + (e.message || e), true);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function toggleRegistrosLayer(visible) {
      registrosVisible = visible;
      if (!map) return;
      if (visible) {
        if (registrosBufferLayerGroup) registrosBufferLayerGroup.addTo(map);
        if (registrosLayerGroup)       registrosLayerGroup.addTo(map);
      } else {
        if (registrosBufferLayerGroup) try { map.removeLayer(registrosBufferLayerGroup); } catch (_) {}
        if (registrosLayerGroup)       try { map.removeLayer(registrosLayerGroup); } catch (_) {}
      }
    }

    // Inicializa select assim que o DOM estiver pronto
    populateRegistrosSelect();

    document.getElementById('btnCarregarRegistros')?.addEventListener('click', () => {
      loadRegistros().catch((e) => { console.error(e); setStatus('Erro: ' + (e.message || e), true); });
    });

    document.getElementById('chkRegistros')?.addEventListener('change', function () {
      toggleRegistrosLayer(this.checked);
    });

    function applyMunicipioZoomFromInput() {
      const nome = (document.getElementById('filterMunicipio')?.value || '').trim();
      const feat = findMunicipioFeature(nome);
      const features = assentamentosGeoJSON?.features || [];
      const key = feat ? normMunNome(nome) : '';

      selectedShapeIndices.clear();
      for (let i = 0; i < features.length; i++) {
        const f = features[i];
        const n = f?.properties?.nomMun || f?.properties?.nm_mun || f?.properties?.NM_MUN || '';
        const match = !key || normMunNome(n) === key;
        if (match) selectedShapeIndices.add(i);
        toggleShapeVisibility(i, match);
      }

      if (!feat) return;

      const chk = document.getElementById('chkShape');
      if (chk && !chk.checked) {
        chk.checked = true;
        toggleShapeLayer(true);
      } else if (chk?.checked) {
        toggleShapeLayer(true);
      }
      flyToGeojsonFeature(feat, map);
    }

    document.getElementById('filterMunicipio')?.addEventListener('input', () => {
      populateAssentamentoSelect();
      applyMunicipioZoomFromInput();
    });

    // Botão "Aplicar Filtros" → registros + varredura MapBiomas na faixa 05/06/07
    document.getElementById('btnAplicarFiltros')?.addEventListener('click', async () => {
      syncPeriodInputs();
      applyRegistrosFilter();
      scheduleRemoteLayersRefresh(100);
      try {
        const nAssent = await refreshIncraAssentamentosForCurrentAoi();
        if (nAssent > 0) {
          setStatus(`${nAssent} assentamento(s) INCRA sobrepostos à área local.`);
        }
      } catch (e) {
        console.warn('assentamentos INCRA × área local:', e);
      }
      await runLoadAlerts({ forceRefresh: true });
    });

    // Botão "Resetar" → filtros, camadas e vista do mapa no estado inicial
    document.getElementById('btnResetarFiltros')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      resetAppToDefaults();
    });

    (async function startup() {
      initMap();
      subscribeIncraAssentamentos(() => populateAssentamentoSelect());
      setIncraAssentamentosPrepareHook(async (meta) => {
        if (meta?.showAll || !getIncraAssentamentosFC()?.features?.length) {
          await refreshIncraAssentamentosForCurrentAoi();
        }
      });
      prefetchIncraAssentamentos()
        .then(() => populateAssentamentoSelect())
        .catch((e) => console.warn('assentamentos INCRA:', e));
      if (API_BASE) {
        await refreshRemoteLayersAndPreload({ loadLocalGeojson: false }).catch((e) => console.warn(e));
        await Promise.all([bootstrapFaixaMinimal(), initIbgeMunicipios()]);
      } else {
        await Promise.all([bootstrapTaboaShapes(), initIbgeMunicipios()]);
      }
      try {
        await ensureIncraAssentamentosFromFile(map);
        populateAssentamentoSelect();
      } catch (e) {
        console.warn('assentamentos INCRA:', e);
      }
      clearCreds();
      setStatus('✓ Varredura MapBiomas na faixa 05/06/07…');
      runLoadAlerts().catch((e) => setStatus('Erro na varredura: ' + (e.message || e), true));
    })();
}
