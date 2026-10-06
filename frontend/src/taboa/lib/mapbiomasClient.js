import {
  MAPBIOMAS_CLIENT_API_URL,
  MAPBIOMAS_GRAPHQL_TIMEOUT_MS,
  MAPBIOMAS_MAX_RETRIES,
  MAPBIOMAS_RETRY_BASE_MS
} from './constants.js';
import { MAPBIOMAS_ALERT_COLLECTION_GQL } from './mapbiomasAlertMeta.js';

export function delayMapbiomas(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMapbiomasNonRetryableError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  return (
    m.includes('usuário ou senha incorretos') ||
    m.includes('usuario ou senha incorretos') ||
    m.includes('senha incorret') ||
    m.includes('invalid password') ||
    m.includes('invalid credentials') ||
    m.includes('token de acesso inválido') ||
    m.includes('unauthorized') ||
    m.includes('unauthenticated')
  );
}

export async function graphqlClient(query, variables, token, onRetryStatus) {
  const headers = { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) };
  let lastErr;
  for (let attempt = 0; attempt < MAPBIOMAS_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), MAPBIOMAS_GRAPHQL_TIMEOUT_MS);
    try {
      const res = await fetch(MAPBIOMAS_CLIENT_API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (_) {
        throw new Error(`MapBiomas: resposta não-JSON (HTTP ${res.status}).`);
      }
      if (!res.ok) {
        const msg = json?.errors?.[0]?.message || text.slice(0, 200);
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      if (json.errors) throw new Error(json.errors[0]?.message || 'Erro GraphQL');
      return json.data;
    } catch (e) {
      lastErr = e;
      if (isMapbiomasNonRetryableError(e)) throw e;
      if (attempt < MAPBIOMAS_MAX_RETRIES - 1) {
        const hint = String(e.message || e).slice(0, 100);
        if (onRetryStatus) onRetryStatus(`MapBiomas instável · tentativa ${attempt + 2}/${MAPBIOMAS_MAX_RETRIES} em breve… (${hint})`);
        await delayMapbiomas(MAPBIOMAS_RETRY_BASE_MS * Math.pow(2, attempt));
      }
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr;
}

export async function signInClient(email, password, onRetryStatus) {
  const data = await graphqlClient(
    `mutation signIn($email: String!, $password: String!) { signIn(email: $email, password: $password) { token } }`,
    { email, password },
    null,
    onRetryStatus
  );
  return data.signIn.token;
}

export async function fetchAlertsPageClient(token, { page, limit, startDate, endDate, boundingBox, territoryIds, territoryCategory }, onRetryStatus) {
  const tIds = Array.isArray(territoryIds)
    ? territoryIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const vars = {
    page,
    limit: Math.min(Number(limit) || 500, 2000),
    startDate: startDate || '2020-01-01',
    endDate: endDate || new Date().toISOString().slice(0, 10),
    dateType: 'DetectedAt',
    statusName: 'published',
    territoryIds: tIds,
    territoryCategory: tIds.length && territoryCategory ? territoryCategory : null,
    boundingBox: tIds.length ? [] : (boundingBox && boundingBox.length === 4 ? boundingBox : [])
  };
  const data = await graphqlClient(
    `query alerts($page:Int,$limit:Int,$startDate:BaseDate,$endDate:BaseDate,$dateType:DateTypes,$statusName:String,$territoryIds:[Int!],$territoryCategory:String,$boundingBox:[Float!]){
      alerts(page:$page,limit:$limit,startDate:$startDate,endDate:$endDate,dateType:$dateType,statusName:$statusName,territoryIds:$territoryIds,territoryCategory:$territoryCategory,boundingBox:$boundingBox){
        collection{ ${MAPBIOMAS_ALERT_COLLECTION_GQL} }
        metadata{ totalCount }
      }
    }`,
    vars,
    token,
    onRetryStatus
  );
  return data.alerts;
}

export async function fetchAllAlertsClient(token, opts, onProgress, onRetryStatus) {
  const limit = Math.min(Number(opts.limit) || 500, 2000);
  const all = [];
  let page = 1;
  let totalCount = null;
  const maxPages = 100;
  let lastPageError = null;
  let lastColLength = 0;
  while (page <= maxPages) {
    if (onProgress) onProgress({ page, totalCount, fetched: all.length, partial: !!lastPageError });
    try {
      const res = await fetchAlertsPageClient(token, { ...opts, page, limit }, onRetryStatus);
      const col = res.collection || [];
      lastColLength = col.length;
      all.push(...col);
      const meta = res.metadata || {};
      if (totalCount == null) totalCount = meta.totalCount ?? 0;
      if (col.length < limit || (totalCount > 0 && all.length >= totalCount)) break;
      page++;
    } catch (e) {
      lastPageError = e;
      break;
    }
  }
  const hitPageCap = page > maxPages;
  const incompleteByTotal = totalCount > 0 && all.length < totalCount;
  const mayHaveMorePages = lastColLength === limit && !lastPageError;
  const partial = !!lastPageError || incompleteByTotal || (hitPageCap && mayHaveMorePages);
  return {
    collection: all,
    metadata: {
      totalCount: totalCount ?? all.length,
      partial,
      lastError: lastPageError ? String(lastPageError.message || lastPageError) : null
    }
  };
}

import { alertHitsFaixaPlanningArea } from './alertsIntersect.js';

function filterAlertsInMunicipio(collection, munFeats) {
  if (!munFeats?.length) return collection || [];
  const fc = { type: 'FeatureCollection', features: munFeats };
  return (collection || []).filter((a) => alertHitsFaixaPlanningArea(a, fc));
}

/** MapBiomas por território IBGE + filtro nos limites municipais do shape. */
export async function fetchAlertsForMunicipioClient(token, opts, onProgress, onRetryStatus) {
  const { ibgeId, munBbox, munFeats, startDate, endDate, limit } = opts;
  const base = { startDate, endDate, limit: limit || 500 };

  if (ibgeId) {
    const byTerritory = await fetchAllAlertsClient(token, {
      ...base,
      territoryIds: [Number(ibgeId)],
      territoryCategory: 'municipality',
      boundingBox: null,
    }, onProgress, onRetryStatus);
    const rawCol = byTerritory.collection || [];
    const filtered = filterAlertsInMunicipio(rawCol, munFeats);
    if (filtered.length > 0) {
      return { ...byTerritory, collection: filtered, filterMode: 'territory+mun_geom' };
    }
    if (rawCol.length > 0) {
      return { ...byTerritory, collection: filtered, filterMode: 'territory+mun_geom_empty' };
    }
  }
  const byBbox = await fetchAllAlertsClient(token, {
    ...base,
    territoryIds: [],
    territoryCategory: null,
    boundingBox: munBbox,
  }, onProgress, onRetryStatus);
  const filtered = filterAlertsInMunicipio(byBbox.collection, munFeats);
  return { ...byBbox, collection: filtered, filterMode: 'bbox+mun_geom' };
}
