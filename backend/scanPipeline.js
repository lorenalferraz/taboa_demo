'use strict';

/**
 * Versão do pipeline de varredura na faixa.
 * v6: somente MapBiomas Alerta (PRODES/INPE removido — já entra como fonte no MapBiomas).
 */
const SCAN_PIPELINE_VERSION = 6;

const SCAN_SOURCES = ['mapbiomas'];

function extractAlertsArray(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.alerts)) return payload.alerts;
  if (Array.isArray(payload.currentAlertsNaFaixaPlanejamento)) return payload.currentAlertsNaFaixaPlanejamento;
  if (Array.isArray(payload.allAlertsForMap)) return payload.allAlertsForMap;
  if (Array.isArray(payload.collection?.collection)) return payload.collection.collection;
  return [];
}

function isScanCachePayloadValid(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.scanPipelineVersion !== SCAN_PIPELINE_VERSION) return false;
  if (!Array.isArray(payload.scanSources)) return false;
  for (const src of SCAN_SOURCES) {
    if (!payload.scanSources.includes(src)) return false;
  }
  if (!payload.useFaixaSweep) return false;
  if (typeof payload.mapbiomasCount !== 'number') return false;
  if (!Array.isArray(payload.alerts)) return false;
  return true;
}

function scanPipelineCacheSuffix() {
  return `v${SCAN_PIPELINE_VERSION}`;
}

/** Remove duplicação legacy (collection + allAlertsForMap + currentAlerts…). */
function compactScanPayload(payload) {
  const alerts = extractAlertsArray(payload);
  const {
    collection,
    allAlertsForMap,
    currentAlertsNaFaixaPlanejamento,
    alerts: _alerts,
    scanPipelineVersion: _v,
    scanSources: _s,
    generatedAt: _g,
    ...rest
  } = payload || {};

  return {
    ...rest,
    alerts,
    scanPipelineVersion: SCAN_PIPELINE_VERSION,
    scanSources: [...SCAN_SOURCES],
    generatedAt: payload?.generatedAt || new Date().toISOString(),
  };
}

function enrichScanPayload(payload) {
  return compactScanPayload(payload);
}

/** Compatibilidade: expõe aliases sem triplicar no JSON (só referências em memória). */
function hydrateScanPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const alerts = extractAlertsArray(payload);
  return {
    ...payload,
    alerts,
    currentAlertsNaFaixaPlanejamento: alerts,
    allAlertsForMap: alerts,
    collection: { collection: alerts, metadata: { totalCount: alerts.length } },
  };
}

module.exports = {
  SCAN_PIPELINE_VERSION,
  SCAN_SOURCES,
  extractAlertsArray,
  isScanCachePayloadValid,
  scanPipelineCacheSuffix,
  compactScanPayload,
  enrichScanPayload,
  hydrateScanPayload,
};
