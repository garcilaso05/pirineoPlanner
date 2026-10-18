import { map, setMode, mode, addRoute, addRefuges, clearRefuges, addPois, restoreRoutes, loadCustom, fitAll, canLoadPois, clearLoadedPois, setViewerMode, OVERLAYS, toggleOverlay, baseNames, setBase, currentBase, locateMe, customPois, confirmFragment, cancelFragmentStart } from './map.js';
import { load, changed, addDay, clearAll, toGPX, metadata, setMetadata, addPhoto, snapshot, restore, setSaveEnabled } from './itinerary.js';
import { parseKML } from './kml.js';
import { $, $$, el, toast, askForm, confirmDialog, initMenus, closeMenus, loadScript } from './ui.js';
import { initDynamicLoader, clearDynamicPois, loadZonePoisPriority } from './dynamic_loader.js';
import { perf, coarse } from './perf.js';

const seasons = ['Primavera', 'Verano', 'Otoño', 'Invierno'];
const refugesCache = new Map();
const lazyExport = () => import('./export.js');
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
const mobileMq = matchMedia('(max-width: 760px)');

/* ---------- Preferencias de la interfaz (se recuerdan entre visitas) ---------- */
const PK = 'senda.ui.v1';
let prefs = { base: 'OpenStreetMap', overlays: {}, refuge: 'pyrenees', saver: false };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PK)) }; } catch { /* ignorar */ }
const savePrefs = () => { try { localStorage.setItem(PK, JSON.stringify(prefs)); } catch { /* ignorar */ } };

/* ---------- KML estáticos (caminos base) ---------- */
async function listKml(dir) {
  const files = new Set();
  let listed = false;
  try {
    const m = await (await fetch('manifest.json')).json();
    if (Array.isArray(m[dir])) { listed = true; m[dir].forEach((f) => files.add(f.includes('/') ? f : `${dir}/${f}`)); }
  } catch { /* sin manifest */ }
  if (listed) return [...files];
  try {
    const r = await fetch(`${dir}/`);
    if (!r.ok) throw new Error('sin índice');
    const t = await r.text();
    for (const m of t.matchAll(/href="([^"?#]+\.kml)"/gi)) files.add(`${dir}/${decodeURIComponent(m[1]).split('/').pop()}`);
  } catch { /* sin índice */ }
  return [...files];
}
function addKmlRoute(kml) {
  const segments = kml.lines.map((l, i) => ({ name: l.name || `Tramo ${i + 1}`, pts: l.pts }));
  if (segments.length) addRoute({ title: kml.title, segments });
  return segments.length;
}
async function loadStaticRoute(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  addKmlRoute(parseKML(await r.text(), url.split('/').pop()));
}

/* ---------- Refugios: ninguno · Pyrenees · + Pirineos (nunca se mezclan) ---------- */
const REFUGE_FILES = { pyrenees: 'refugios/pyrenees.kml', pirineos: 'refugios/refugios_pirineo.kml' };
const REFUGE_LABEL = { pyrenees: 'Pyrenees (enlaces fiables)', pirineos: '+ Pirineos (más cobertura)' };
async function getRefugePoints(key) {
  if (refugesCache.has(key)) return refugesCache.get(key);
  const file = REFUGE_FILES[key];
  const r = await fetch(file);
  if (!r.ok) throw new Error(`Error al descargar ${file} (${r.status})`);
  const kml = parseKML(await r.text(), file.split('/').pop(), { stitch: false });
  refugesCache.set(key, kml.points);
  return kml.points;
}
let refugeToken = 0;
async function switchRefuges(key, { quiet = false } = {}) {
  prefs.refuge = key; savePrefs();
  const token = ++refugeToken;
  clearRefuges();
  if (key === 'none') return;
  try {
    const points = await getRefugePoints(key);
    if (token !== refugeToken) return; // el usuario ya cambió de fuente
    await addRefuges(points);
    if (!quiet && token === refugeToken) toast(`${points.length} refugios · ${REFUGE_LABEL[key]}`, 3000);
  } catch (err) { toast(`No se pudieron cargar los refugios: ${err.message}`); }
}

/* ---------- Leyenda del mapa (capas base, capas y refugios) ---------- */
function opt(type, name, value, label, checked, onchange, hint) {
  const input = el('input', { type, name, value });
  input.checked = checked;
  input.addEventListener('change', () => onchange(input.checked, value));
  return el('label', { class: 'opt' }, input, el('span', {}, label, hint ? el('small', {}, hint) : null));
}
function buildLayersPanel() {
  const body = $('#layers-body');
  body.replaceChildren(
    el('section', {}, el('h4', {}, 'Mapa base'),
      el('div', { class: 'opts cols' }, baseNames.map((n) => opt('radio', 'base', n, n, n === currentBase().name, () => { setBase(n); prefs.base = n; savePrefs(); })))),
    el('section', {}, el('h4', {}, 'Refugios'),
      el('div', { class: 'opts' },
        opt('radio', 'refuge', 'none', 'Ninguno', prefs.refuge === 'none', (_, v) => switchRefuges(v)),
        opt('radio', 'refuge', 'pyrenees', 'Pyrenees', prefs.refuge === 'pyrenees', (_, v) => switchRefuges(v), 'Fuente fiable, con enlaces'),
        opt('radio', 'refuge', 'pirineos', '+ Pirineos', prefs.refuge === 'pirineos', (_, v) => switchRefuges(v), 'Mayor cobertura'))),
    el('section', {}, el('h4', {}, 'Capas'),
      el('div', { class: 'opts cols' }, OVERLAYS.map((o) => opt('checkbox', 'ov', o.key, o.label, map.hasLayer(o.layer), (on) => { toggleOverlay(o.key, on); prefs.overlays[o.key] = on; savePrefs(); })))));
}
function bindPanelToggles() {
  const panel = $('#layers-panel'), btn = $('#btn-layers');
  const set = (open) => { panel.hidden = !open; btn.classList.toggle('on', open); btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); closeMenus(); set(panel.hidden); };
  document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) set(false); });
  map.on('movestart', () => set(false));
  return set;
}

/* ---------- Puntos de interés bajo demanda ---------- */
function updatePoiButton() {
  const b = $('#btn-load-pois'), ok = canLoadPois();
  b.disabled = !ok;
  b.dataset.tip = ok ? 'Cargar zona — picos, lagos y cascadas de lo que ves' : 'Cargar zona — acércate un poco más (zoom 12)';
}
async function loadVisiblePois() {
  if (!canLoadPois()) return toast('Acércate más para cargar puntos de interés (zoom 12 o superior).');
  toast('Cargando puntos de interés de la zona…', 1500);
  try { toast(`${await loadZonePoisPriority()} puntos (picos, lagos, cascadas) cargados en esta zona.`, 3500); }
  catch (err) { toast(`Error al cargar puntos: ${err.message}`); }
}

/* ---------- Datos de la excursión ---------- */
async function editMetadata() {
  const f = await askForm('Datos de la excursión', [
    { name: 'title', label: 'Nombre', value: metadata.title, required: true },
    { name: 'creator', label: 'Creada por', value: metadata.creator },
    { name: 'seasons', label: 'Estaciones recomendadas', type: 'select', multiple: true, value: metadata.seasons, options: seasons },
    { name: 'elevation', label: 'Desnivel positivo (m)', type: 'number', value: metadata.elevation },
    { name: 'time', label: 'Tiempo estimado', value: metadata.time, placeholder: 'Ej. 6 h 30 min' },
    { name: 'realKm', label: 'Kilómetros reales', type: 'number', value: metadata.realKm },
    { name: 'description', label: 'Comentarios o descripción', type: 'textarea', value: metadata.description },
  ]);
  if (f) setMetadata(f);
}

/* ---------- Fotos: se reducen antes de guardarlas (memoria, almacenamiento y ZIP más ligeros) ---------- */
const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name, type: file.type, data: r.result });
  r.onerror = reject; r.readAsDataURL(file);
});
async function compressImage(file, max = 1280, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
    return { name: file.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', data: c.toDataURL('image/jpeg', quality) };
  } catch { return readAsDataUrl(file); }
}

/* ---------- Paquete ZIP / GPX ---------- */
async function exportPackage() {
  try { await loadScript(JSZIP); } catch { return toast('No se pudo cargar el compresor ZIP (¿sin conexión?).'); }
  const { downloadBlob } = await lazyExport();
  const zip = new JSZip();
  const data = snapshot();
  data.customPois = customPois();
  let photoIndex = 0;
  data.state.days.forEach((d, di) => [...(d.photos || []), ...d.items.flatMap((i) => i.photos || [])].forEach((p) => {
    if (p.data?.includes(',')) {
      p.file = `fotos/dia-${di + 1}-${photoIndex++}-${(p.name || 'foto').replace(/[^\w.-]+/g, '_')}`;
      zip.file(p.file, p.data.split(',')[1], { base64: true });
    }
  }));
  zip.file('excursion.json', JSON.stringify(data, null, 2));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${(metadata.title || 'excursion').replace(/[^\w-]+/g, '_')}.zip`);
}
async function importPackage(file) {
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) return restore(JSON.parse(await file.text()));
  await loadScript(JSZIP);
  const zip = await JSZip.loadAsync(file);
  const data = JSON.parse(await zip.file('excursion.json').async('text'));
  const choice = await askForm('Abrir excursión', [{ name: 'mode', label: 'Modo de apertura', type: 'select', value: 'editor', options: [['editor', 'Editor'], ['visualizador', 'Visualizador']] }], { submitLabel: 'Abrir' });
  if (!choice) return;
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('kml/') && !f.dir)) addKmlRoute(parseKML(await entry.async('text'), entry.name)); // paquetes antiguos
  const photos = data.state.days.flatMap((d) => [...(d.photos || []), ...d.items.flatMap((i) => i.photos || [])]);
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('fotos/') && !f.dir)) {
    const p = photos.find((x) => x.file === entry.name);
    if (p) p.data = `data:${p.type || 'image/jpeg'};base64,${await entry.async('base64')}`;
  }
  addPois(data.customPois || [], 'custom');
  restoreRoutes(data.routes || []);
  restore(data);
  setViewerMode(choice.mode === 'visualizador');
  $('#viewer-bar').hidden = choice.mode !== 'visualizador';
  toast('Excursión abierta. Puedes modificarla y volver a exportarla.');
}
async function downloadGPX() {
  const { downloadBlob } = await lazyExport();
  downloadBlob(new Blob([toGPX()], { type: 'application/gpx+xml' }), 'excursion.gpx');
}

/* ---------- Búsqueda de lugares (siempre visible) ---------- */
let searchAbort;
async function searchPlace(e) {
  e?.preventDefault();
  const query = $('#place-search').value.trim(), box = $('#search-results');
  if (!query) { box.hidden = true; return; }
  searchAbort?.abort(); searchAbort = new AbortController();
  box.replaceChildren(el('div', { class: 'sr-msg' }, 'Buscando…')); box.hidden = false;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=es,fr,ad&bounded=1&viewbox=-5.5,43.95,7.6,41&accept-language=es&q=${encodeURIComponent(query)}`;
    const results = await (await fetch(url, { signal: searchAbort.signal })).json();
    if (!results.length) return box.replaceChildren(el('div', { class: 'sr-msg' }, 'No se encontró ese lugar en el Pirineo.'));
    box.replaceChildren(...results.map((r) => {
      const [name, ...rest] = r.display_name.split(', ');
      return el('button', { type: 'button', class: 'sr-item', onclick: () => { map.flyTo([+r.lat, +r.lon], Math.max(map.getZoom(), 13)); box.hidden = true; $('#place-search').blur(); } },
        el('b', {}, name), el('small', {}, rest.slice(0, 3).join(', ')));
    }));
  } catch (err) { if (err.name !== 'AbortError') box.replaceChildren(el('div', { class: 'sr-msg' }, `No se pudo buscar: ${err.message}`)); }
}
$('#search-form').onsubmit = searchPlace;
$('#place-search').addEventListener('input', (e) => { if (!e.target.value) $('#search-results').hidden = true; });
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#search-results').hidden = true; });

/* ---------- Interfaz: modos, panel, menús ---------- */
initMenus();
const CREATE_MODES = ['newpeak', 'newlake', 'newwaterfall'];
$$('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(mode.cur === b.dataset.mode ? 'none' : b.dataset.mode)));
document.addEventListener('modechange', (e) => {
  $$('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === e.detail));
  $('#btn-create').classList.toggle('on', CREATE_MODES.includes(e.detail));
  document.body.dataset.mode = e.detail;
});
$('#frag-ok').onclick = confirmFragment;
$('#frag-undo').onclick = cancelFragmentStart;
$('#frag-cancel').onclick = () => setMode('none');

const resizeSoon = () => setTimeout(() => map.invalidateSize(), 300);
const setPanel = (open) => { document.body.classList.toggle('panel-open', open); resizeSoon(); };
$('#btn-panel').onclick = () => setPanel(!document.body.classList.contains('panel-open'));
$('#panel-close').onclick = () => setPanel(false);
document.addEventListener('locate-item', () => { if (mobileMq.matches) setPanel(false); });
// Deslizar hacia abajo la cabecera de la hoja inferior (móvil) para plegarla
(() => {
  let y0 = null;
  const h = $('.panel-header');
  h.addEventListener('pointerdown', (e) => { if (mobileMq.matches && !e.target.closest('button')) y0 = e.clientY; });
  h.addEventListener('pointerup', (e) => { if (y0 !== null && e.clientY - y0 > 50) setPanel(false); y0 = null; });
  h.addEventListener('pointercancel', () => { y0 = null; });
})();
$('#btn-hide-ui').onclick = () => {
  const hidden = document.body.classList.toggle('ui-hidden');
  $('#btn-hide-ui').dataset.tip = hidden ? 'Mostrar menús' : 'Ocultar menús y ver solo el mapa';
  closeMenus(); resizeSoon();
};
$('#btn-locate').onclick = locateMe;
$('#add-day').onclick = addDay;
$('#btn-meta').onclick = editMetadata;
$('#btn-load-pois').onclick = async (e) => { e.currentTarget.disabled = true; await loadVisiblePois(); updatePoiButton(); };
$('#btn-clear-pois').onclick = () => { clearDynamicPois(); clearLoadedPois(); toast('Puntos de interés limpiados del mapa.', 2500); };

// Visualizador
const enterViewer = () => { setViewerMode(true); $('#viewer-bar').hidden = false; };
const exitViewer = () => { setViewerMode(false); $('#viewer-bar').hidden = true; };
$('#btn-viewer').onclick = enterViewer;
$('#viewer-toggle').onclick = exitViewer;
$('#viewer-save').onclick = () => { setSaveEnabled(true); $('#viewer-save').hidden = true; exitViewer(); toast('Excursión guardada en tu editor.'); };

// Acciones de los menús
const ACTIONS = {
  'img-jpg': async () => (await lazyExport()).exportImage('jpg'),
  'img-svg': async () => (await lazyExport()).exportImage('svg'),
  'img-share': async () => (await lazyExport()).shareImage(),
  link: async () => (await lazyExport()).shareInteractiveLink(),
  maps: async () => (await lazyExport()).openInMaps(),
  gpx: downloadGPX,
  zip: exportPackage,
  open: () => $('#package-file').click(),
  clear: async () => { if (await confirmDialog('Vaciar itinerario', 'Se borrarán todos los días y elementos del itinerario actual.', 'Vaciar', true)) clearAll(); },
  saver: () => { perf.setSaver(!perf.saver); },
  meta: editMetadata,
  viewer: enterViewer,
  clearpois: () => { clearDynamicPois(); clearLoadedPois(); toast('Puntos de interés limpiados del mapa.', 2500); },
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) Promise.resolve().then(() => ACTIONS[a.dataset.act]?.()).catch((err) => toast(`Error: ${err.message}`));
});
const syncSaverLabel = () => {
  const b = $('[data-act="saver"] b'), s = $('[data-act="saver"] small');
  if (b) { b.textContent = perf.saver ? 'Modo ahorro: activado' : 'Modo ahorro: automático'; s.textContent = `Nivel actual: ${perf.profile.name}`; }
  prefs.saver = perf.saver; savePrefs();
};
perf.on(({ reason, profile }) => {
  syncSaverLabel();
  if (reason === 'manual') toast(perf.saver ? 'Modo ahorro activado: menos detalle, más fluidez.' : 'Rendimiento automático.', 2500);
  else if (reason === 'holgado') toast(`Se ha recuperado el detalle (nivel ${profile.name}).`, 2500);
  else if (reason !== 'memoria') toast(`Mapa lento detectado (${reason}): paso a nivel ${profile.name} para mantenerlo fluido.`, 4500);
});

$('#package-file').onchange = async (e) => {
  try { await importPackage(e.target.files[0]); } catch (err) { toast(`No se pudo abrir: ${err.message}`); }
  e.target.value = '';
};
let photoTarget = null;
document.addEventListener('photo-target', (e) => { photoTarget = e.detail; $('#photo-file').click(); });
$('#photo-file').onchange = async (e) => {
  for (const file of e.target.files) addPhoto(photoTarget, await compressImage(file));
  e.target.value = '';
};

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (closeMenus() || (!$('#layers-panel').hidden && ($('#btn-layers').click(), true))) return;
  if (mode.cur === 'fragment' && cancelFragmentStart()) return; // primero solo se cancela el inicio
  setMode('none');
});
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => map.invalidateSize(), 150); });
map.on('zoomend moveend', updatePoiButton);

/* ---------- Arranque ---------- */
(async function boot() {
  if (prefs.saver) perf.setSaver(true);
  syncSaverLabel();
  setPanel(!mobileMq.matches);
  load(); changed(); loadCustom();

  // ¿Enlace compartido? Se abre en modo visualizador SIN pisar el itinerario propio del navegador
  let shared = false;
  if (location.hash.startsWith('#s=')) {
    try {
      const data = await (await lazyExport()).readSharedHash();
      if (data) {
        setSaveEnabled(false); restore(data); shared = true;
        $('#viewer-save').hidden = false; enterViewer(); setPanel(false);
      }
    } catch (err) { toast(`El enlace de la excursión no es válido: ${err.message}`, 6000); }
  }

  initDynamicLoader(); // registra su capa de forma síncrona; los índices se cargan en ocioso
  setBase(baseNames.includes(prefs.base) ? prefs.base : 'OpenStreetMap');
  for (const [k, on] of Object.entries(prefs.overlays)) toggleOverlay(k, on);
  buildLayersPanel();
  bindPanelToggles();
  updatePoiButton();
  setTimeout(() => map.invalidateSize(), 100);

  if (!shared) switchRefuges(prefs.refuge, { quiet: true });

  // Caminos base en segundo plano, uno a uno, cediendo el hilo entre archivos
  try {
    for (const url of await listKml('caminos')) {
      try { await loadStaticRoute(url); } catch { /* ignorar caminos fallidos */ }
      await perf.yield();
    }
    if (!shared && !map.__userMoved) fitAll();
  } catch { /* continuar */ }
})();
map.once('dragstart zoomstart', () => { map.__userMoved = true; });
