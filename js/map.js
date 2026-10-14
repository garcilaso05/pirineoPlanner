import { BASE_LAYERS, WMT, TYPES, DAY_COLORS, ROUTE_COLORS, REFUGE_COLORS } from './config.js';
import { state, hooks, addItem, setOrigin, dayIndex, km } from './itinerary.js';
import { el, toast, askForm, $ } from './ui.js';

// Un único renderer canvas (con tolerancia de clic) para que todas las capas vectoriales reciban eventos
const PYRENEES = L.latLngBounds([41.0, -5.5], [43.95, 7.6]);
export const map = L.map('map', { renderer: L.canvas({ tolerance: 6 }), maxBounds: PYRENEES, maxBoundsViscosity: 1 }).setView([42.7, 0.5], 8);
const base = {};
for (const [n, c] of Object.entries(BASE_LAYERS)) base[n] = L.tileLayer(c.url, c.opt);
base['OpenStreetMap'].addTo(map);
export const G = {};
for (const k of ['routes', 'refuge', 'peak', 'lake', 'it', 'draft']) G[k] = L.layerGroup().addTo(map);
L.control.layers(base, {
  'Caminos KML': G.routes, 'Refugios y cabañas': G.refuge, 'Picos': G.peak, 'Lagos': G.lake,
  'Senderos (Waymarked Trails)': L.tileLayer(WMT.url, WMT.opt), 'Mi itinerario': G.it,
}, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

export function canLoadPois() { return map.getZoom() >= 11; }
export function poiBounds() { return map.getBounds().pad(0.25); }
export function clearLoadedPois() {
  let count = 0;
  ['peak', 'lake'].forEach((type) => G[type].getLayers().slice().forEach((marker) => {
    const point = [...poiIndex.values()].find((p) => p.marker === marker);
    if (point?.src !== 'custom') { G[type].removeLayer(marker); poiIndex.delete(point.key); count++; }
  }));
  return count;
}

let viewerMode = false;
export function setViewerMode(on) {
  viewerMode = on;
  document.body.classList.toggle('viewer-mode', on);
  ['routes', 'refuge', 'peak', 'lake'].forEach((name) => { if (on) map.removeLayer(G[name]); else map.addLayer(G[name]); });
  if (on) map.addLayer(G.it); else map.addLayer(G.it);
}

/* ---------- Modos de interacción ---------- */
export const mode = { cur: 'none', frag: null };
const PLACING = ['origin', 'newpeak', 'newlake'];
const HINTS = {
  origin: 'Haz clic en el mapa para fijar el punto de origen. Esc para cancelar.',
  newpeak: 'Haz clic en el mapa para crear un pico nuevo. Esc para cancelar.',
  newlake: 'Haz clic en el mapa para crear un lago nuevo. Esc para cancelar.',
  fragment: 'Haz clic en un camino: 1.º el inicio y 2.º el final del fragmento. Esc para salir.',
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
  return el('div', { class: 'pop' },
    el('h4', {}, p.name),
    el('p', {}, [T.label, p.sub, p.ele ? `${Math.round(p.ele)} m` : null].filter(Boolean).join(' · ')),
    p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'Más información ↗') : null,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => { addItem({ type: p.type, name: p.name, lat: p.lat, lng: p.lng, ele: p.ele }); map.closePopup(); } }, `＋ Añadir al Día ${dayIndex() + 1}`),
      extra));
}

/* ---------- Refugios ---------- */
// Marcador en forma de casa dibujado en el canvas (rápido incluso con +1600 refugios)
const HouseMarker = L.CircleMarker.extend({
  _updatePath() {
    const rd = this._renderer;
    if (!rd._drawing || this._empty()) return;
    const ctx = rd._ctx, { x, y } = this._point, r = this._radius;
    ctx.beginPath();
    [[0, -r], [r, -0.1 * r], [0.68 * r, -0.1 * r], [0.68 * r, 0.85 * r], [-0.68 * r, 0.85 * r], [-0.68 * r, -0.1 * r], [-r, -0.1 * r]]
      .forEach(([dx, dy], i) => (i ? ctx.lineTo(x + dx, y + dy) : ctx.moveTo(x + dx, y + dy)));
    ctx.closePath();
    rd._fillStroke(ctx, this);
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
    const cat = p.data.type_hebergement || 'Refugio';
    if (!cats.has(cat)) cats.set(cat, REFUGE_COLORS[cats.size % REFUGE_COLORS.length]);
    const url = (p.desc.match(/https?:\/\/\S+/) || [])[0];
    const m = new HouseMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 1.5, fillColor: cats.get(cat), fillOpacity: 0.95 });
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
function simplify(points, tolerance = 0.00012) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const sq = (p, a, b) => {
    const x = b[1] - a[1], y = b[0] - a[0];
    if (!x && !y) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    const t = Math.max(0, Math.min(1, ((p[1] - a[1]) * x + (p[0] - a[0]) * y) / (x * x + y * y)));
    return (p[0] - (a[0] + t * y)) ** 2 + (p[1] - (a[1] + t * x)) ** 2;
  };
  const visit = (first, last) => {
    let best = tolerance * tolerance, index = -1;
    for (let i = first + 1; i < last; i++) { const distance = sq(points[i], points[first], points[last]); if (distance > best) { best = distance; index = i; } }
    if (index >= 0) { keep[index] = 1; visit(first, index); visit(index, last); }
  };
  visit(0, points.length - 1);
  return points.filter((_, i) => keep[i]);
}
export function addRoute({ title, segments, drawn = false }) {
  const route = { title, color: ROUTE_COLORS[routeCount++ % ROUTE_COLORS.length], segments, drawn };
  if (drawn) drawnRoutes.push({ title, segments: segments.map((segment) => ({ name: segment.name, pts: segment.pts })) });
  for (const seg of segments) {
    seg.km = km([seg.pts]);
    const line = L.polyline(simplify(seg.pts), { color: route.color, weight: 4, opacity: 0.85, smoothFactor: 1.5 });
    line.on('mouseover', () => line.setStyle({ weight: 7 })).on('mouseout', () => line.setStyle({ weight: 4 }));
    line.on('click', (ev) => onTrackClick(route, seg, ev));
    G.routes.addLayer(line);
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
function nearest(pts, ll) {
  const k = Math.cos(ll.lat * Math.PI / 180);
  let bi = 0, bd = Infinity;
  pts.forEach((p, i) => { const d = (p[0] - ll.lat) ** 2 + ((p[1] - ll.lng) * k) ** 2; if (d < bd) { bd = d; bi = i; } });
  return bi;
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
function onTrackClick(route, seg, ev) {
  if (mode.cur === 'fragment') {
    const i = nearest(seg.pts, ev.latlng);
    if (!mode.frag || mode.frag.seg !== seg) {
      mode.frag = { seg, i };
      G.draft.clearLayers();
      L.circleMarker(seg.pts[i], { radius: 8, color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1, interactive: false }).addTo(G.draft);
      toast('Inicio fijado. Ahora haz clic en el punto final (mismo tramo).');
    } else {
      const a = mode.frag.i;
      if (a === i) return toast('Elige un punto final distinto del inicio.');
      const pts = seg.pts.slice(Math.min(a, i), Math.max(a, i) + 1);
      if (i < a) pts.reverse(); // respeta el sentido de marcha elegido
      mode.frag = null; G.draft.clearLayers();
      addItem({ type: 'track', name: `${route.title} · ${seg.name} (fragmento)`, lat: pts[0][0], lng: pts[0][1], lines: [pts] });
    }
  } else if (mode.cur === 'none') {
    L.popup().setLatLng(ev.latlng).setContent(trackPopup(route, seg)).openOn(map);
  }
}

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
  const del = p.src === 'custom' ? el('button', { class: 'danger', onclick: () => {
    G[p.type].removeLayer(p.marker); poiIndex.delete(p.key); custom = custom.filter((c) => c.key !== p.key); saveCustom(); map.closePopup();
  } }, 'Eliminar') : null;
  p.marker = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.name });
  p.marker.bindPopup(() => popup({ ...p, sub: SRC[p.src] }, del));
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
export function customPois() { return custom.map(({ marker, ...p }) => p); }
export function loadCustom() {
  try { custom = JSON.parse(localStorage.getItem(CK)) || []; } catch { custom = []; }
  custom.forEach(addPoi);
}
map.on('click', async (e) => {
  const m = mode.cur;
  if (m === 'newroute') {
    mode.draw.push(e.latlng);
    G.draft.clearLayers();
    L.polyline(mode.draw, { color: '#f2b134', weight: 4, dashArray: '6 5' }).addTo(G.draft);
    mode.draw.forEach((point) => L.circleMarker(point, { radius: 5, color: '#fff', weight: 2, fillColor: '#f2b134', fillOpacity: 1, interactive: false }).addTo(G.draft));
    return;
  }
  if (!PLACING.includes(m)) return;
  const T = { origin: ['Punto de origen', 'origin', 'Origen'], newpeak: ['Nuevo pico', 'peak', ''], newlake: ['Nuevo lago', 'lake', ''] }[m];
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
