/**
 * Candidatos de cruzamento — apenas assentamentos no mapa local.
 */
export async function fetchLocalCruzamentoCandidates() {
  return { ok: true, candidates: [], total: 0 };
}

export const fetchWfsCruzamentoCandidates = fetchLocalCruzamentoCandidates;
