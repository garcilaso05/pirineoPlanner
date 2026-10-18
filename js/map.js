import { BASE_LAYERS, WMT, TYPES, DAY_COLORS, ROUTE_COLORS, REFUGE_COLORS } from './config.js';
import { state, hooks, addItem, setOrigin, dayIndex, km } from './itinerary.js';
import { el, toast, askForm, setHint, $ } from './ui.js';
import { simplify, projectOnLine, sliceLine } from './geo.js';
import { perf, coarse } from './perf.js';

/* ---------- Mapa, capas base y capas superpuestas ---------- */
const PYRENEES = L.latLngBounds([41.0, -5.5], [43.95, 7.6]);
export const map = L.map('map', {
  renderer: L.canvas({ tolerance: coarse ? 12 : 6 }), // un único canvas: ligero y con clics tolerantes
  maxBounds: PYRENEES, maxBoundsViscosity: 1,
  zoomControl: false, attributionControl: true,
  zoomAnimation: !(coarse && perf.tier === 0), fadeAnimation: perf.tier > 0, markerZoomAnimation: perf.tier > 0,
  wheelPxPerZoomLevel: 90, tapTolerance: 18,
}).setView([42.7, 0.5], 8);
map.attributionControl.setPrefix(false);
if (!coarse) L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

const tileOpts = () => ({ updateWhenIdle: perf.tier < 2 || coarse, keepBuffer: perf.tier === 0 ? 1 : 2, updateInterval: 200 });
const base = {};
for (const [n, c] of Object.entries(BASE_LAYERS)) base[n] = L.tileLayer(c.url, { ...tileOpts(), ...c.opt });
let baseName = 'OpenStreetMap';
base[baseName].addTo(map);
export const baseNames = Object.keys(base);
export const currentBase = () => ({ name: baseName, cfg: BASE_LAYERS[baseName] });
export function setBase(name) {
  if (!base[name] || name === baseName) return;
  map.removeLayer(base[baseName]); base[name].addTo(map); base[name].bringToBack(); baseName = name;
}

export const G = {};
for (const k of ['routes', 'refuge', 'peak', 'lake', 'waterfall', 'it', 'draft']) G[k] = L.layerGroup().addTo(map);

// Registro de capas superpuestas: la leyenda del mapa (main.js) se construye a partir de aquí
export const OVERLAYS = [];
export function registerOverlay(key, label, layer, on = true) {
  OVERLAYS.push({ key, label, layer });
  if (on) map.addLayer(layer); else map.removeLayer(layer);
}
export function toggleOverlay(key, on) {
  const o = OVERLAYS.find((x) => x.key === key);
  if (!o || map.hasLayer(o.layer) === on) return;
  if (on) map.addLayer(o.layer); else map.removeLayer(o.layer);
  map.fire(on ? 'overlayadd' : 'overlayremove', { layer: o.layer, name: o.label });
}
registerOverlay('routes', 'Caminos principales', G.routes);
registerOverlay('peak', 'Picos', G.peak);
registerOverlay('lake', 'Lagos', G.lake);
registerOverlay('waterfall', 'Cascadas', G.waterfall);
registerOverlay('wmt', 'Senderos señalizados', L.tileLayer(WMT.url, { ...tileOpts(), ...WMT.opt }), false);
registerOverlay('it', 'Mi itinerario', G.it);

export function locateMe() {
  map.once('locationfound', (e) => { if (!PYRENEES.contains(e.latlng)) toast('Estás fuera de la zona del Pirineo que cubre el mapa.'); else map.flyTo(e.latlng, Math.max(map.getZoom(), 14)); });
  map.once('locationerror', () => toast('No se pudo obtener tu ubicación (revisa el permiso del navegador).'));
  map.locate({ enableHighAccuracy: false, timeout: 10000 });
}

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

/* ---------- Refugios (una sola fuente a la vez; nunca se mezclan) ---------- */
let refugeGen = 0;
export function clearRefuges() { refugeGen++; G.refuge.clearLayers(); }

let viewerMode = false, savedOverlays = [];
export function setViewerMode(on) {
  if (on === viewerMode) return;
  viewerMode = on;
  document.body.classList.toggle('viewer-mode', on);
  map.invalidateSize({ animate: false, pan: false }); // el contenedor acaba de cambiar de tamaño: remedir antes de encuadrar
  if (on) {
    savedOverlays = OVERLAYS.filter((o) => map.hasLayer(o.layer)).map((o) => o.key);
    OVERLAYS.forEach((o) => { if (o.key !== 'it') map.removeLayer(o.layer); });
    map.removeLayer(G.refuge);
    map.addLayer(G.it);
    try {
      const b = L.featureGroup(G.it.getLayers()).getBounds();
      if (b.isValid()) map.fitBounds(b, { padding: [60, 60], maxZoom: 14 });
    } catch { /* ignorar */ }
  } else {
    map.addLayer(G.refuge);
    OVERLAYS.forEach((o) => { if (savedOverlays.includes(o.key)) map.addLayer(o.layer); });
  }
  setTimeout(() => map.invalidateSize(), 60);
  setTimeout(() => map.invalidateSize(), 250);
}

/* ---------- Modos de interacción ---------- */
export const mode = { cur: 'none', frag: null, draw: null };
const PLACING = ['origin', 'newpeak', 'newlake', 'newwaterfall'];
const tap = coarse ? 'Toca' : 'Haz clic';
const HINTS = {
  origin: `${tap} en el mapa para fijar el punto de origen.`,
  newpeak: `${tap} en el mapa para crear un pico.`,
  newlake: `${tap} en el mapa para crear un lago.`,
  newwaterfall: `${tap} en el mapa para crear una cascada.`,
  fragment: `${tap} sobre un camino: primero el inicio y luego el final del fragmento.`,
  newroute: 'Haz clic en el mapa para ir añadiendo puntos del camino. Pulsa «Terminar camino» para guardarlo (Esc cancela).',
};
export function setMode(m) {
  mode.cur = m;
  mode.draw = m === 'newroute' ? [] : null;
  mode.drawLine = null;
  resetFragment();
  G.draft.clearLayers(); map.closePopup();
  const active = m === 'fragment' || m === 'newroute' || PLACING.includes(m);
  map.getContainer().classList.toggle('crosshair', active);
  map.doubleClickZoom[active ? 'disable' : 'enable'](); // evita que un doble toque zoomee y duplique el punto
  setHint(HINTS[m] || '');
  document.dispatchEvent(new CustomEvent('modechange', { detail: m }));
}
map.on('popupopen', () => { if (PLACING.includes(mode.cur)) map.closePopup(); });

/* ---------- Popups ---------- */
function popup(p, extra) {
  const T = TYPES[p.type];
  const urlLabel = p.url && p.url.includes('lacsdespyrenees.com') ? 'Ficha en Lacs des Pyrénées ↗' : 'Más información ↗';
  return el('div', { class: 'pop' },
    el('h4', {}, p.name),
    el('p', {}, [T.label, p.sub, p.ele ? `${Math.round(p.ele)} m` : null].filter(Boolean).join(' · ')),
    p.url ? el('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'poi-link' }, urlLabel) : null,
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => { addItem({ type: p.type, name: p.name, lat: p.lat, lng: p.lng, ele: p.ele }); map.closePopup(); } }, `＋ Añadir al Día ${dayIndex() + 1}`),
      extra));
}

/* ---------- Refugios ---------- */
// Marcador circular con una casita en su interior (mismo estilo que picos y lagos)
const HouseMarker = L.CircleMarker.extend({
  _updatePath() {
    const rd = this._renderer;
    if (!rd._drawing || this._empty()) return;
    const ctx = rd._ctx, { x, y } = this._point, r = this._radius;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); rd._fillStroke(ctx, this);
    const w = r * 0.52, cy = y + r * 0.08;
    ctx.beginPath();
    ctx.moveTo(x, cy - w * 1.05); ctx.lineTo(x + w * 1.05, cy - w * 0.1); ctx.lineTo(x + w * 0.62, cy - w * 0.1);
    ctx.lineTo(x + w * 0.62, cy + w * 0.85); ctx.lineTo(x - w * 0.62, cy + w * 0.85); ctx.lineTo(x - w * 0.62, cy - w * 0.1);
    ctx.lineTo(x - w * 1.05, cy - w * 0.1); ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.fill();
  },
});
const cats = new Map();
export function addRefuges(points) {
  const gen = ++refugeGen; // si cambia la fuente a mitad de carga, este lote se aborta
  G.refuge.clearLayers();
  let index = 0;
  const tips = perf.profile.tooltips && !coarse;
  return new Promise((resolve) => {
    const addBatch = () => {
      if (gen !== refugeGen) return resolve();
      const end = Math.min(index + (perf.tier === 0 ? 60 : 150), points.length);
      for (; index < end; index++) {
        const p = points[index];
        const cat = p.sub || p.data?.type_hebergement || 'Refugio';
        if (!cats.has(cat)) cats.set(cat, REFUGE_COLORS[cats.size % REFUGE_COLORS.length]);
        const url = (p.desc?.match(/https?:\/\/\S+/) || [])[0];
        const m = new HouseMarker([p.lat, p.lng], { radius: coarse ? 14 : 12, color: '#ffffff', weight: 2, fillColor: cats.get(cat), fillOpacity: 0.95 });
        if (tips) m.bindTooltip(p.name || cat, { direction: 'top' });
        m.bindPopup(() => popup({ type: 'refuge', name: p.name || 'Refugio', sub: cat, lat: p.lat, lng: p.lng, ele: p.ele, url }));
        G.refuge.addLayer(m);
      }
      if (index < points.length) requestAnimationFrame(addBatch); else resolve();
    };
    addBatch();
  });
}

/* ---------- Caminos estáticos ---------- */
let routeCount = 0;
const drawnRoutes = [];
export function addRoute({ title, segments, drawn = false }) {
  const route = { title, color: ROUTE_COLORS[routeCount++ % ROUTE_COLORS.length], segments, drawn };
  if (drawn) drawnRoutes.push({ title, segments: segments.map((s) => ({ name: s.name, pts: s.pts })) }); // los caminos dibujados viajan en el archivo exportado
  for (const seg of segments) {
    if (!seg.pts || seg.pts.length < 2) continue;
    seg.km = km([seg.pts]);
    // seg.pts conserva TODAS las coordenadas (se usan para recortar); solo se dibuja la versión simplificada
    const line = L.polyline(simplify(seg.pts), { color: route.color, weight: 4, opacity: 0.85, smoothFactor: 1.5 });
    if (!coarse) line.on('mouseover', () => line.setStyle({ weight: 7 })).on('mouseout', () => line.setStyle({ weight: 4 }));
    line.on('click', (ev) => onTrackClick(route, seg, ev));
    G.routes.addLayer(line);
    registerSegment(route, seg, line);
  }
}
export const customRoutes = () => drawnRoutes.map((r) => ({ title: r.title, segments: r.segments.map((s) => ({ name: s.name, pts: s.pts })) }));
export const restoreRoutes = (routes) => routes.forEach((r) => addRoute({ title: r.title, segments: r.segments, drawn: true }));

/* ---------- Dibujar un camino propio haciendo clic (solo escritorio) ---------- */
export function finishDrawRoute() {
  const pts = (mode.draw || []).map((p) => [+p.lat.toFixed(6), +p.lng.toFixed(6)]);
  if (pts.length < 2) return toast('Marca al menos dos puntos en el mapa.');
  askForm('Nuevo camino', [{ name: 'name', label: 'Nombre', value: 'Mi camino', required: true }]).then((f) => {
    if (!f) return;
    addRoute({ title: f.name.trim(), segments: [{ name: 'Tramo 1', pts }], drawn: true });
    setMode('none');
    toast('Camino creado. Haz clic en él para añadirlo o recortarlo.');
  });
}

function trackPopup(route, seg) {
  const all = route.segments.map((s) => s.pts);
  return el('div', { class: 'pop' },
    el('h4', {}, route.title), el('p', {}, `${seg.name} · ${seg.km.toFixed(1)} km`),
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => { addItem({ type: 'track', name: `${route.title} · ${seg.name}`, lat: seg.pts[0][0], lng: seg.pts[0][1], lines: [seg.pts] }); map.closePopup(); } }, `＋ Tramo completo al Día ${dayIndex() + 1}`)),
    el('div', { class: 'row' },
      el('button', { onclick: () => { setMode('fragment'); } }, '✂ Elegir fragmento'),
      route.segments.length > 1 ? el('button', { onclick: () => { addItem({ type: 'track', name: `${route.title} (ruta completa)`, lat: all[0][0][0], lng: all[0][0][1], lines: all }); map.closePopup(); } }, `Ruta entera (${route.segments.length})`) : null));
}
export function onTrackClick(route, seg, ev) {
  // En modo fragmento el clic lo gestiona el mapa (fragmentClick), que es más tolerante
  if (mode.cur === 'none') L.popup({ autoPanPaddingTopLeft: [10, 70], autoPanPaddingBottomRight: [10, 90] }).setLatLng(ev.latlng).setContent(trackPopup(route, seg)).openOn(map);
}

/* ---------- Herramienta de fragmentos (tijeras) ---------- */
// Registro de todos los tramos visibles (estáticos y dinámicos): se elige el más cercano al toque
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
const PICK_PX = coarse ? 34 : 18; // el dedo es mucho menos preciso que el ratón
const FRAG_COLOR = '#d4532f';

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

const pin = (pt, color) => L.circleMarker(pt, { radius: coarse ? 10 : 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false }).addTo(G.draft);
function resetFragment() {
  mode.frag = null;
  G.draft.clearLayers();
  document.body.classList.remove('frag-pending');
  if (mode.cur === 'fragment') setHint(HINTS.fragment);
}
export function cancelFragmentStart() { if (mode.frag) { resetFragment(); return true; } return false; }

function startFragment(route, seg, pr) {
  G.draft.clearLayers();
  pin(pr.point, '#16a34a');
  const preview = L.polyline([pr.point], { color: FRAG_COLOR, weight: 6, opacity: 0.9, dashArray: '2 8', interactive: false }).addTo(G.draft);
  mode.frag = { route, seg, a: pr, b: null, preview, endPin: null };
  document.body.classList.remove('frag-pending');
  setHint(`${tap} ahora el punto final (mismo camino).`);
}
function setFragmentEnd(pr) {
  const f = mode.frag;
  const pts = sliceLine(f.seg.pts, f.a, pr);
  f.b = pr;
  f.preview.setLatLngs(pts).setStyle({ dashArray: null, weight: 7 });
  f.endPin?.remove(); f.endPin = pin(pr.point, FRAG_COLOR);
  const len = km([pts]);
  $('#frag-info').textContent = `${len.toFixed(2)} km`;
  document.body.classList.add('frag-pending');
  setHint('Toca otro punto para mover el final, o confirma con ✓.');
}
function commitFragment(pr) {
  const f = mode.frag;
  const pts = sliceLine(f.seg.pts, f.a, pr); // geometría completa, no simplificada
  if (pts.length < 2 || km([pts]) < 0.003) return toast('Elige un punto final distinto del inicio.');
  const { route, seg } = f;
  resetFragment();
  addItem({ type: 'track', name: `${route.title} · ${seg.name} (fragmento)`, lat: pts[0][0], lng: pts[0][1], lines: [pts] });
}
export function confirmFragment() { if (mode.frag?.b) commitFragment(mode.frag.b); }

let lastFragClick = 0;
function fragmentClick(ll) {
  const now = performance.now();
  if (now - lastFragClick < 300) return; // doble toque: ignorar el segundo
  lastFragClick = now;
  const f = mode.frag;
  const hit = pickSegment(ll, f?.seg);
  if (!hit) return toast('No hay ningún camino cerca de ese punto. Toca sobre el trazado.');
  const { e, pr } = hit;
  if (!f || f.seg !== e.seg) {
    if (f) toast('Ese punto es de otro tramo: se ha fijado un nuevo inicio ahí.');
    return startFragment(e.route, e.seg, pr);
  }
  if (coarse) return setFragmentEnd(pr); // en táctil el final se confirma con ✓ (evita añadir por un toque accidental)
  commitFragment(pr);
}

// Vista previa del fragmento mientras se mueve el ratón (no existe en táctil)
let previewRaf = 0, previewAt = 0;
map.on('mousemove', (ev) => {
  const f = mode.frag;
  if (coarse || mode.cur !== 'fragment' || !f || previewRaf) return;
  const now = performance.now();
  if (now - previewAt < perf.profile.mouseMs) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0; previewAt = performance.now();
    if (mode.frag !== f) return;
    const pr = projectOnLine(f.seg.pts, ev.latlng);
    const near = pr && pr.d <= 60 * metersPerPixel(ev.latlng.lat);
    f.preview.setLatLngs(near ? sliceLine(f.seg.pts, f.a, pr) : [f.a.point]);
  });
});

/* ---------- Picos y lagos (índice + personalizados) ---------- */
const poiIndex = new Map();
const CK = 'senda.custom.v1';
let custom = [];
const saveCustom = () => { try { localStorage.setItem(CK, JSON.stringify(custom.map(({ marker, ...p }) => p))); } catch { /* ignorar */ } };
const SRC = { osm: 'OpenStreetMap', custom: 'Personalizado' };
function pinIcon(p) {
  return L.divIcon({ className: '', html: `<div class="pin ${p.type}${p.src === 'custom' ? ' custom' : ''}">${TYPES[p.type].glyph}</div>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12] });
}
function addPoi(p) {
  if (poiIndex.has(p.key)) return false;
  const del = p.src === 'custom' ? el('button', {
    class: 'danger', onclick: () => {
      G[p.type].removeLayer(p.marker); poiIndex.delete(p.key); custom = custom.filter((c) => c.key !== p.key); saveCustom(); map.closePopup();
    },
  }, 'Eliminar') : null;
  p.marker = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.name, keyboard: false });
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
    if (!mode.drawLine) mode.drawLine = L.polyline([], { color: '#f2b134', weight: 4, dashArray: '6 5', interactive: false }).addTo(G.draft);
    mode.drawLine.addLatLng(e.latlng); // se añade solo el punto nuevo (sin redibujar todo)
    L.circleMarker(e.latlng, { radius: 4, color: '#f2b134', fillOpacity: 1, interactive: false }).addTo(G.draft);
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
  const tol = perf.profile.simplifyPx * 360 / (256 * 2 ** 15); // solo visual; las coordenadas guardadas no se tocan
  const tips = perf.profile.tooltips && !coarse;
  state.days.forEach((d, di) => {
    const c = DAY_COLORS[di % DAY_COLORS.length];
    let prev = null;
    d.items.forEach((it, i) => {
      const s = it.lines ? it.lines[0][0] : [it.lat, it.lng];
      const e = it.lines ? it.lines.at(-1).at(-1) : s;
      if (prev && map.distance(prev, s) > 50) L.polyline([prev, s], { color: c, weight: 3, dashArray: '6 8', opacity: 0.8, interactive: false }).addTo(G.it);
      if (it.lines) it.lines.forEach((l) => L.polyline(simplify(l, tol), { color: c, weight: 6, opacity: 0.95, interactive: false }).addTo(G.it));
      const mk = L.marker(s, { icon: L.divIcon({ className: '', html: `<div class="it-pin" style="background:${c}">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 500, keyboard: false });
      if (tips) mk.bindTooltip(`Día ${di + 1} · ${it.name}`);
      // El contenido (con fotos) se construye solo al abrir el popup
      mk.bindPopup(() => {
        const photos = it.photos || [];
        const content = el('div', { class: 'pop' }, el('h4', {}, it.name), el('p', {}, `Día ${di + 1} · ${it.type === 'track' ? `${(it.km || 0).toFixed(1)} km` : TYPES[it.type]?.label || it.type}`));
        if (photos.length) content.append(...photos.map((photo) => el('img', { class: 'photo', src: photo.data, alt: photo.name || it.name, loading: 'lazy' })));
        return content;
      }).addTo(G.it);
      prev = e;
    });
  });
}
hooks.change.push(draw);
hooks.locate = (it) => {
  if (it.lines) map.fitBounds(L.polyline(it.lines).getBounds(), { padding: [40, 40] });
  else map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 13));
  document.dispatchEvent(new CustomEvent('locate-item')); // en móvil se pliega el panel para ver el mapa
};
export function fitAll() {
  const ls = G.routes.getLayers();
  if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds(), { padding: [30, 30] });
}
