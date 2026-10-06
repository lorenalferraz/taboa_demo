import { STORAGE_KEY } from './constants.js';

export function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

export function saveCreds(email, password) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ email, password })); } catch (_) {}
}

export function clearCreds() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}
