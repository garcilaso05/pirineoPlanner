import { el, $, icon, toast, askForm, confirmDialog } from './ui.js';
import { TYPES, DAY_COLORS } from './config.js';
import { perf } from './perf.js';

const KEY = 'senda.itinerary.v1';
export const state = { days: [], active: null };
const DEFAULT_META = () => ({ title: 'Excursión por el Pirineo', creator: '', seasons: [], elevation: '', time: '', realKm: '', description: '' });
export const metadata = DEFAULT_META();
export const hooks = { change: [], locate: () => {} };
export const uid = () => Math.random().toString(36).slice(2, 9);
let sortables = [];
let saveEnabled = true;

function dist(a, b) {
  const t = Math.PI / 180, dl = (b[0] - a[0]) * t, dn = (b[1] - a[1]) * t;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dn / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
export function km(lines) {
  let d = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) d += dist(l[i - 1], l[i]);
  return d / 1000;
}
const newDay = () => ({ id: uid(), items: [] });
export function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s?.days?.length) { state.days = s.days; state.active = s.active || s.days[0].id; Object.assign(metadata, s.metadata || {}); return; }
  } catch { /* ignorar */ }
  state.days = [newDay()]; state.active = state.days[0].id;
}

/* ---------- Guardado diferido: serializar fotos y recorridos en cada cambio era lo más caro ---------- */
let warned = false, saveTimer = 0;
function saveNow() {
  saveTimer = 0;
  if (!saveEnabled) return;
  try { localStorage.setItem(KEY, JSON.stringify({ days: state.days, active: state.active, metadata })); }
  catch { if (!warned) { warned = true; toast('El itinerario es demasiado grande para guardarse en el navegador. Exporta una copia.'); } }
}
function scheduleSave() {
  if (!saveEnabled || saveTimer) return;
  saveTimer = setTimeout(() => perf.idle(saveNow, 2000), 500);
}
/** En una excursión compartida (solo lectura) no se pisa el itinerario propio del navegador. */
export function setSaveEnabled(on) { saveEnabled = on; if (on) { clearTimeout(saveTimer); saveNow(); } }
window.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); saveNow(); } });

let hookRaf = 0;
export function changed() {
  scheduleSave();
  render();
  if (!hookRaf) hookRaf = requestAnimationFrame(() => { hookRaf = 0; hooks.change.forEach((f) => f(state)); });
}
export const activeDay = () => state.days.find((d) => d.id === state.active) || state.days[0];
export const dayIndex = () => state.days.indexOf(activeDay());
export const allItems = () => state.days.flatMap((d) => d.items);

export function addItem(item) {
  item.id = uid();
  if (item.lines) item.km = km(item.lines);
  activeDay().items.push(item);
  changed();
  toast(`«${item.name}» añadido al Día ${dayIndex() + 1}`);
  return item;
}
export function setOrigin(item) {
  state.days.forEach((d) => { d.items = d.items.filter((i) => i.type !== 'origin'); });
  item.id = uid();
  state.days[0].items.unshift(item);
  changed();
  toast('Origen fijado en el Día 1');
}
export function addDay() { const d = newDay(); state.days.push(d); state.active = d.id; changed(); }
export function clearAll() { state.days = [newDay()]; state.active = state.days[0].id; Object.assign(metadata, DEFAULT_META()); changed(); }
export function setMetadata(values) { Object.assign(metadata, values); changed(); }
export function addPhoto(target, photo) {
  const bucket = target.type === 'day' ? state.days.find((d) => d.id === target.id) : allItems().find((i) => i.id === target.id);
  if (!bucket) return;
  bucket.photos = [...(bucket.photos || []), photo]; changed();
}
export async function renameItem(id) {
  const item = allItems().find((entry) => entry.id === id);
  if (!item) return;
  const result = await askForm('Renombrar elemento', [{ name: 'name', label: 'Nombre', value: item.name, required: true }]);
  if (result?.name?.trim()) { item.name = result.name.trim(); changed(); }
}
export function snapshot() { return { version: 2, metadata: { ...metadata }, state: { days: state.days, active: state.active } }; }
export function restore(data) {
  if (!data?.state?.days?.length) throw new Error('El paquete no contiene un itinerario válido.');
  state.days = data.state.days; state.active = data.state.active || state.days[0].id;
  Object.assign(metadata, DEFAULT_META(), data.metadata || {}); changed();
}
async function removeDay(id) {
  const d = state.days.find((x) => x.id === id);
  if (d.items.length && !(await confirmDialog('Eliminar día', 'Este día tiene elementos. ¿Eliminarlo con todo su contenido?', 'Eliminar', true))) return;
  state.days = state.days.filter((x) => x.id !== id);
  if (!state.days.length) state.days = [newDay()];
  if (!state.days.some((x) => x.id === state.active)) state.active = state.days[0].id;
  changed();
}
function remove(id) { state.days.forEach((d) => { d.items = d.items.filter((i) => i.id !== id); }); changed(); }

// Reconstruye el estado desde el DOM tras arrastrar y soltar
function sync() {
  const items = new Map(allItems().map((i) => [i.id, i]));
  const days = new Map(state.days.map((d) => [d.id, d]));
  state.days = [...$('#days').children].map((card) => {
    const d = days.get(card.dataset.day);
    d.items = [...card.querySelectorAll('li[data-id]')].map((li) => items.get(li.dataset.id)).filter(Boolean);
    return d;
  });
  setTimeout(changed, 0);
}

const photoBtn = (target, count, title) => el('button', { class: 'icon', title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); document.dispatchEvent(new CustomEvent('photo-target', { detail: target })); } },
  icon('camera'), count ? el('span', { class: 'cnt' }, String(count)) : null);

function itemEl(it) {
  const T = TYPES[it.type];
  const meta = it.lines ? `${(it.km ?? km(it.lines)).toFixed(1)} km · camino` : `${T.label}${it.ele ? ` · ${Math.round(it.ele)} m` : ''}`;
  return el('li', { class: 'it', 'data-id': it.id },
    el('span', { class: 'handle', title: 'Arrastrar para reordenar' }, icon('grip')),
    el('span', { class: 'ico', style: `background:${T.color}` }, T.glyph),
    el('div', { class: 'txt', title: 'Ver en el mapa', onclick: () => hooks.locate(it) }, el('b', {}, it.name), el('small', {}, meta)),
    photoBtn({ type: 'item', id: it.id }, (it.photos || []).length, 'Añadir fotos'),
    el('button', { class: 'icon', title: 'Renombrar', 'aria-label': 'Renombrar', onclick: (e) => { e.stopPropagation(); renameItem(it.id); } }, icon('pencil')),
    el('button', { class: 'icon', title: 'Quitar', 'aria-label': 'Quitar', onclick: () => remove(it.id) }, icon('x')));
}

export function render() {
  sortables.forEach((s) => s.destroy()); sortables = [];
  const box = $('#days');
  let totalKm = 0, n = 0;
  box.replaceChildren(...state.days.map((d, i) => {
    const dk = d.items.reduce((a, it) => a + (it.lines ? (it.km ?? km(it.lines)) : 0), 0);
    totalKm += dk; n += d.items.length;
    const ul = el('ul', { class: 'items' }, d.items.map(itemEl));
    const card = el('section', { class: 'day' + (d.id === state.active ? ' active' : ''), 'data-day': d.id, style: `--c:${DAY_COLORS[i % DAY_COLORS.length]}` },
      el('header', { title: 'Toca para usar este día como destino', onclick: () => { state.active = d.id; changed(); } },
        el('span', { class: 'day-grip', title: 'Arrastrar día' }, icon('grip')), el('b', {}, `Día ${i + 1}`),
        el('span', { class: 'km' }, dk ? `${dk.toFixed(1)} km` : ''),
        photoBtn({ type: 'day', id: d.id }, (d.photos || []).length, 'Añadir fotos al día'),
        el('button', { class: 'icon', title: 'Eliminar día', 'aria-label': 'Eliminar día', onclick: (e) => { e.stopPropagation(); removeDay(d.id); } }, icon('trash'))),
      ul);
    if (window.Sortable) sortables.push(new Sortable(ul, { group: 'items', handle: '.handle', animation: 150, ghostClass: 'ghost', touchStartThreshold: 4, onEnd: sync }));
    return card;
  }));
  if (window.Sortable) sortables.push(new Sortable(box, { handle: '.day-grip', animation: 150, ghostClass: 'ghost', touchStartThreshold: 4, onEnd: sync }));
  const statsText = `${state.days.length} día${state.days.length > 1 ? 's' : ''} · ${totalKm.toFixed(1)} km · ${n} elemento${n === 1 ? '' : 's'}`;
  const title = metadata.title || 'Excursión por el Pirineo';
  const set = (sel, text) => { const e = $(sel); if (e) e.textContent = text; };
  set('#stats', statsText); set('#panel-title', title); set('#vb-title', title);
  const extra = [metadata.elevation ? `${metadata.elevation} m+` : null, metadata.time || null, metadata.creator ? `Por ${metadata.creator}` : null].filter(Boolean).join(' · ');
  set('#vb-stats', [statsText, extra].filter(Boolean).join(' | '));
  document.body.classList.toggle('empty-trip', n === 0);
}

export function toGPX() {
  const x = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let g = '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="PirineoPlanner" xmlns="http://www.topografix.com/GPX/1/1">';
  state.days.forEach((d, i) => d.items.forEach((it) => {
    const nm = `Día ${i + 1} · ${x(it.name)}`;
    if (it.lines) g += `<trk><name>${nm}</name>${it.lines.map((l) => `<trkseg>${l.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`).join('')}</trkseg>`).join('')}</trk>`;
    else g += `<wpt lat="${it.lat}" lon="${it.lng}">${it.ele ? `<ele>${it.ele}</ele>` : ''}<name>${nm}</name><type>${it.type}</type></wpt>`;
  }));
  return g + '</gpx>';
}
