import { BASE_LAYERS, WMT, TYPES, DAY_COLORS, ROUTE_COLORS, REFUGE_COLORS } from './config.js';
import { state, hooks, addItem, setOrigin, dayIndex, km } from './itinerary.js';
import { el, toast, askForm, $ } from './ui.js';
import { simplify, projectOnLine, sliceLine } from './geo.js';

// Un único renderer canvas (con tolerancia de clic) para que todas las capas vectoriales reciban eventos
const PYRENEES = L.latLngBounds([41.0, -5.5], [43.95, 7.6]);
export const map = L.map('map', { renderer: L.canvas({ tolerance: 6 }), maxBounds: PYRENEES, maxBoundsViscosity: 1 }).setView([42.7, 0.5], 8);
const base = {};
for (const [n, c] of Object.entries(BASE_LAYERS)) base[n] = L.tileLayer(c.url, c.opt);
base['OpenStreetMap'].addTo(map);
export const G = {};
for (const k of ['routes', 'refuge', 'peak', 'lake', 'waterfall', 'it', 'draft']) G[k] = L.layerGroup().addTo(map);
export const layerControl = L.control.layers(base, {
  'Caminos KML': G.routes, 'Refugios y cabañas': G.refuge, 'Picos': G.peak, 'Lagos': G.lake, 'Cascadas': G.waterfall,
  'Senderos (Waymarked Trails)': L.tileLayer(WMT.url, WMT.opt), 'Mi itinerario': G.it,
}, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

export function canLoadPois() { return map.getZoom() >= 12; }
export function poiBounds() { return map.getBounds().pad(0.25); }
export function clearLoadedPois() {
  let count = 0;
  ['peak', 'lake', 'waterfall'].forEach((type) => G[type].getLayers().slice().forEach((marker) => {
    const point = [...poiIndex.values()].find((p) => p.marker === marker);
    if (point?.src === 'custom') return;
    G[type].removeLayer(marker);
    if (point) poiIndex.delete(point.key);
    count++;
  }));
  return count;
}

export function clearRefuges() {
  G.refuge.clearLayers();
}

let viewerMode = false;
export function setViewerMode(on) {
  viewerMode = on;
  document.body.classList.toggle('viewer-mode', on);
  ['routes', 'refuge', 'peak', 'lake', 'waterfall'].forEach((name) => {
    if (G[name]) {
      if (on) map.removeLayer(G[name]);
      else map.addLayer(G[name]);
    }
  });
  // También ocultar las rutas dinámicas en modo visualizador
  import('./dynamic_loader.js').then(({ dynRoutesLayer }) => {
    if (dynRoutesLayer) {
      if (on) map.removeLayer(dynRoutesLayer);
      else map.addLayer(dynRoutesLayer);
    }
  }).catch(() => { });
  if (on) {
    map.addLayer(G.it);
    try {
      const layers = G.it.getLayers();
      if (layers.length) {
        const group = L.featureGroup(layers);
        const b = group.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [60, 60], maxZoom: 14 });
      }
    } catch { /* ignorar */ }
  } else {
    map.addLayer(G.it);
  }
  // Forzar recálculo del tamaño del viewport del mapa para evitar pantalla negra o encogimiento
  setTimeout(() => map.invalidateSize(), 50);
  setTimeout(() => map.invalidateSize(), 200);
}

/* ---------- Modos de interacción ---------- */
export const mode = { cur: 'none', frag: null };
const PLACING = ['origin', 'newpeak', 'newlake', 'newwaterfall'];
const HINTS = {
  origin: 'Haz clic en el mapa para fijar el punto de origen. Esc para cancelar.',
  newpeak: 'Haz clic en el mapa para crear un pico nuevo. Esc para cancelar.',
  newlake: 'Haz clic en el mapa para crear un lago nuevo. Esc para cancelar.',
  newwaterfall: 'Haz clic en el mapa para crear una cascada nueva. Esc para cancelar.',
  fragment: 'Haz clic cerca de un camino: 1.º el inicio y 2.º el final del fragmento. Esc cancela el inicio / sale.',
  newroute: 'Haz clic para añadir vértices. Pulsa «Terminar camino» cuando acabes.',
};
export function setMode(m) {
  mode.cur = m; mode.frag = null;
  mode.draw = m === 'newroute' ? [] : null;
  G.draft.clearLayers(); map.closePopup();
  map.getContainer().classList.toggle('crosshair', m !== 'none');
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  const h = $('#hint'); h.textContent = HINTS[m] || ''; h.hidden = !HINTS[m];
}
map.on('popupopen', () => { if (PLACING.includes(mode.cur)) map.closePopup(); });

/* ---------- Popups ---------- */
function popup(p, extra) {
  const T = TYPES[p.type];
  const urlLabel = p.url && p.url.includes('lacsdespyrenees.com')
    ? '🔗 Ficha en Lacs des Pyrénées ↗'
    : '🔗 Más información ↗';
  return el('div', { class: 'pop' },
    el('h4', {}, p.name),
    el('p', {}, [T.label, p.sub, p.ele ? `${Math.round(p.ele)} m` : null].filter(Boolean).join(' · ')),
    p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'poi-link' }, urlLabel) : null,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => { addItem({ type: p.type, name: p.name, lat: p.lat, lng: p.lng, ele: p.ele }); map.closePopup(); } }, `＋ Añadir al Día ${dayIndex() + 1}`),
      extra));
}

/* ---------- Refugios ---------- */
// Marcador en forma de círculo con casa en el interior (estilo idéntico a picos y lagos)
const HouseMarker = L.CircleMarker.extend({
  _updatePath() {
    const rd = this._renderer;
    if (!rd._drawing || this._empty()) return;
    const ctx = rd._ctx, { x, y } = this._point, r = this._radius;
    // 1. Círculo exterior coloreado con borde blanco
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    rd._fillStroke(ctx, this);

    // 2. Icono de casita blanca centrada
    const w = r * 0.52;
    const cy = y + r * 0.08;
    ctx.beginPath();
    ctx.moveTo(x, cy - w * 1.05);
    ctx.lineTo(x + w * 1.05, cy - w * 0.1);
    ctx.lineTo(x + w * 0.62, cy - w * 0.1);
    ctx.lineTo(x + w * 0.62, cy + w * 0.85);
    ctx.lineTo(x - w * 0.62, cy + w * 0.85);
    ctx.lineTo(x - w * 0.62, cy - w * 0.1);
    ctx.lineTo(x - w * 1.05, cy - w * 0.1);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  },
});
const cats = new Map();
export function addRefuges(points) {
  let index = 0;
  return new Promise((resolve) => {
    const addBatch = () => {
      const end = Math.min(index + 150, points.length);
      for (; index < end; index++) {
        const p = points[index];
        const cat = p.sub || p.data?.type_hebergement || 'Refugio';
        if (!cats.has(cat)) cats.set(cat, REFUGE_COLORS[cats.size % REFUGE_COLORS.length]);
        const url = (p.desc?.match(/https?:\/\/\S+/) || [])[0];
        const m = new HouseMarker([p.lat, p.lng], { radius: 12, color: '#ffffff', weight: 2, fillColor: cats.get(cat), fillOpacity: 0.95 });
        m.bindTooltip(p.name || cat, { direction: 'top' });
        m.bindPopup(() => popup({ type: 'refuge', name: p.name || 'Refugio', sub: cat, lat: p.lat, lng: p.lng, ele: p.ele, url }));
        G.refuge.addLayer(m);
      }
      if (index < points.length) requestAnimationFrame(addBatch);
      else resolve();
    };
    addBatch();
  });
}

/* ---------- Caminos y selección de fragmentos ---------- */
let routeCount = 0;
const drawnRoutes = [];
export function addRoute({ title, segments, drawn = false }) {
  const route = { title, color: ROUTE_COLORS[routeCount++ % ROUTE_COLORS.length], segments, drawn };
  if (drawn) drawnRoutes.push({ title, segments: segments.map((segment) => ({ name: segment.name, pts: segment.pts })) });
  for (const seg of segments) {
    if (!seg.pts || seg.pts.length < 2) continue;
    seg.km = km([seg.pts]);
    // seg.pts conserva TODAS las coordenadas (se usan para recortar); solo se dibuja la versión simplificada
    const line = L.polyline(simplify(seg.pts), { color: route.color, weight: 4, opacity: 0.85, smoothFactor: 1.5 });
    line.on('mouseover', () => line.setStyle({ weight: 7 })).on('mouseout', () => line.setStyle({ weight: 4 }));
    line.on('click', (ev) => onTrackClick(route, seg, ev));
    G.routes.addLayer(line);
    registerSegment(route, seg, line);
  }
}
export function customRoutes() { return drawnRoutes.map((route) => ({ title: route.title, segments: route.segments })); }
export function restoreRoutes(routes) { routes.forEach((route) => addRoute({ ...route, drawn: true })); }
export async function finishDrawRoute() {
  if (!mode.draw || mode.draw.length < 2) return toast('Añade al menos dos puntos para crear el camino.');
  const result = await askForm('Guardar camino propio', [{ name: 'name', label: 'Nombre', value: 'Camino propio', required: true }]);
  if (!result) return;
  const pts = mode.draw.map((p) => [p.lat, p.lng]);
  G.draft.clearLayers();
  addRoute({ title: result.name.trim(), drawn: true, segments: [{ name: result.name.trim(), pts }] });
  setMode('none');
  toast(`«${result.name.trim()}» guardado. Ya puedes añadirlo a un día.`);
}
function trackPopup(route, seg) {
  const all = route.segments.map((s) => s.pts);
  return el('div', { class: 'pop' },
    el('h4', {}, route.title), el('p', {}, `${seg.name} · ${seg.km.toFixed(1)} km`),
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => { addItem({ type: 'track', name: `${route.title} · ${seg.name}`, lat: seg.pts[0][0], lng: seg.pts[0][1], lines: [seg.pts] }); map.closePopup(); } }, `＋ Tramo completo al Día ${dayIndex() + 1}`)),
    el('div', { class: 'row' },
      el('button', { onclick: () => { setMode('fragment'); toast(HINTS.fragment); } }, '✂️ Elegir fragmento'),
      el('button', { onclick: () => { addItem({ type: 'track', name: `${route.title} (ruta completa)`, lat: all[0][0][0], lng: all[0][0][1], lines: all }); map.closePopup(); } }, `Ruta entera (${route.segments.length} tramos)`)));
}
export function onTrackClick(route, seg, ev) {
  // En modo fragmento el clic lo gestiona el handler del mapa (fragmentClick), que es más tolerante
  if (mode.cur === 'none') L.popup().setLatLng(ev.latlng).setContent(trackPopup(route, seg)).openOn(map);
}

/* ---------- Herramienta de fragmentos (tijeras) ---------- */
// Registro de todos los tramos visibles (estáticos y dinámicos) para elegir el más cercano al clic
// sobre la geometría COMPLETA, sin depender de la polilínea simplificada ni del hit-test del canvas.
const segRegistry = new Map();
export function registerSegment(route, seg, layer) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of seg.pts) {
    if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0];
    if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
  }
  segRegistry.set(seg, { route, seg, layer, bbox: [a, b, c, d] });
}
export function unregisterSegment(seg) { segRegistry.delete(seg); }

const metersPerPixel = (lat) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** map.getZoom();
const PICK_PX = 18;

function pickSegment(ll, prefer) {
  const tol = PICK_PX * metersPerPixel(ll.lat);
  const k = Math.cos(ll.lat * Math.PI / 180);
  const dLat = tol / 111320, dLng = tol / (111320 * k);
  let best = null;
  for (const e of segRegistry.values()) {
    const [a, b, c, d] = e.bbox;
    if (ll.lat < a - dLat || ll.lat > c + dLat || ll.lng < b - dLng || ll.lng > d + dLng) continue;
    if (!map.hasLayer(e.layer)) continue;
    const pr = projectOnLine(e.seg.pts, ll);
    if (!pr || pr.d > tol) continue;
    if (e.seg === prefer) return { e, pr }; // continuar sobre el tramo ya iniciado
    if (!best || pr.d < best.pr.d) best = { e, pr };
  }
  return best;
}

function startFragment(route, seg, pr) {
  G.draft.clearLayers();
  L.circleMarker(pr.point, { radius: 8, color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1, interactive: false }).addTo(G.draft);
  const preview = L.polyline([pr.point], { color: '#16a34a', weight: 6, opacity: 0.9, dashArray: '2 8', interactive: false }).addTo(G.draft);
  mode.frag = { route, seg, a: pr, preview };
}

function fragmentClick(ll) {
  const f = mode.frag;
  const hit = pickSegment(ll, f?.seg);
  if (!hit) return toast('No hay ningún camino cerca de ese punto. Haz clic sobre el trazado.');
  const { e, pr } = hit;
  if (!f || f.seg !== e.seg) {
    toast(f ? 'Ese punto pertenece a otro tramo: se ha fijado un nuevo inicio ahí.' : 'Inicio fijado. Ahora haz clic en el punto final (mismo tramo).');
    return startFragment(e.route, e.seg, pr);
  }
  const pts = sliceLine(e.seg.pts, f.a, pr); // geometría completa, no simplificada
  if (pts.length < 2 || km([pts]) < 0.003) return toast('Elige un punto final distinto del inicio.');
  mode.frag = null; G.draft.clearLayers();
  addItem({ type: 'track', name: `${e.route.title} · ${e.seg.name} (fragmento)`, lat: pts[0][0], lng: pts[0][1], lines: [pts] });
}

// Vista previa del fragmento mientras se mueve el ratón
let previewRaf = 0;
map.on('mousemove', (ev) => {
  const f = mode.frag;
  if (mode.cur !== 'fragment' || !f || previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    if (mode.frag !== f) return;
    const pr = projectOnLine(f.seg.pts, ev.latlng);
    const near = pr && pr.d <= 60 * metersPerPixel(ev.latlng.lat);
    f.preview.setLatLngs(near ? sliceLine(f.seg.pts, f.a, pr) : [f.a.point]);
  });
});

/* ---------- Picos y lagos (API + personalizados) ---------- */
const poiIndex = new Map();
const CK = 'senda.custom.v1';
let custom = [];
const saveCustom = () => { try { localStorage.setItem(CK, JSON.stringify(custom.map(({ marker, ...p }) => p))); } catch { /* ignorar */ } };
const SRC = { osm: 'OpenStreetMap', custom: 'Personalizado' };
function pinIcon(p) {
  return L.divIcon({ className: '', html: `<div class="pin ${p.type}${p.src === 'custom' ? ' custom' : ''}">${TYPES[p.type].glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
}
function addPoi(p) {
  if (poiIndex.has(p.key)) return false;
  const del = p.src === 'custom' ? el('button', {
    class: 'danger', onclick: () => {
      G[p.type].removeLayer(p.marker); poiIndex.delete(p.key); custom = custom.filter((c) => c.key !== p.key); saveCustom(); map.closePopup();
    }
  }, 'Eliminar') : null;
  p.marker = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.name });
  p.marker.bindPopup(() => popup({ ...p, sub: p.sub || SRC[p.src] }, del));
  G[p.type].addLayer(p.marker);
  poiIndex.set(p.key, p);
  return true;
}
export function addPois(points, src = 'osm') {
  return points.reduce((n, p, i) => {
    const item = { ...p, key: p.key || `${src}:${p.type}:${p.lat}:${p.lng}:${i}`, src };
    const added = addPoi(item);
    if (added && src === 'custom' && !custom.some((c) => c.key === item.key)) custom.push(item);
    return n + (added ? 1 : 0);
  }, 0);
}
export function removePoiByKey(key) {
  const p = poiIndex.get(key);
  if (!p) return false;
  if (G[p.type] && p.marker) G[p.type].removeLayer(p.marker);
  poiIndex.delete(key);
  return true;
}
export function customPois() { return custom.map(({ marker, ...p }) => p); }
export function loadCustom() {
  try { custom = JSON.parse(localStorage.getItem(CK)) || []; } catch { custom = []; }
  custom.forEach(addPoi);
}
map.on('click', async (e) => {
  const m = mode.cur;
  if (m === 'fragment') return fragmentClick(e.latlng);
  if (m === 'newroute') {
    mode.draw.push(e.latlng);
    G.draft.clearLayers();
    L.polyline(mode.draw, { color: '#f2b134', weight: 4, dashArray: '6 5' }).addTo(G.draft);
    mode.draw.forEach((point) => L.circleMarker(point, { radius: 5, color: '#fff', weight: 2, fillColor: '#f2b134', fillOpacity: 1, interactive: false }).addTo(G.draft));
    return;
  }
  if (!PLACING.includes(m)) return;
  const T = { origin: ['Punto de origen', 'origin', 'Origen'], newpeak: ['Nuevo pico', 'peak', ''], newlake: ['Nuevo lago', 'lake', ''], newwaterfall: ['Nueva cascada', 'waterfall', ''] }[m];
  const f = await askForm(T[0], [
    { name: 'name', label: 'Nombre', value: T[2], required: true },
    { name: 'ele', label: 'Altitud en metros (opcional)', type: 'number' }]);
  if (!f) return;
  const p = { type: T[1], name: f.name.trim(), lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6), ele: f.ele ? +f.ele : null };
  setMode('none');
  if (m === 'origin') return setOrigin(p);
  Object.assign(p, { key: 'custom:' + Date.now(), src: 'custom' });
  custom.push(p); addPoi(p); saveCustom();
  p.marker.openPopup();
  toast(`${T[0]} guardado. Ya puedes añadirlo al itinerario.`);
});

/* ---------- Dibujo del itinerario ---------- */
function draw() {
  G.it.clearLayers();
  state.days.forEach((d, di) => {
    const c = DAY_COLORS[di % DAY_COLORS.length];
    let prev = null;
    d.items.forEach((it, i) => {
      const s = it.lines ? it.lines[0][0] : [it.lat, it.lng];
      const e = it.lines ? it.lines.at(-1).at(-1) : s;
      if (prev && map.distance(prev, s) > 50) L.polyline([prev, s], { color: c, weight: 3, dashArray: '6 8', opacity: 0.8, interactive: false }).addTo(G.it);
      if (it.lines) L.polyline(it.lines, { color: c, weight: 6, opacity: 0.95, interactive: false }).addTo(G.it);
      const photos = it.photos || [];
      const content = el('div', { class: 'pop' }, el('h4', {}, it.name), el('p', {}, `Día ${di + 1} · ${it.type === 'track' ? `${(it.km || 0).toFixed(1)} km` : TYPES[it.type]?.label || it.type}`));
      if (photos.length) content.append(el('p', {}, `${photos.length} foto${photos.length === 1 ? '' : 's'}`), ...photos.map((photo) => el('img', { class: 'photo', src: photo.data, alt: photo.name || it.name, loading: 'lazy' })));
      L.marker(s, { icon: L.divIcon({ className: '', html: `<div class="it-pin" style="background:${c}">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 500 })
        .bindTooltip(`Día ${di + 1} · ${it.name}`).bindPopup(content).addTo(G.it);
      prev = e;
    });
  });
}
hooks.change.push(draw);
hooks.locate = (it) => {
  if (it.lines) map.fitBounds(L.polyline(it.lines).getBounds(), { padding: [40, 40] });
  else map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 13));
};
export function fitAll() {
  const ls = G.routes.getLayers();
  if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds(), { padding: [30, 30] });
}
