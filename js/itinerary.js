import { el, $, toast } from './ui.js';
import { TYPES, DAY_COLORS } from './config.js';

const KEY = 'senda.itinerary.v1';
export const state = { days: [], active: null };
export const hooks = { change: [], locate: () => {} };
const uid = () => Math.random().toString(36).slice(2, 9);
let sortables = [];

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
    if (s?.days?.length) { state.days = s.days; state.active = s.active || s.days[0].id; return; }
  } catch { /* ignorar */ }
  state.days = [newDay()]; state.active = state.days[0].id;
}
let warned = false;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ days: state.days, active: state.active })); }
  catch { if (!warned) { warned = true; toast('El itinerario es demasiado grande para guardarse en el navegador. Exporta el GPX.'); } }
}
export function changed() { save(); render(); hooks.change.forEach((f) => f(state)); }
export const activeDay = () => state.days.find((d) => d.id === state.active) || state.days[0];
export const dayIndex = () => state.days.indexOf(activeDay());

export function addItem(item) {
  item.id = uid();
  if (item.lines) item.km = km(item.lines);
  activeDay().items.push(item);
  changed();
  toast(`«${item.name}» añadido al Día ${dayIndex() + 1}`);
}
export function setOrigin(item) {
  state.days.forEach((d) => { d.items = d.items.filter((i) => i.type !== 'origin'); });
  item.id = uid();
  state.days[0].items.unshift(item);
  changed();
  toast('Origen fijado en el Día 1');
}
export function addDay() { const d = newDay(); state.days.push(d); state.active = d.id; changed(); }
export function clearAll() { state.days = [newDay()]; state.active = state.days[0].id; changed(); }
function removeDay(id) {
  const d = state.days.find((x) => x.id === id);
  if (d.items.length && !confirm('Este día tiene elementos. ¿Eliminarlo?')) return;
  state.days = state.days.filter((x) => x.id !== id);
  if (!state.days.length) state.days = [newDay()];
  if (!state.days.some((x) => x.id === state.active)) state.active = state.days[0].id;
  changed();
}
function remove(id) { state.days.forEach((d) => { d.items = d.items.filter((i) => i.id !== id); }); changed(); }

// Reconstruye el estado desde el DOM tras arrastrar y soltar
function sync() {
  const items = new Map(state.days.flatMap((d) => d.items).map((i) => [i.id, i]));
  const days = new Map(state.days.map((d) => [d.id, d]));
  state.days = [...$('#days').children].map((card) => {
    const d = days.get(card.dataset.day);
    d.items = [...card.querySelectorAll('li[data-id]')].map((li) => items.get(li.dataset.id)).filter(Boolean);
    return d;
  });
  setTimeout(changed, 0);
}

function itemEl(it) {
  const T = TYPES[it.type];
  const meta = it.lines ? `${(it.km ?? km(it.lines)).toFixed(1)} km · camino` : `${T.label}${it.ele ? ` · ${Math.round(it.ele)} m` : ''}`;
  return el('li', { class: 'it', 'data-id': it.id },
    el('span', { class: 'handle', title: 'Arrastrar para reordenar' }, '⠿'),
    el('span', { class: 'ico', style: `background:${T.color}` }, T.glyph),
    el('div', { class: 'txt', title: 'Ver en el mapa', onclick: () => hooks.locate(it) }, el('b', {}, it.name), el('small', {}, meta)),
    el('button', { class: 'icon', title: 'Quitar', onclick: () => remove(it.id) }, '✕'));
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
      el('header', { title: 'Clic para usar este día como destino', onclick: () => { state.active = d.id; changed(); } },
        el('span', { class: 'day-grip', title: 'Arrastrar día' }, '⋮⋮'), el('b', {}, `Día ${i + 1}`),
        el('span', { class: 'km' }, dk ? `${dk.toFixed(1)} km` : ''),
        el('button', { class: 'icon', title: 'Eliminar día', onclick: (e) => { e.stopPropagation(); removeDay(d.id); } }, '🗑')),
      ul);
    sortables.push(new Sortable(ul, { group: 'items', handle: '.handle', animation: 150, ghostClass: 'ghost', onEnd: sync }));
    return card;
  }));
  sortables.push(new Sortable(box, { handle: '.day-grip', animation: 150, onEnd: sync }));
  $('#stats').textContent = `${state.days.length} día${state.days.length > 1 ? 's' : ''} · ${totalKm.toFixed(1)} km de camino · ${n} elementos`;
}

export function toGPX() {
  const x = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  let g = '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Planificador Pirineos" xmlns="http://www.topografix.com/GPX/1/1">';
  state.days.forEach((d, i) => d.items.forEach((it) => {
    const nm = `Día ${i + 1} · ${x(it.name)}`;
    if (it.lines) g += `<trk><name>${nm}</name>${it.lines.map((l) => `<trkseg>${l.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`).join('')}</trkseg>`).join('')}</trk>`;
    else g += `<wpt lat="${it.lat}" lon="${it.lng}">${it.ele ? `<ele>${it.ele}</ele>` : ''}<name>${nm}</name><type>${it.type}</type></wpt>`;
  }));
  return g + '</gpx>';
}
