import { map, setMode, mode, addRoute, addRefuges, searchHere, loadCustom, fitAll } from './map.js';
import { load, changed, addDay, clearAll, toGPX } from './itinerary.js';
import { parseKML } from './kml.js';
import { $, toast } from './ui.js';

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
function ingest(kml) {
  const segments = kml.lines.map((l, i) => ({ name: l.name || `Tramo ${i + 1}`, pts: l.pts }));
  if (segments.length) addRoute({ title: kml.title, segments });
  if (kml.points.length) addRefuges(kml.points);
  return segments.length + kml.points.length;
}
async function loadUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  return ingest(parseKML(await r.text(), url.split('/').pop()));
}

document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(mode.cur === b.dataset.mode ? 'none' : b.dataset.mode); });
$('#btn-search').onclick = searchHere;
$('#add-day').onclick = addDay;
$('#btn-import').onclick = () => $('#file').click();
$('#file').onchange = async (e) => {
  let n = 0;
  for (const f of e.target.files) {
    try { n += ingest(parseKML(await f.text(), f.name)); } catch (err) { toast(err.message); }
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
  const files = [...new Set([...(await listKml('refugios')), ...(await listKml('caminos'))])];
  const res = await Promise.allSettled(files.map(loadUrl));
  const bad = res.filter((r) => r.status === 'rejected');
  fitAll();
  toast(!files.length ? 'No se encontraron KML en refugios/ ni caminos/. Revisa manifest.json y sirve la web con un servidor.'
    : bad.length ? `Cargados ${res.length - bad.length}/${res.length} archivos. Error: ${bad[0].reason.message}` : `Datos cargados (${files.length} archivos KML).`, 5000);
})();
