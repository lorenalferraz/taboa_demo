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
  ASSENTAMENTOS_STYLE,
  ASSENTAMENTOS_STANDBY_STYLE,
  PDF_GREEN,
  PDF_GREEN_LIGHT
} from './lib/constants.js';
import { tagFeaturesRegiaoTaboa, featureNomePublico, regiaoPlanejamentoLabel, cefirCarFromContainingFeatures, formatCefirCarFromFeatureProperties } from './lib/region.js';
import {
  parseCrsFromGeoJSON,
  inferCrsFromCoordinates,
  reprojectToWGS84,
  prepareGeoJsonForDisplay,
  needsReprojectToWgs84,
} from './lib/geoCore.js';
import { fetchFaixaGeoJson } from './lib/faixaGeojsonClient.js';
import { groupFaixaFeaturesByMunicipio } from './lib/faixaScanUtils.js';
import { normalizeFaixaShapeGeoJSON } from './lib/faixaShapeNormalize.js';
import { pickShapeFilename } from './lib/shapePick.js';
import { applyLightTheme } from './lib/theme.js';
import { renderProdesAnalyticsHtml } from './lib/analyticsPanel.js';
import { yieldToMain } from './lib/yieldToMain.js';
import {
  initPeriodFilter,
  localTodayStr,
  resetPeriodFilter,
  syncPeriodInputs,
} from './lib/periodFilter.js';
import { setupMapPopupPlacement } from './lib/popupPlacement.js';
import { applyLayerOrder, bindLayerList, rendererFor } from './lib/layerOrder.js';
import { setProdesVisible } from './lib/prodesLayer.js';
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

    let map = null, assentamentosLayer = null, assentamentosGeoJSON = null;
    /** Camada só visual com os polígonos da faixa (municípios). */
    let faixaSearchLayer = null;
    /** Municípios da faixa 05/06/07 (shape oficial) em WGS84. */
    let faixaPlanejamentoGeoJSON = null;
    const featureLayersByIndex = new Map(); // índice -> layer Leaflet para mostrar/esconder shape individual
    const selectedShapeIndices = new Set();
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
     * Usado como fonte de AOI para cruzamento.
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
     * Exclui FUNAI (indígenas). Usado como AOI para cruzamento direto.
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

    /** Camadas fundiárias pesadas — carregadas depois da faixa, sem travar a abertura. */
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
              setStatus(`✓ Faixa oficial (${nMun} municípios).`);
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
      setStatus('✓ Pronto.');
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
      setStatus('✓ Pronto.');
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
      const prodes = document.getElementById('chkProdes');
      if (prodes) prodes.checked = true;
      document.querySelectorAll('#remoteWmsLayersWrap .remote-wms-legend input[type="checkbox"]').forEach((inp) => {
        if (inp.id === 'chkShape' || inp.id === 'chkProdes') return;
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
      setProdesVisible(map, true).catch(() => {});
      resetMapViewToDefault();
      setStatus('Filtros e mapa restaurados ao padrão.');

      requestAnimationFrame(() => {
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

    function updatePolygonPopups() {
      if (!assentamentosLayer) return;
      const allFeatures = assentamentosGeoJSON?.features || [];
      assentamentosLayer.eachLayer((layer) => {
        const i = layer._featureIndex;
        if (i == null) return;
        const f = allFeatures[i];
        const html = buildMunicipiosPopupHtml(f?.properties || {}, escConsultaHtml);
        if (layer.getPopup()) layer.setPopupContent(html);
        else layer.bindPopup(html, { maxWidth: 380 });
      });
    }

    let prodesResumo = null;
    let prodesResumoErro = false;
    let prodesResumoLoading = null;

    function loadProdesResumo() {
      if (prodesResumoLoading) return prodesResumoLoading;
      prodesResumoErro = false;
      prodesResumoLoading = fetch(`${API_BASE}/api/prodes/resumo`)
        .then((r) => r.json())
        .then((data) => {
          if (!data?.ok) throw new Error(data?.error || 'Falha no resumo do PRODES.');
          prodesResumo = data;
        })
        .catch((e) => {
          console.warn('resumo PRODES:', e);
          prodesResumoErro = true;
          prodesResumoLoading = null;
        })
        .finally(() => updateAnalyticPanel());
      return prodesResumoLoading;
    }

    function updateAnalyticPanel() {
      const body = document.getElementById('analyticsPanelBody');
      const countEl = document.getElementById('analyticsAlertsCount');
      if (!body) return;
      if (countEl) countEl.textContent = prodesResumo ? prodesResumo.total.toLocaleString('pt-BR') : '—';
      if (prodesResumo) {
        body.innerHTML = renderProdesAnalyticsHtml(prodesResumo);
      } else if (prodesResumoErro) {
        body.innerHTML = '<div class="analytic-empty">Não foi possível carregar o resumo do PRODES.</div>';
      } else {
        body.innerHTML = '<div class="analytic-empty">Carregando o resumo do PRODES…</div>';
      }
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

    function setupConsultaCadastro() {
      consultaTabApi = setupConsultaTab({
        getMap: () => map,
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

    initPeriodFilter();
    // ─────────────────────────────────────────────────────────────────────────────

    setupAjudaConsulta();

    setupFilterTabs();
    bindLayerList(document.querySelector('#remoteWmsLayersWrap .remote-wms-legend'));
    setupConsultaCadastro();

    document.getElementById('chkShape').addEventListener('change', function () {
      toggleShapeLayer(this.checked);
    });

    document.getElementById('chkIncraAssentamentos')?.addEventListener('change', function () {
      setRemoteLayerVisible('local:assentamentos', this.checked, this.checked ? { showAll: true } : undefined);
    });
    const chkProdes = document.getElementById('chkProdes');
    function syncProdesLayer() {
      if (!chkProdes) return;
      setProdesVisible(map, chkProdes.checked).catch((e) => {
        chkProdes.checked = false;
        setStatus('Não foi possível carregar o PRODES: ' + (e.message || e), true);
      });
    }
    chkProdes?.addEventListener('change', syncProdesLayer);
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
    updateAnalyticPanel();
    loadProdesResumo();

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

    // Botão "Aplicar Filtros" → registros e camadas da área
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
    });

    // Botão "Resetar" → filtros, camadas e vista do mapa no estado inicial
    document.getElementById('btnResetarFiltros')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      resetAppToDefaults();
    });

    (async function startup() {
      initMap();
      if (chkProdes?.checked) syncProdesLayer();
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
      scheduleDeferredShapeAssetsAfterScan();
    })();
}
