import { map, setMode, mode, addRoute, addRefuges, clearRefuges, addPois, customPois, customRoutes, restoreRoutes, loadCustom, fitAll, canLoadPois, poiBounds, finishDrawRoute, clearLoadedPois, setViewerMode, G, layerControl } from './map.js';
import { load, changed, addDay, clearAll, toGPX, metadata, setMetadata, addPhoto, snapshot, restore } from './itinerary.js';
import { parseKML } from './kml.js';
import { $, toast, askForm } from './ui.js';
import { initDynamicLoader, clearDynamicPois } from './dynamic_loader.js';

const resources = new Map();
const seasons = ['Primavera', 'Verano', 'Otoño', 'Invierno'];
const deferredPoiUrls = [];
const poiCache = new Map();
const refugesCache = new Map();
let currentRefugeSource = 'pyrenees';

// Lista los KML de una carpeta: manifest.json + fallback índice
async function listKml(dir) {
  const files = new Set();
  let listed = false;
  try {
    const m = await (await fetch('manifest.json')).json();
    if (Array.isArray(m[dir])) {
      listed = true;
      m[dir].forEach((f) => files.add(f.includes('/') ? f : `${dir}/${f}`));
    }
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

async function ingest(kml, kind = 'custom', resource = null) {
  const segments = kml.lines.map((l, i) => ({ name: l.name || `Tramo ${i + 1}`, pts: l.pts }));
  if (segments.length) addRoute({ title: kml.title, segments });
  if (kind === 'peak' || kind === 'lake' || kind === 'waterfall') {
    addPois(kml.points.map((p) => ({ ...p, type: kind })), 'osm');
  } else if (kml.points.length && kind === 'refuge') {
    await addRefuges(kml.points);
  }
  if (resource) resources.set(resource.name, resource.text);
  return segments.length + kml.points.length;
}

async function loadUrl(url, kind = 'custom') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  const text = await r.text();
  return ingest(parseKML(text, url.split('/').pop()), kind, kind === 'custom' ? { name: url.split('/').pop(), text } : null);
}

/* ---------- Gestión de Refugios (dos fuentes con switch sin mezclar) ---------- */
async function getRefugePoints(sourceKey) {
  if (refugesCache.has(sourceKey)) return refugesCache.get(sourceKey);
  const fileName = sourceKey === 'pyrenees' ? 'refugios/pyrenees.kml' : 'refugios/refugios_pirineo.kml';
  const r = await fetch(fileName);
  if (!r.ok) throw new Error(`Error al descargar ${fileName} (${r.status})`);
  const text = await r.text();
  const kml = parseKML(text, fileName.split('/').pop());
  refugesCache.set(sourceKey, kml.points);
  return kml.points;
}

async function switchRefuges(sourceKey) {
  currentRefugeSource = sourceKey;
  const btnPyrenees = $('#btn-refuge-pyrenees');
  const btnPirineos = $('#btn-refuge-pirineos');
  if (btnPyrenees) btnPyrenees.classList.toggle('active', sourceKey === 'pyrenees');
  if (btnPirineos) btnPirineos.classList.toggle('active', sourceKey === 'pirineos');

  clearRefuges();
  toast(sourceKey === 'pyrenees' ? 'Cargando refugios: Pyrenees (fuente oficial)…' : 'Cargando refugios: Pirineos (+ cobertura)…');
  try {
    const points = await getRefugePoints(sourceKey);
    // Doble verificación: limpiar antes de añadir para asegurar que jamás se mezclan
    clearRefuges();
    await addRefuges(points);
    toast(`${points.length} refugios cargados (${sourceKey === 'pyrenees' ? 'Pyrenees - fuente oficial' : 'Refugios Pirineos - mayor cobertura'}).`, 4000);
  } catch (err) {
    toast(`No se pudieron cargar los refugios: ${err.message}`);
  }
}

/* ---------- Carga bajo demanda de Picos, Lagos y Cascadas ---------- */
async function loadVisiblePois() {
  if (!canLoadPois()) return toast('Acércate más para cargar puntos de interés (zoom 11 o superior).');
  const bounds = poiBounds();
  const jobs = deferredPoiUrls.map(async ({ url, kind }) => {
    let points = poiCache.get(url);
    if (!points) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} (${r.status})`);
      const kml = parseKML(await r.text(), url.split('/').pop());
      points = kml.points.map((p, i) => ({ ...p, type: kind, key: `static:${kind}:${url}:${i}` }));
      poiCache.set(url, points);
    }
    return points.filter((p) => bounds.contains([p.lat, p.lng]));
  });
  const results = await Promise.allSettled(jobs);
  const points = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const added = addPois(points, 'osm');
  toast(`${added} puntos (picos, lagos, cascadas) cargados en esta zona${errors.length ? ` · ${errors.join(', ')}` : ''}`, 5000);
}

function updatePoiButton() {
  const button = $('#btn-load-pois');
  if (button) button.hidden = !deferredPoiUrls.length || !canLoadPois();
}

/* ---------- Metadatos de la Excursión ---------- */
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

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, data: r.result });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function downloadBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportPackage() {
  const zip = new JSZip();
  const data = snapshot();
  data.customPois = customPois();
  data.routes = customRoutes();
  let photoIndex = 0;
  data.state.days.forEach((d, di) => [...(d.photos || []), ...d.items.flatMap((i) => i.photos || [])].forEach((p) => {
    if (p.data?.includes(',')) {
      p.file = `fotos/dia-${di + 1}-${photoIndex++}-${(p.name || 'foto').replace(/[^\w.-]+/g, '_')}`;
      zip.file(p.file, p.data.split(',')[1], { base64: true });
    }
  }));
  zip.file('excursion.json', JSON.stringify(data, null, 2));
  resources.forEach((text, name) => zip.file(`kml/${name}`, text));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${(metadata.title || 'excursion').replace(/[^\w-]+/g, '_')}.zip`);
}

async function importPackage(file) {
  if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) return restore(JSON.parse(await file.text()));
  const zip = await JSZip.loadAsync(file);
  const data = JSON.parse(await zip.file('excursion.json').async('text'));
  const choice = await askForm('Abrir excursión', [{ name: 'mode', label: 'Modo de apertura', type: 'select', value: 'editor', options: ['editor', 'visualizador'] }]);
  if (!choice) return;
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('kml/') && !f.dir)) {
    const text = await entry.async('text');
    await ingest(parseKML(text, entry.name), 'custom', { name: entry.name.slice(4), text });
  }
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('fotos/') && !f.dir)) {
    const matching = [...data.state.days].flatMap((d) => [...(d.photos || []), ...d.items.flatMap((i) => i.photos || [])]).find((p) => p.file === entry.name);
    if (matching) matching.data = `data:${matching.type || 'image/jpeg'};base64,${await entry.async('base64')}`;
  }
  addPois(data.customPois || [], 'custom');
  restoreRoutes(data.routes || []);
  restore(data);
  const isViewer = choice.mode === 'visualizador';
  setViewerMode(isViewer);
  $('#viewer-bar').hidden = !isViewer;
  toast('Excursión importada. Puedes modificarla y volver a exportarla.');
}

/* ---------- Event Listeners ---------- */
document.querySelectorAll('[data-mode]').forEach((b) => {
  b.onclick = () => setMode(mode.cur === b.dataset.mode ? 'none' : b.dataset.mode);
});

$('#btn-finish-route').onclick = finishDrawRoute;
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  setTimeout(() => { $('#btn-finish-route').hidden = mode.cur !== 'newroute'; }, 0);
}));

$('#btn-clear-pois').onclick = () => {
  clearDynamicPois();
  const count = clearLoadedPois();
  toast(`Puntos de interés limpiados del mapa.`, 3500);
};

// Switch de refugios
$('#btn-refuge-pyrenees').onclick = () => switchRefuges('pyrenees');
$('#btn-refuge-pirineos').onclick = () => switchRefuges('pirineos');

// Visualizador
$('#btn-viewer').onclick = () => {
  setViewerMode(true);
  $('#viewer-bar').hidden = false;
};
$('#viewer-toggle').onclick = () => {
  setViewerMode(false);
  $('#viewer-bar').hidden = true;
};

// Carga de POIs
$('#btn-load-pois').onclick = async () => {
  const button = $('#btn-load-pois');
  button.disabled = true;
  try { await loadVisiblePois(); } catch (e) { toast(`No se pudieron cargar los puntos: ${e.message}`); }
  button.disabled = false;
};
map.on('zoomend moveend', updatePoiButton);

$('#add-day').onclick = addDay;
$('#btn-meta').onclick = editMetadata;
$('#btn-package').onclick = exportPackage;
$('#btn-open-package').onclick = () => $('#package-file').click();
$('#package-file').onchange = async (e) => {
  try { await importPackage(e.target.files[0]); } catch (err) { toast(`No se pudo importar: ${err.message}`); }
  e.target.value = '';
};

// Buscador geográfico
async function searchPlace() {
  const query = $('#place-search').value.trim();
  if (!query) return;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=es,fr&bounded=1&viewbox=-5.5,43.95,7.6,41&accept-language=es&q=${encodeURIComponent(query)}`;
  try {
    const results = await (await fetch(url)).json();
    if (!results.length) return toast('No se encontró ese lugar.');
    const options = results.map((r) => `${r.place_id} · ${r.display_name}`);
    const chosen = await askForm('Selecciona un resultado', [{ name: 'place', label: 'Lugar', type: 'select', value: options[0], options }]);
    if (!chosen) return;
    const selected = results.find((r) => `${r.place_id} · ${r.display_name}` === chosen.place);
    if (selected) map.flyTo([+selected.lat, +selected.lon], Math.max(map.getZoom(), 12));
  } catch (error) { toast(`No se pudo buscar: ${error.message}`); }
}
$('#btn-place-search').onclick = searchPlace;
$('#place-search').onkeydown = (event) => { if (event.key === 'Enter') searchPlace(); };

// Manejo de fotos e importación KML
let photoTarget = null;
document.addEventListener('photo-target', (e) => { photoTarget = e.detail; $('#photo-file').click(); });
$('#photo-file').onchange = async (e) => {
  for (const file of e.target.files) addPhoto(photoTarget, await readAsDataUrl(file));
  e.target.value = '';
};

$('#btn-import').onclick = () => $('#file').click();
$('#file').onchange = async (e) => {
  let n = 0;
  for (const f of e.target.files) {
    try { const text = await f.text(); n += await ingest(parseKML(text, f.name), 'custom', { name: f.name, text }); } catch (err) { toast(err.message); }
  }
  e.target.value = '';
  if (n) { fitAll(); toast(`Importados ${n} elementos. Haz clic en el camino para añadirlo.`); }
};

$('#btn-gpx').onclick = () => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([toGPX()], { type: 'application/gpx+xml' })), download: 'excursion.gpx' });
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#btn-clear').onclick = () => {
  if (confirm('¿Vaciar todo el itinerario?')) clearAll();
};

$('#toggle-panel').onclick = () => {
  document.body.classList.toggle('collapsed');
  setTimeout(() => map.invalidateSize(), 300);
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setMode('none');
    $('#btn-finish-route').hidden = true;
  }
});

/* ---------- Inicialización de la aplicación ---------- */
(async function boot() {
  load();
  changed();
  loadCustom();
  toast('Iniciando Planificador de los Pirineos…', 8000);

  // 1. Cargar caminos base
  try {
    const caminosFiles = await listKml('caminos');
    for (const url of caminosFiles) {
      try { await loadUrl(url, 'custom'); } catch { /* ignorar caminos fallidos */ }
    }
  } catch { /* continuar */ }

  // 2. Inicializar cargador dinámico de rutas KML (otrosCaminosKML) y POIs espaciales
  try {
    await initDynamicLoader(layerControl);
  } catch (err) {
    console.warn('Error al iniciar dynamic loader:', err);
  }

  // 3. Cargar por defecto los refugios de pyrenees.kml
  try {
    await switchRefuges('pyrenees');
  } catch (err) {
    console.warn('Error al cargar refugios pyrenees:', err);
  }

  updatePoiButton();
  fitAll();
  setTimeout(() => map.invalidateSize(), 100);
  toast('Aplicación lista. Acércate en el mapa para explorar caminos y puntos de interés automáticamente.', 5000);
})();
