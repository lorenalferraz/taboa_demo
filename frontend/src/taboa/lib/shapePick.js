import { SHAPE_FILE } from './constants.js';

/** Resolve o único GeoJSON em shape/ (faixa oficial 05/06/07). */
export function pickShapeFilename(filenames) {
  if (!filenames?.length) return null;
  const low = (s) => String(s).toLowerCase();
  const named = filenames.find((n) => low(n) === SHAPE_FILE.toLowerCase());
  if (named) return named;
  if (filenames.length === 1) return filenames[0];
  return null;
}
