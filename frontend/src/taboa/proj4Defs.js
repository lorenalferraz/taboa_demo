/** Definições EPSG brasileiras usadas no mapa e na leitura de KML. */
export function registerProj4Defs(proj4) {
  if (!proj4) return;

  const utmS = (z, ellps, towgs) => {
    const datum = towgs ? ` +towgs84=${towgs}` : '';
    return `+proj=utm +zone=${z} +south +ellps=${ellps}${datum} +units=m +no_defs`;
  };
  const utmN = (z, ellps, towgs) => {
    const datum = towgs ? ` +towgs84=${towgs}` : '';
    return `+proj=utm +zone=${z} +north +ellps=${ellps}${datum} +units=m +no_defs`;
  };

  const sirgas = '0,0,0,0,0,0,0';
  const sad69 = '-67.35,3.88,-38.22,0,0,0,0';

  const define = (code, def) => {
    try { proj4.defs(code, def); } catch (_) {}
  };

  for (let z = 18; z <= 25; z += 1) {
    define(`EPSG:${31960 + z}`, utmS(z, 'GRS80', sirgas)); // 31978–31985 SIRGAS 2000
    define(`EPSG:${32700 + z}`, utmS(z, 'WGS84', '0,0,0,0,0,0,0')); // 32718–32725
    define(`EPSG:${32600 + z}`, utmN(z, 'WGS84', '0,0,0,0,0,0,0')); // 32618–32625
    define(`EPSG:${29150 + z}`, utmS(z, 'aust_SA', sad69)); // 29168–29175 SAD69
    define(`EPSG:${29170 + z}`, utmS(z, 'aust_SA', sad69)); // 29188–29195 SAD69
  }

  define('EPSG:4674', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');
  define('EPSG:4618', `+proj=longlat +ellps=aust_SA +towgs84=${sad69} +no_defs`);
  define('EPSG:4225', '+proj=longlat +ellps=intl +towgs84=-206,172,-6,0,0,0,0 +no_defs');
  define('EPSG:4989', '+proj=geocent +ellps=GRS80 +units=m +no_defs');
  define(
    'EPSG:5880',
    `+proj=poly +lat_0=0 +lon_0=-54 +x_0=5000000 +y_0=10000000 +ellps=GRS80 +towgs84=${sirgas} +units=m +no_defs`,
  );
  define(
    'EPSG:29101',
    `+proj=poly +lat_0=0 +lon_0=-54 +x_0=5000000 +y_0=10000000 +ellps=aust_SA +towgs84=${sad69} +units=m +no_defs`,
  );
  define('EPSG:3857', '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs');
  define('EPSG:900913', proj4.defs('EPSG:3857'));
}
