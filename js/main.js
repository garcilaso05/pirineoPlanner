import { map, setMode, mode, addRoute, addRefuges, addPois, customPois, loadCustom, fitAll, canLoadPois, poiBounds } from './map.js';
import { load, changed, addDay, clearAll, toGPX, metadata, setMetadata, addPhoto, snapshot, restore } from './itinerary.js';
import { parseKML } from './kml.js';
import { $, toast } from './ui.js';

const resources = new Map();
const seasons = ['Primavera', 'Verano', 'Otoño', 'Invierno'];
const deferredPoiUrls = [];
const poiCache = new Map();

// Lista los KML de una carpeta: manifest.json + índice de directorio (si el servidor lo expone)
async function listKml(dir) {
  const files = new Set();
  try {
    const m = await (await fetch('manifest.json')).json();
    (m[dir] || []).forEach((f) => files.add(f.includes('/') ? f : `${dir}/${f}`));
  } catch { /* sin manifest */ }
  try {
    const r = await fetch(`${dir}/`);
    if (!r.ok) throw new Error('sin índice');
    const t = await r.text();
    for (const m of t.matchAll(/href="([^"?#]+\.kml)"/gi)) files.add(`${dir}/${decodeURIComponent(m[1]).split('/').pop()}`);
  } catch { /* sin índice */ }
  return [...files];
}
function ingest(kml, kind = 'custom', resource = null) {
  const segments = kml.lines.map((l, i) => ({ name: l.name || `Tramo ${i + 1}`, pts: l.pts }));
  if (segments.length) addRoute({ title: kml.title, segments });
  if (kind === 'peak' || kind === 'lake') addPois(kml.points.map((p) => ({ ...p, type: kind })), 'osm');
  else if (kml.points.length) addRefuges(kml.points);
  if (resource) resources.set(resource.name, resource.text);
  return segments.length + kml.points.length;
}
async function loadUrl(url, kind = 'custom') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  const text = await r.text();
  return ingest(parseKML(text, url.split('/').pop()), kind, kind === 'custom' ? { name: url.split('/').pop(), text } : null);
}

async function loadVisiblePois() {
  if (!canLoadPois()) return toast('Acércate más para cargar picos y lagos (zoom 11 o superior).');
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
  toast(`${added} picos y lagos cargados en esta zona${errors.length ? ` · ${errors.join(', ')}` : ''}`, 5000);
}

function updatePoiButton() {
  const button = $('#btn-load-pois');
  button.hidden = !deferredPoiUrls.length || !canLoadPois();
}

async function editMetadata() {
  const f = await import('./ui.js').then(({ askForm }) => askForm('Datos de la excursión', [
    { name: 'title', label: 'Nombre', value: metadata.title, required: true },
    { name: 'creator', label: 'Creada por', value: metadata.creator },
    { name: 'seasons', label: 'Estaciones recomendadas', type: 'select', multiple: true, value: metadata.seasons, options: seasons },
    { name: 'elevation', label: 'Desnivel positivo (m)', type: 'number', value: metadata.elevation },
    { name: 'time', label: 'Tiempo estimado', value: metadata.time, placeholder: 'Ej. 6 h 30 min' },
    { name: 'realKm', label: 'Kilómetros reales', type: 'number', value: metadata.realKm },
    { name: 'description', label: 'Comentarios o descripción', type: 'textarea', value: metadata.description },
  ]));
  if (f) setMetadata(f);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve({ name: file.name, type: file.type, data: r.result }); r.onerror = reject; r.readAsDataURL(file); });
}
function downloadBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function exportPackage() {
  const zip = new JSZip();
  const data = snapshot();
  data.customPois = customPois();
  data.state.days.forEach((d, di) => [...(d.photos || []), ...d.items.flatMap((i) => (i.photos || []).map((p) => ({ ...p, owner: i.id })))].forEach((p, pi) => {
    if (p.data?.includes(',')) {
      p.file = `fotos/dia-${di + 1}-${pi}-${(p.name || 'foto').replace(/[^\w.-]+/g, '_')}`;
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
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('kml/') && !f.dir)) {
    const text = await entry.async('text');
    ingest(parseKML(text, entry.name), 'custom', { name: entry.name.slice(4), text });
  }
  for (const entry of Object.values(zip.files).filter((f) => f.name.startsWith('fotos/') && !f.dir)) {
    const fileName = entry.name.split('/').pop();
    const matching = [...data.state.days].flatMap((d) => [...(d.photos || []), ...d.items.flatMap((i) => i.photos || [])]).find((p) => p.file === entry.name);
    if (matching) matching.data = `data:${matching.type || 'image/jpeg'};base64,${await entry.async('base64')}`;
  }
  addPois(data.customPois || [], 'custom');
  restore(data);
  toast('Excursión importada. Puedes modificarla y volver a exportarla.');
}

document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(mode.cur === b.dataset.mode ? 'none' : b.dataset.mode); });
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
$('#package-file').onchange = async (e) => { try { await importPackage(e.target.files[0]); } catch (err) { toast(`No se pudo importar: ${err.message}`); } e.target.value = ''; };
let photoTarget = null;
document.addEventListener('photo-target', (e) => { photoTarget = e.detail; $('#photo-file').click(); });
$('#photo-file').onchange = async (e) => { for (const file of e.target.files) addPhoto(photoTarget, await readAsDataUrl(file)); e.target.value = ''; };
$('#btn-import').onclick = () => $('#file').click();
$('#file').onchange = async (e) => {
  let n = 0;
  for (const f of e.target.files) {
    try { const text = await f.text(); n += ingest(parseKML(text, f.name), 'custom', { name: f.name, text }); } catch (err) { toast(err.message); }
  }
  e.target.value = '';
  if (n) { fitAll(); toast(`Importados ${n} elementos. Haz clic en el camino para añadirlo.`); }
};
$('#btn-gpx').onclick = () => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([toGPX()], { type: 'application/gpx+xml' })), download: 'excursion.gpx' });
  a.click(); URL.revokeObjectURL(a.href);
};
$('#btn-clear').onclick = () => { if (confirm('¿Vaciar todo el itinerario?')) clearAll(); };
$('#toggle-panel').onclick = () => { document.body.classList.toggle('collapsed'); setTimeout(() => map.invalidateSize(), 300); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMode('none'); });

(async function boot() {
  load(); changed(); loadCustom();
  toast('Cargando refugios y caminos…', 15000);
  const groups = [['refugios', 'custom'], ['caminos', 'custom'], ['picos', 'peak'], ['lagos', 'lake']];
  const files = (await Promise.all(groups.map(async ([dir, kind]) => (await listKml(dir)).map((url) => ({ url, kind }))))).flat();
  const deferred = files.filter(({ kind }) => kind === 'peak' || kind === 'lake');
  deferredPoiUrls.push(...deferred);
  const initial = files.filter(({ kind }) => kind !== 'peak' && kind !== 'lake');
  const res = await Promise.allSettled(initial.map(({ url, kind }) => loadUrl(url, kind)));
  updatePoiButton();
  const bad = res.filter((r) => r.status === 'rejected');
  fitAll();
  toast(!files.length ? 'No se encontraron KML en refugios/ ni caminos/. Revisa manifest.json y sirve la web con un servidor.'
    : bad.length ? `Cargados ${res.length - bad.length}/${res.length} archivos. Error: ${bad[0].reason.message}` : `Datos cargados (${initial.length} archivos). Acércate y pulsa el botón para cargar picos y lagos.`, 5000);
})();
