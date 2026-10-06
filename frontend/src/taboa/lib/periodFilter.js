const PERIOD_MIN_YEAR = 2015;
const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Partes da data local do usuário (fuso do navegador). */
export function getLocalTodayParts() {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
  };
}

/** YYYY-MM-DD na data local do usuário. */
export function localTodayStr() {
  const { year, month, day } = getLocalTodayParts();
  return `${year}-${month}-${day}`;
}

export function lastDayOfMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

export function periodMinDate() {
  return `${PERIOD_MIN_YEAR}-01-01`;
}

function isoFromParts(year, month, day) {
  const maxDay = lastDayOfMonth(year, month);
  const d = Math.min(Number(day) || 1, maxDay);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseIso(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: m[1], month: m[2], day: m[3] };
}

function clampIso(value, { min, max } = {}) {
  const parts = parseIso(value);
  if (!parts) return min || periodMinDate();
  let iso = isoFromParts(parts.year, parts.month, parts.day);
  if (min && iso < min) iso = min;
  if (max && iso > max) iso = max;
  return iso;
}

function formatDatePt(iso) {
  const parts = parseIso(iso);
  if (!parts) return '—';
  const month = MONTHS_PT[Number(parts.month) - 1] || parts.month;
  return `${parts.day} ${month} ${parts.year}`;
}

function formatDuration(startIso, endIso) {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (!start || !end) return '';
  const s = new Date(`${startIso}T00:00:00`);
  const e = new Date(`${endIso}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return '';
  const days = Math.round((e - s) / 86400000) + 1;
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) months -= 1;
  months = Math.max(0, months);
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const unit = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let span = '';
  if (years && rem) span = `${unit(years, 'ano', 'anos')} e ${unit(rem, 'mês', 'meses')}`;
  else if (years) span = unit(years, 'ano', 'anos');
  else if (rem) span = unit(rem, 'mês', 'meses');
  else span = unit(days, 'dia', 'dias');
  return `${span} · ${days.toLocaleString('pt-BR')} ${days === 1 ? 'dia' : 'dias'}`;
}

function addMonths(iso, delta) {
  const parts = parseIso(iso) || getLocalTodayParts();
  const d = new Date(Number(parts.year), Number(parts.month) - 1 + delta, Number(parts.day));
  return isoFromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function addYears(iso, delta) {
  return addMonths(iso, delta * 12);
}

const PRESETS = {
  since2020: () => ({ start: '2020-01-01', end: localTodayStr() }),
  thisYear: () => ({ start: `${getLocalTodayParts().year}-01-01`, end: localTodayStr() }),
  last12: () => ({ start: addYears(localTodayStr(), -1), end: localTodayStr() }),
  last5y: () => ({ start: addYears(localTodayStr(), -5), end: localTodayStr() }),
  all: () => ({ start: periodMinDate(), end: localTodayStr() }),
};

function presetMatches(id, start, end) {
  const fn = PRESETS[id];
  if (!fn) return false;
  const p = fn();
  return p.start === start && p.end === end;
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getRangeFromInputs() {
  const today = localTodayStr();
  const min = periodMinDate();
  let start = clampIso(document.getElementById('periodStart')?.value, { min, max: today });
  let end = clampIso(document.getElementById('periodEnd')?.value, { min, max: today });
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

function updatePeriodUi(start, end) {
  const startLabel = document.getElementById('periodStartLabel');
  const endLabel = document.getElementById('periodEndLabel');
  const summary = document.getElementById('periodSummary');
  if (startLabel) startLabel.textContent = formatDatePt(start);
  if (endLabel) endLabel.textContent = formatDatePt(end);
  if (summary) summary.textContent = formatDuration(start, end);

  document.querySelectorAll('[data-period-preset]').forEach((btn) => {
    const active = presetMatches(btn.dataset.periodPreset, start, end);
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

export function applyPeriodRange(startIso, endIso) {
  const today = localTodayStr();
  const min = periodMinDate();
  let start = clampIso(startIso, { min, max: today });
  let end = clampIso(endIso, { min, max: today });
  if (start > end) [start, end] = [end, start];

  const startEl = document.getElementById('periodStart');
  const endEl = document.getElementById('periodEnd');
  if (startEl) {
    startEl.min = min;
    startEl.max = end;
    startEl.value = start;
  }
  if (endEl) {
    endEl.min = start;
    endEl.max = today;
    endEl.value = end;
  }
  setInputValue('startDate', start);
  setInputValue('endDate', end);
  updatePeriodUi(start, end);
  return { start, end };
}

export function applyPeriodPreset(id) {
  const fn = PRESETS[id];
  if (!fn) return null;
  const { start, end } = fn();
  return applyPeriodRange(start, end);
}

/** Sincroniza seletores visíveis → inputs ocultos startDate / endDate. */
export function syncPeriodInputs() {
  const { start, end } = getRangeFromInputs();
  applyPeriodRange(start, end);
}

export function setPeriodEndToToday() {
  const { start } = getRangeFromInputs();
  applyPeriodRange(start || '2020-01-01', localTodayStr());
}

export function setPeriodStartDefaults() {
  applyPeriodRange('2020-01-01', localTodayStr());
}

function bindPeriodUi() {
  const root = document.getElementById('periodStart')?.closest('.fs-section');
  if (!root || root.dataset.periodBound === '1') return;
  root.dataset.periodBound = '1';

  const startEl = document.getElementById('periodStart');
  const endEl = document.getElementById('periodEnd');
  const onChange = () => syncPeriodInputs();
  startEl?.addEventListener('change', onChange);
  endEl?.addEventListener('change', onChange);

  document.querySelectorAll('[data-period-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPeriodPreset(btn.dataset.periodPreset));
  });
}

export function initPeriodFilter() {
  bindPeriodUi();
  applyPeriodRange('2020-01-01', localTodayStr());
}

export function resetPeriodFilter() {
  applyPeriodPreset('since2020');
}
