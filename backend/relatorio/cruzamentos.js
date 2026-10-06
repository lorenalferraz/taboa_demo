/**
 * Cruzamentos da área de consulta com camadas locais TABOA.
 * Sem @turf/turf: na Vercel esse pacote quebra ao carregar kdbush (ESM).
 */
function asGeom(g) {
  if (!g) return null;
  if (g.type === 'Feature') return g.geometry || null;
  if (g.geometry?.type) return g.geometry;
  return g.type ? g : null;
}

function walkCoords(geom, fn) {
  const g = asGeom(geom);
  if (!g?.coordinates) return;
  const t = g.type;
  if (t === 'Point') fn(g.coordinates);
  else if (t === 'MultiPoint' || t === 'LineString') g.coordinates.forEach(fn);
  else if (t === 'MultiLineString' || t === 'Polygon') g.coordinates.forEach((r) => r.forEach(fn));
  else if (t === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => r.forEach(fn)));
}

function geomBbox(geom) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  walkCoords(geom, (c) => {
    const x = Number(c[0]);
    const y = Number(c[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const R = 6378137;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const lng1 = Number(ring[i][0]) * Math.PI / 180;
    const lat1 = Number(ring[i][1]) * Math.PI / 180;
    const lng2 = Number(ring[i + 1][0]) * Math.PI / 180;
    const lat2 = Number(ring[i + 1][1]) * Math.PI / 180;
    sum += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(sum * R * R / 2);
}

function geomAreaHa(geom) {
  const g = asGeom(geom);
  if (!g) return 0;
  const polys = g.type === 'Polygon' ? [g.coordinates]
    : g.type === 'MultiPolygon' ? g.coordinates
      : null;
  if (!polys) return 0;
  let m2 = 0;
  for (const rings of polys) {
    if (!rings?.length) continue;
    m2 += ringAreaM2(rings[0]);
    for (let i = 1; i < rings.length; i++) m2 -= ringAreaM2(rings[i]);
  }
  return Math.max(0, m2 / 10000);
}

function pointInRing(pt, ring) {
  const x = pt[0];
  const y = pt[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInGeom(pt, geom) {
  const g = asGeom(geom);
  if (!g) return false;
  if (g.type === 'Point') {
    return Math.abs(Number(g.coordinates[0]) - pt[0]) < 1e-8
      && Math.abs(Number(g.coordinates[1]) - pt[1]) < 1e-8;
  }
  const polys = g.type === 'Polygon' ? [g.coordinates]
    : g.type === 'MultiPolygon' ? g.coordinates
      : null;
  if (!polys) return false;
  return polys.some((rings) => {
    if (!rings?.[0] || !pointInRing(pt, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(pt, rings[i])) return false;
    }
    return true;
  });
}

function sampleRing(ring, max) {
  if (!ring || ring.length <= max) return ring || [];
  const step = Math.ceil(ring.length / max);
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  return out;
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ringsOf(geom) {
  const g = asGeom(geom);
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates || [];
  if (g.type === 'MultiPolygon') return (g.coordinates || []).flat();
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates || [];
  return [];
}

function geometriesIntersect(a, b) {
  const ga = asGeom(a);
  const gb = asGeom(b);
  if (!ga || !gb) return false;
  if (!bboxesOverlap(geomBbox(ga), geomBbox(gb))) return false;
  if (ga.type === 'Point') return pointInGeom(ga.coordinates, gb);
  if (gb.type === 'Point') return pointInGeom(gb.coordinates, ga);
  let inside = false;
  walkCoords(ga, (c) => { if (!inside && pointInGeom(c, gb)) inside = true; });
  if (inside) return true;
  walkCoords(gb, (c) => { if (!inside && pointInGeom(c, ga)) inside = true; });
  if (inside) return true;
  const ra = ringsOf(ga).map((ring) => sampleRing(ring, 80));
  const rb = ringsOf(gb).map((ring) => sampleRing(ring, 80));
  for (const ringA of ra) {
    for (let i = 0; i < ringA.length - 1; i++) {
      for (const ringB of rb) {
        for (let j = 0; j < ringB.length - 1; j++) {
          if (segmentsCross(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
        }
      }
    }
  }
  return false;
}

function taboaShape() {
  const g = global.__TABOA_SHAPE__;
  if (g && typeof g.loadFeaturesByBbox === 'function') return g;
  return require('../localShapeLoader');
}

function shapeFn(name) {
  const mod = taboaShape();
  const fn = mod && (mod[name] || (mod.default && mod.default[name]));
  if (typeof fn === 'function') return fn;
  throw new Error(`${name} is not a function`);
}

const UC_SOURCES = [
  {
    file: 'uc_federais.geojson',
    esfera: 'Federal',
    nameKeys: ['nome', 'nome_uc'],
    fill: '#5eead4',
    stroke: '#0f766e',
    legend: 'UC federal',
  },
  {
    file: 'uc_estaduais.geojson',
    esfera: 'Estadual',
    nameKeys: ['nome_ofici', 'nome_uc', 'nome'],
    fill: '#93c5fd',
    stroke: '#1d4ed8',
    legend: 'UC estadual',
  },
  {
    file: 'uc_municipais.geojson',
    esfera: 'Municipal',
    nameKeys: ['nome_uc', 'nome'],
    fill: '#c4b5fd',
    stroke: '#6d28d9',
    legend: 'UC municipal',
  },
];

const LAYERS = [
  {
    id: 'uc',
    files: UC_SOURCES,
    label: 'Unidades de Conservação',
    sub: 'Federais, estaduais e municipais',
    fill: '#5eead4',
    stroke: '#0f766e',
    legend: 'Unidade de Conservação',
  },
  {
    id: 'reserva_legal',
    file: 'reserva_legal.geojson',
    label: 'Reserva legal',
    sub: '',
    nameKeys: ['TIPO', 'tipo', 'IDE_IMOVEL'],
    fill: '#86efac',
    stroke: '#166534',
    legend: 'Reserva legal',
  },
  {
    id: 'app',
    file: 'app.geojson',
    label: 'Áreas de preservação permanente',
    sub: '',
    nameKeys: ['TIPO', 'tipo', 'IDE_IMOVEL'],
    fill: '#67e8f9',
    stroke: '#0e7490',
    legend: 'APP',
  },
  {
    id: 'terra_indigena',
    file: 'indigenas.geojson',
    label: 'Terras indígenas',
    sub: '',
    nameKeys: ['terrai_nom', 'nome'],
    fill: '#34d399',
    stroke: '#059669',
    legend: 'Terras indígenas',
  },
  {
    id: 'quilombo',
    file: 'quilombolas.geojson',
    label: 'Terras quilombolas',
    sub: '',
    nameKeys: ['nm_comunid', 'nome'],
    fill: '#f9a8d4',
    stroke: '#be185d',
    legend: 'Terras quilombolas',
  },
];

function bboxesOverlap(a, b) {
  if (!a || !b) return true;
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function featureName(feat, keys) {
  const p = feat?.properties || {};
  for (const k of keys) {
    const v = p[k];
    if (v != null && String(v).trim()) {
      return String(v).trim().replace(/^["']+|["']+$/g, '');
    }
  }
  return 'Área identificada';
}

function nomeCarInema(feat, layer) {
  const p = feat?.properties || {};
  const tipo = featureName(feat, layer.nameKeys || []);
  const ide = p.IDE_IMOVEL != null && String(p.IDE_IMOVEL).trim() ? String(p.IDE_IMOVEL).trim() : '';
  if (ide && tipo && tipo !== 'Área identificada') return `${tipo} · imóvel ${ide}`;
  if (ide) return `Imóvel ${ide}`;
  return tipo;
}

function formatHaPt(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ha`;
}

function formatPctPt(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const v = n < 0.1 && n > 0 ? n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${v}%`;
}

function nomePropriedade(props, imoveisById) {
  const p = props || {};
  const ide = p.IDE_IMOVEL != null ? String(p.IDE_IMOVEL).trim() : '';
  const im = ide ? imoveisById.get(ide) : null;
  const nome = String(im?.DENOMINACA || '').trim().replace(/^["']+|["']+$/g, '');
  if (nome) return nome;
  if (ide) return `Imóvel ${ide}`;
  return 'Imóvel rural';
}

function areaReservaHa(feat) {
  const n = Number(feat?.properties?.AREA_DECLA);
  if (Number.isFinite(n) && n > 0) return n;
  try {
    return geomAreaHa(feat);
  } catch (_) {
    return 0;
  }
}

async function loadImoveisById(aoiBbox) {
  const map = new Map();
  try {
    const fc = await shapeFn('loadFeaturesByBbox')('imoveis_rurais.geojson', aoiBbox, 0);
    for (const f of fc.features || []) {
      const p = f.properties || {};
      const ide = p.IDE_IMOVEL != null ? String(p.IDE_IMOVEL).trim() : '';
      if (!ide || map.has(ide)) continue;
      map.set(ide, p);
    }
  } catch (_) {}
  return map;
}

function foldTxt(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function grupoUc(props = {}) {
  const raw = [
    props.siglagrupo, props.grupo, props.grupo_1, props.grupo_snuc,
    props.categoria, props.categori_1,
  ].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean);
  for (const v of raw) {
    const n = foldTxt(v);
    if (n === 'pi' || n.includes('protecao integral')) {
      return { code: 'PI', label: 'PI — Proteção integral' };
    }
    if (n === 'us' || n.includes('uso sustent')) {
      return { code: 'US', label: 'US — Uso sustentável' };
    }
  }
  const n = foldTxt(raw.join(' '));
  if (/parque|estacao ecol|reserva biol|monumento natural|refugio/.test(n)) {
    return { code: 'PI', label: 'PI — Proteção integral' };
  }
  if (/\bapa\b|arie|rppn|rds\b|resex|floresta nacional|reserva de desenvolvimento|area de protecao ambiental/.test(n)) {
    return { code: 'US', label: 'US — Uso sustentável' };
  }
  return null;
}

function formatUcNome(nome, grupo) {
  if (!grupo?.label) return nome;
  return `${nome} (${grupo.label})`;
}

function asFeature(geom) {
  if (!geom) return null;
  if (geom.type === 'Feature') return geom;
  if (geom.geometry) return geom;
  if (geom.type && geom.coordinates) return { type: 'Feature', properties: {}, geometry: geom };
  return null;
}

function clipAreaHa(aoiFeat, other) {
  try {
    const boxA = geomBbox(aoiFeat);
    const boxB = geomBbox(other);
    if (!boxA || !boxB || !bboxesOverlap(boxA, boxB)) return 0;
    const box = [
      Math.max(boxA[0], boxB[0]),
      Math.max(boxA[1], boxB[1]),
      Math.min(boxA[2], boxB[2]),
      Math.min(boxA[3], boxB[3]),
    ];
    const n = 18;
    let inside = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lng = box[0] + ((box[2] - box[0]) * (i + 0.5)) / n;
        const lat = box[1] + ((box[3] - box[1]) * (j + 0.5)) / n;
        if (pointInGeom([lng, lat], aoiFeat) && pointInGeom([lng, lat], other)) inside += 1;
      }
    }
    if (!inside) return 0;
    return geomAreaHa({
      type: 'Polygon',
      coordinates: [[
        [box[0], box[1]],
        [box[2], box[1]],
        [box[2], box[3]],
        [box[0], box[3]],
        [box[0], box[1]],
      ]],
    }) * (inside / (n * n));
  } catch (_) {
    return 0;
  }
}

function compactGeom(geom) {
  const g = asGeom(geom);
  if (!g) return null;
  const round = (n) => Math.round(Number(n) * 1e5) / 1e5;
  const slim = (ring) => {
    const pts = sampleRing(ring, 240).map((c) => [round(c[0]), round(c[1])]);
    if (pts.length >= 3) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) pts.push(a);
    }
    return pts;
  };
  try {
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: (g.coordinates || []).map(slim) };
    if (g.type === 'MultiPolygon') {
      return {
        type: 'MultiPolygon',
        coordinates: (g.coordinates || []).map((poly) => poly.map(slim)),
      };
    }
    return g;
  } catch (_) {
    return g;
  }
}

async function cruzarCamada(aoiFeat, aoiBbox, layer) {
  const sources = layer.files || (layer.file ? [{
    file: layer.file,
    nameKeys: layer.nameKeys,
    fill: layer.fill,
    stroke: layer.stroke,
    legend: layer.legend,
  }] : []);
  const hits = [];
  let areaHa = 0;
  let aoiHa = 0;
  try { aoiHa = geomAreaHa(aoiFeat); } catch (_) {}
  const imoveisById = layer.id === 'reserva_legal' ? await loadImoveisById(aoiBbox) : null;
  for (const src of sources) {
    let fc;
    try {
      fc = await shapeFn('loadFeaturesByBbox')(src.file, aoiBbox, 0);
    } catch (_) {
      continue;
    }
    for (const f of fc.features || []) {
      if (!f?.geometry) continue;
      let fb = null;
      try { fb = geomBbox(f); } catch (_) {}
      if (fb && !bboxesOverlap(fb, aoiBbox)) continue;
      let intersects = false;
      try {
        intersects = geometriesIntersect(aoiFeat, f);
      } catch (_) {
        continue;
      }
      if (!intersects) continue;
      const ha = clipAreaHa(aoiFeat, f);
      areaHa += ha;
      const isUc = layer.id === 'uc';
      const grupo = isUc ? grupoUc(f.properties || {}) : null;
      let nome;
      if (layer.id === 'reserva_legal') {
        const prop = nomePropriedade(f.properties || {}, imoveisById || new Map());
        const rlHa = areaReservaHa(f);
        const pct = aoiHa > 0 ? (ha / aoiHa) * 100 : 0;
        nome = `${prop} — reserva legal de ${formatHaPt(rlHa)}, sobreposição de ${formatHaPt(ha)} (${formatPctPt(pct)})`;
      } else if (layer.id === 'app') {
        nome = nomeCarInema(f, layer);
      } else {
        nome = featureName(f, src.nameKeys || layer.nameKeys);
      }
      const withEsfera = src.esfera ? `${nome} · ${src.esfera}` : nome;
      const categoria = isUc
        ? featureName(f, ['sigla', 'categori_1', 'categoria', 'tipo'])
        : '';
      hits.push({
        nome,
        display: formatUcNome(withEsfera, grupo),
        grupo,
        esfera: src.esfera || '',
        categoria: categoria && categoria !== 'Área identificada' ? categoria : '',
        areaHa: ha,
        pct: aoiHa > 0 ? (ha / aoiHa) * 100 : 0,
        geometry: compactGeom(f.geometry),
        fill: src.fill || layer.fill,
        stroke: src.stroke || layer.stroke,
        legend: src.legend || layer.legend,
      });
    }
  }
  hits.sort((a, b) => (b.areaHa || 0) - (a.areaHa || 0));
  const grupos = [];
  const seenG = new Set();
  for (const h of hits) {
    const g = h.grupo?.label;
    if (!g || seenG.has(g)) continue;
    seenG.add(g);
    grupos.push(g);
  }
  const top = hits.slice(0, 8);
  return {
    id: layer.id,
    label: layer.label,
    sub: layer.sub,
    fill: layer.fill,
    stroke: layer.stroke,
    legend: layer.legend,
    hit: hits.length > 0,
    count: hits.length,
    areaHa,
    nomes: top.map((h) => h.display || h.nome),
    grupos,
    geoms: top.slice(0, 4).map((h) => h.geometry).filter(Boolean),
    overlays: top.slice(0, 6).filter((h) => h.geometry).map((h) => ({
      id: layer.id,
      legend: h.legend || layer.legend,
      fill: h.fill || layer.fill,
      stroke: h.stroke || layer.stroke,
      geom: h.geometry,
    })),
    ucs: layer.id === 'uc'
      ? hits.slice(0, 40).map((h) => ({
        esfera: h.esfera || '—',
        nome: h.nome || 'Unidade de Conservação',
        grupo: h.grupo?.label || h.grupo?.code || '—',
        categoria: h.categoria || '—',
        areaHa: h.areaHa,
        pct: h.pct,
      }))
      : [],
  };
}

/**
 * @param {object} aoiGeom GeoJSON geometry ou Feature
 */
async function cruzarAreaConsulta(aoiGeom) {
  const aoiFeat = asFeature(aoiGeom);
  if (!aoiFeat?.geometry) {
    return LAYERS.map((l) => ({
      id: l.id, label: l.label, sub: l.sub, fill: l.fill, stroke: l.stroke, legend: l.legend,
      hit: false, count: 0, areaHa: 0, nomes: [], grupos: [], geoms: [], overlays: [], ucs: [],
    }));
  }
  let aoiBbox = null;
  try { aoiBbox = geomBbox(aoiFeat); } catch (_) {}
  const out = [];
  for (const layer of LAYERS) {
    out.push(await cruzarCamada(aoiFeat, aoiBbox, layer));
  }
  return out;
}

async function identificarMunicipios(aoiGeom) {
  const aoiFeat = asFeature(aoiGeom);
  if (!aoiFeat?.geometry) return [];
  let fc;
  try {
    fc = await shapeFn('loadGeoJsonFile')('municipios.geojson');
  } catch (_) {
    return [];
  }
  let aoiBbox = null;
  try { aoiBbox = geomBbox(aoiFeat); } catch (_) {}
  const hits = [];
  for (const f of fc.features || []) {
    if (!f?.geometry) continue;
    let fb = null;
    try { fb = geomBbox(f); } catch (_) {}
    if (fb && aoiBbox && !bboxesOverlap(fb, aoiBbox)) continue;
    try {
      if (!geometriesIntersect(aoiFeat, f)) continue;
    } catch (_) {
      continue;
    }
    const p = f.properties || {};
    const nome = String(p.nomMun || p.nm_mun || p.municipio || p.nome || '').trim();
    const uf = String(p.sigla_uf || p.uf || 'BA').toUpperCase();
    if (!nome) continue;
    hits.push(`${nome}/${uf}`);
  }
  return [...new Set(hits)];
}

function dadosImovelRural(feat) {
  const p = feat?.properties || {};
  const nome = String(p.DENOMINACA || '').trim().replace(/^["']+|["']+$/g, '');
  const car = String(p.NUMERO_CAR || '').trim();
  const ide = p.IDE_IMOVEL != null ? String(p.IDE_IMOVEL).trim() : '';
  return {
    nome: nome || (ide ? `Imóvel ${ide}` : 'Imóvel rural'),
    car,
    ide,
  };
}

/**
 * Imóveis cujo IDE_IMOVEL aparece numa APP ou reserva legal que cruza a área.
 * Cobre o caso em que o ponto cai na APP/RL e o polígono do imóvel não contém o pino.
 */
async function imoveisLigadosARlApp(aoiGeom) {
  const aoiFeat = asFeature(aoiGeom);
  if (!aoiFeat?.geometry) return [];
  let aoiBbox = null;
  try { aoiBbox = geomBbox(aoiFeat); } catch (_) { return []; }
  const ides = new Set();
  for (const file of ['app.geojson', 'reserva_legal.geojson']) {
    let fc;
    try {
      fc = await shapeFn('loadFeaturesByBbox')(file, aoiBbox, 0);
    } catch (_) {
      continue;
    }
    for (const f of fc.features || []) {
      if (!f?.geometry) continue;
      const ide = String(f.properties?.IDE_IMOVEL ?? '').trim();
      if (!ide) continue;
      try {
        if (!geometriesIntersect(aoiFeat, f)) continue;
      } catch (_) {
        continue;
      }
      ides.add(ide);
    }
  }
  if (!ides.size) return [];
  let fc;
  try {
    fc = await shapeFn('loadFeaturesByBbox')('imoveis_rurais.geojson', aoiBbox, 0);
  } catch (_) {
    return [];
  }
  const hits = [];
  const seen = new Set();
  for (const f of fc.features || []) {
    if (!f?.geometry) continue;
    const meta = dadosImovelRural(f);
    if (!meta.ide || !ides.has(meta.ide) || seen.has(meta.ide)) continue;
    seen.add(meta.ide);
    hits.push({ ...meta, pct: null, geometry: f.geometry || null });
  }
  return hits;
}

/**
 * Imóvel(is) rurais para Informações cadastrais.
 * Ponto: o polígono que contém a coordenada. Se o pino não cair dentro de nenhum,
 * usa o imóvel ligado à APP ou à reserva legal que cruza o buffer.
 * Polígono: todos os imóveis cruzados, com % da área analisada.
 */
async function identificarImoveisCadastrais({ aoiGeom, point, isPoint } = {}) {
  if (isPoint) {
    const lng = Number(Array.isArray(point) ? point[0] : point?.lng ?? point?.lon);
    const lat = Number(Array.isArray(point) ? point[1] : point?.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const pad = 0.003;
    const bbox = [lng - pad, lat - pad, lng + pad, lat + pad];
    let fc;
    try {
      fc = await shapeFn('loadFeaturesByBbox')('imoveis_rurais.geojson', bbox, 0);
    } catch (_) {
      return imoveisLigadosARlApp(aoiGeom);
    }
    for (const f of fc.features || []) {
      if (!f?.geometry) continue;
      try {
        if (!pointInGeom([lng, lat], f)) continue;
      } catch (_) {
        continue;
      }
      return [{ ...dadosImovelRural(f), pct: null, geometry: f.geometry || null }];
    }
    return imoveisLigadosARlApp(aoiGeom);
  }

  const aoiFeat = asFeature(aoiGeom);
  if (!aoiFeat?.geometry) return [];
  let aoiBbox = null;
  let aoiHa = 0;
  try { aoiBbox = geomBbox(aoiFeat); } catch (_) {}
  try { aoiHa = geomAreaHa(aoiFeat); } catch (_) {}
  let fc;
  try {
    fc = await shapeFn('loadFeaturesByBbox')('imoveis_rurais.geojson', aoiBbox, 0);
  } catch (_) {
    return [];
  }
  const hits = [];
  const seen = new Set();
  for (const f of fc.features || []) {
    if (!f?.geometry) continue;
    let fb = null;
    try { fb = geomBbox(f); } catch (_) {}
    if (fb && aoiBbox && !bboxesOverlap(fb, aoiBbox)) continue;
    try {
      if (!geometriesIntersect(aoiFeat, f)) continue;
    } catch (_) {
      continue;
    }
    const meta = dadosImovelRural(f);
    const key = meta.ide || meta.car || meta.nome;
    if (seen.has(key)) continue;
    seen.add(key);
    const ha = clipAreaHa(aoiFeat, f);
    if (!(ha > 0)) continue;
    const pct = aoiHa > 0 ? (ha / aoiHa) * 100 : 0;
    hits.push({ ...meta, ha, pct, geometry: f.geometry || null });
  }
  hits.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  if (hits.length) return hits;
  return imoveisLigadosARlApp(aoiFeat);
}

async function identificarRlAppDoImovel(imoveis) {
  const list = Array.isArray(imoveis) ? imoveis : [];
  const ides = new Set(list.map((im) => String(im?.ide || '').trim()).filter(Boolean));
  if (!ides.size) return { rl: [], app: [] };
  const geoms = list.map((im) => im.geometry).filter(Boolean);
  let bbox = null;
  try {
    if (geoms.length) {
      bbox = geoms.reduce((acc, g) => {
        const b = geomBbox(g);
        if (!b) return acc;
        if (!acc) return b;
        return [
          Math.min(acc[0], b[0]),
          Math.min(acc[1], b[1]),
          Math.max(acc[2], b[2]),
          Math.max(acc[3], b[3]),
        ];
      }, null);
    }
  } catch (_) {}
  const pick = async (file) => {
    let fc;
    try {
      fc = await shapeFn('loadFeaturesByBbox')(file, bbox, 0);
    } catch (_) {
      return [];
    }
    return (fc.features || []).filter((f) => {
      const ide = String(f.properties?.IDE_IMOVEL || '').trim();
      return ide && ides.has(ide) && f.geometry;
    });
  };
  const [rl, app] = await Promise.all([
    pick('reserva_legal.geojson'),
    pick('app.geojson'),
  ]);
  return { rl, app };
}

exports.cruzarAreaConsulta = cruzarAreaConsulta;
exports.identificarMunicipios = identificarMunicipios;
exports.identificarImoveisCadastrais = identificarImoveisCadastrais;
exports.identificarRlAppDoImovel = identificarRlAppDoImovel;
exports.LAYERS = LAYERS;
