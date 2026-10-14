export const BASE_LAYERS = {
  'OpenStreetMap': { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { maxZoom: 19, attribution: '© OpenStreetMap contributors' } },
  'OpenTopoMap': { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opt: { maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)' } },
  'CyclOSM': { url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', opt: { maxZoom: 20, subdomains: 'abc', attribution: '© CyclOSM | © OpenStreetMap contributors' } },
  'Esri Topo': { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, attribution: 'Tiles © Esri' } },
  'Satélite (Esri)': { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { maxZoom: 19, attribution: 'Tiles © Esri' } },
};
export const WMT = { url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', opt: { maxZoom: 18, opacity: 0.8, attribution: '© waymarkedtrails.org' } };
export const DAY_COLORS = ['#e4572e', '#2e86de', '#8e44ad', '#16a085', '#d35400', '#c2185b', '#5d6d00'];
export const ROUTE_COLORS = ['#e67e22', '#d63384', '#0d9488', '#6d28d9', '#a16207'];
export const REFUGE_COLORS = ['#b45309', '#7c3aed', '#0f766e', '#be185d', '#4d7c0f', '#475569'];
export const TYPES = {
  origin: { label: 'Origen', glyph: '⚑', color: '#16a34a' },
  peak: { label: 'Pico', glyph: '▲', color: '#c0392b' },
  lake: { label: 'Lago', glyph: '💧', color: '#1c7fb8' },
  refuge: { label: 'Refugio', glyph: '⌂', color: '#b45309' },
  track: { label: 'Camino', glyph: '〰', color: '#6d28d9' },
};

// Camptocamp rechaza (400, sin cabeceras CORS) las peticiones de navegador desde orígenes que no tiene en su lista blanca
// (GitHub Pages, localhost...). Se prueba primero directo y, si falla, estos proxies CORS (se recuerda el que funcione).
// Para máxima fiabilidad, despliega tu propio proxy (p. ej. Cloudflare Worker) y ponlo el primero: 'https://tu-worker.workers.dev/?url='
export const C2C_PROXIES = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='];
// Espejos de Overpass: si uno devuelve 504/timeout se prueba el siguiente
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
