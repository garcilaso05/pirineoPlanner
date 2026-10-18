// export.js — Exportar el itinerario como imagen (JPG/SVG con el mapa de fondo), compartirlo
// (Web Share → WhatsApp, etc.), abrirlo en Google/Apple Maps y generar un enlace interactivo.
import { state, metadata, km, uid } from './itinerary.js';
import { TYPES, DAY_COLORS, BASE_LAYERS } from './config.js';
import { simplify } from './geo.js';
import { perf } from './perf.js';
import { toast, askForm, copyText } from './ui.js';
import { currentBase } from './map.js';

const TILE = 256;
const worldPx = (z) => TILE * 2 ** z;
const mx = (lng, z) => (lng + 180) / 360 * worldPx(z);
const my = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z); };
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'Helvetica, Arial, "Segoe UI", Roboto, sans-serif';
const INK = '#26302b', PAPER = '#fbf8f1';

/* ---------- Recogida de datos ---------- */
function collect() {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, count = 0;
  const grow = (la, ln) => { if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln; };
  const days = state.days.map((d, di) => {
    let dayKm = 0;
    const items = d.items.map((it) => {
      count++;
      if (it.lines) { for (const l of it.lines) for (const p of l) grow(p[0], p[1]); dayKm += it.km ?? km(it.lines); }
      else grow(it.lat, it.lng);
      return it;
    });
    return { di, items, km: dayKm, color: DAY_COLORS[di % DAY_COLORS.length] };
  });
  return { days, count, b: { minLat, maxLat, minLng, maxLng } };
}

function pickView(b, maxPx, zMax) {
  for (let z = Math.min(zMax, 16); z >= 5; z--) {
    let w = (mx(b.maxLng, z) - mx(b.minLng, z)) * 1.14 + 150;
    let h = (my(b.minLat, z) - my(b.maxLat, z)) * 1.14 + 230; // hueco para título y leyenda
    w = Math.max(w, 820); h = Math.max(h, 620);
    const ar = w / h;
    if (ar > 1.9) h = w / 1.9; else if (ar < 0.7) w = h * 0.7;
    const tiles = (Math.ceil(w / TILE) + 1) * (Math.ceil(h / TILE) + 1);
    if (Math.max(w, h) <= maxPx && tiles <= 56) return { z, w: Math.round(w), h: Math.round(h) };
  }
  return { z: 5, w: 820, h: 620 };
}

/* ---------- Mosaico de teselas (GET de las imágenes del mapa de fondo) ---------- */
const loadImage = (url) => new Promise((res) => {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.decoding = 'async';
  const t = setTimeout(() => res(null), 12000);
  img.onload = () => { clearTimeout(t); res(img); };
  img.onerror = () => { clearTimeout(t); res(null); };
  img.src = url;
});
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { for (;;) { const k = i++; if (k >= items.length) return; await fn(items[k]); } }));
}
async function drawTiles(ctx, cfg, z, ox, oy, w, h) {
  const n = 2 ** z, subs = cfg.opt.subdomains || 'abc';
  const jobs = [];
  for (let x = Math.floor(ox / TILE); x <= Math.floor((ox + w) / TILE); x++)
    for (let y = Math.floor(oy / TILE); y <= Math.floor((oy + h) / TILE); y++)
      if (y >= 0 && y < n) jobs.push({ x, y });
  let ok = 0, done = 0;
  await pool(jobs, perf.coarse ? 4 : 6, async ({ x, y }) => {
    const xw = ((x % n) + n) % n;
    const url = cfg.url.replace('{s}', subs[(x + y) % subs.length]).replace('{z}', z).replace('{x}', xw).replace('{y}', y).replace('{r}', '');
    const img = await loadImage(url);
    if (img) { ctx.drawImage(img, x * TILE - ox, y * TILE - oy, TILE, TILE); ok++; }
    if (++done % 8 === 0) toast(`Descargando mapa de fondo… ${done}/${jobs.length}`, 2500);
  });
  return { ok, total: jobs.length };
}

/* ---------- Escena (independiente del formato de salida) ---------- */
let measureCtx;
const measure = (text, font) => { measureCtx ||= document.createElement('canvas').getContext('2d'); measureCtx.font = font; return measureCtx.measureText(text).width; };
const clip = (text, font, maxW) => { if (measure(text, font) <= maxW) return text; let t = text; while (t.length > 3 && measure(t + '…', font) > maxW) t = t.slice(0, -1); return t + '…'; };

function buildScene(data, view, ox, oy, base, tileInfo) {
  const { z, w, h } = view;
  const P = (la, ln) => [mx(ln, z) - ox, my(la, z) - oy];
  const tol = 0.8 * 360 / worldPx(z);
  const paths = [], links = [], marks = [];
  for (const day of data.days) {
    let prev = null;
    day.items.forEach((it, i) => {
      let s, e;
      if (it.lines) {
        for (const l of it.lines) paths.push({ pts: simplify(l, tol).map((p) => P(p[0], p[1])), color: day.color });
        s = P(it.lines[0][0][0], it.lines[0][0][1]); const last = it.lines.at(-1).at(-1); e = P(last[0], last[1]);
      } else { s = e = P(it.lat, it.lng); }
      if (prev && Math.hypot(prev[0] - s[0], prev[1] - s[1]) > 8) links.push({ pts: [prev, s], color: day.color });
      marks.push({ x: s[0], y: s[1], type: it.type, color: it.lines ? day.color : TYPES[it.type]?.color || day.color, num: i + 1, label: it.name, pri: it.type === 'origin' ? 0 : it.lines ? 2 : 1 });
      prev = e;
    });
  }
  // Etiquetas sin solaparse (prioridad: origen > puntos > caminos)
  const boxes = marks.map((m) => [m.x - 14, m.y - 14, m.x + 14, m.y + 14]);
  const hit = (a) => boxes.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
  const labels = [];
  const font = `700 15px ${SANS}`;
  [...marks].sort((a, b) => a.pri - b.pri).forEach((m) => {
    const t = clip(m.label, font, 230), tw = measure(t, font);
    const opts = [['start', m.x + 17, m.y + 5, m.x + 17, m.y - 10, m.x + 17 + tw, m.y + 5], ['end', m.x - 17, m.y + 5, m.x - 17 - tw, m.y - 10, m.x - 17, m.y + 5],
      ['middle', m.x, m.y - 20, m.x - tw / 2, m.y - 35, m.x + tw / 2, m.y - 20], ['middle', m.x, m.y + 32, m.x - tw / 2, m.y + 17, m.x + tw / 2, m.y + 32]];
    for (const [anchor, x, y, x0, y0, x1, y1] of opts) {
      const bx = [x0 - 3, y0 - 2, x1 + 3, y1 + 4];
      if (bx[0] < 6 || bx[2] > w - 6 || bx[1] < 6 || bx[3] > h - 6 || hit(bx)) continue;
      boxes.push(bx); labels.push({ text: t, x, y, anchor }); break;
    }
  });
  // Tarjetas: título, leyenda, atribución
  const totalKm = data.days.reduce((a, d) => a + d.km, 0);
  const sub = [`${data.days.length} día${data.days.length > 1 ? 's' : ''}`, `${totalKm.toFixed(1)} km`, metadata.elevation ? `${metadata.elevation} m+` : '', metadata.time || '', metadata.seasons?.length ? metadata.seasons.join(', ') : ''].filter(Boolean).join('  ·  ');
  let tSize = 30, tFont = `700 ${tSize}px ${SERIF}`;
  const title = metadata.title || 'Excursión por el Pirineo';
  while (tSize > 20 && measure(title, tFont) > w - 90) { tSize -= 2; tFont = `700 ${tSize}px ${SERIF}`; }
  const subFont = `400 16px ${SANS}`, by = metadata.creator ? `por ${metadata.creator}` : '';
  const cardW = Math.min(w - 36, Math.max(measure(clip(title, tFont, w - 90), tFont), measure(sub, subFont), measure(by, subFont)) + 44);
  const attr = `${(base.cfg.opt.attribution || '').replace(/<[^>]+>/g, '')} · PirineoPlanner${tileInfo.ok ? '' : ' · sin mapa de fondo'}`;
  return {
    w, h, paths, links, marks, labels, font,
    card: { x: 18, y: 18, w: cardW, h: by ? 92 : 72, title: clip(title, tFont, w - 90), tFont, sub, subFont, by },
    legend: data.days.map((d) => ({ color: d.color, text: `Día ${d.di + 1} · ${d.km.toFixed(1)} km` })),
    attr, attrFont: `400 12px ${SANS}`,
  };
}

/* ---------- Pintores: Canvas y SVG con la misma interfaz ---------- */
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function canvasPainter(ctx) {
  const paint = (o) => { if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); } if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = o.sw || 1; ctx.stroke(); } };
  return {
    rect(x, y, w, h, r, o) { ctx.save(); ctx.globalAlpha = o.op ?? 1; rr(ctx, x, y, w, h, r); paint(o); ctx.restore(); },
    line(pts, o) {
      ctx.save(); ctx.globalAlpha = o.op ?? 1; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.lineCap = ctx.lineJoin = 'round'; ctx.setLineDash(o.dash || []); ctx.strokeStyle = o.color; ctx.lineWidth = o.width; ctx.stroke(); ctx.restore();
    },
    circle(x, y, r, o) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); paint(o); },
    polygon(pts, o) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.lineJoin = 'round'; paint(o); },
    text(s, x, y, o) {
      ctx.font = o.font; ctx.textAlign = o.anchor === 'middle' ? 'center' : (o.anchor || 'start'); ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      if (o.halo) { ctx.strokeStyle = o.halo; ctx.lineWidth = 4.5; ctx.strokeText(s, x, y); }
      ctx.fillStyle = o.fill; ctx.fillText(s, x, y);
    },
  };
}
const n1 = (v) => Math.round(v * 10) / 10;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function svgPainter() {
  const out = [];
  const pts = (a) => a.map((p) => `${n1(p[0])},${n1(p[1])}`).join(' ');
  const st = (o) => `fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw || 1}"` : ''}`;
  return {
    out,
    rect(x, y, w, h, r, o) { out.push(`<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${r}" ${st(o)}${o.op != null ? ` opacity="${o.op}"` : ''}/>`); },
    line(a, o) { out.push(`<polyline fill="none" points="${pts(a)}" stroke="${o.color}" stroke-width="${o.width}" stroke-linecap="round" stroke-linejoin="round"${o.dash ? ` stroke-dasharray="${o.dash.join(' ')}"` : ''}${o.op != null ? ` stroke-opacity="${o.op}"` : ''}/>`); },
    circle(x, y, r, o) { out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${r}" ${st(o)}/>`); },
    polygon(a, o) { out.push(`<polygon points="${pts(a)}" ${st(o)} stroke-linejoin="round"/>`); },
    text(s, x, y, o) {
      const f = o.font.match(/^(\d+) (\d+)px (.*)$/) || [];
      out.push(`<text x="${n1(x)}" y="${n1(y)}" font-weight="${f[1] || 400}" font-size="${f[2] || 14}" font-family="${esc(f[3] || SANS)}" fill="${o.fill}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.halo ? ` stroke="${o.halo}" stroke-width="4.5" stroke-linejoin="round" paint-order="stroke"` : ''}>${esc(s)}</text>`);
    },
  };
}

function marker(p, m) {
  const white = { fill: '#fff' };
  const base = { fill: m.color, stroke: '#fff', sw: 2.5 };
  const { x, y } = m;
  if (m.type === 'peak') p.polygon([[x, y - 13], [x + 13, y + 10], [x - 13, y + 10]], base);
  else if (m.type === 'refuge') p.polygon([[x, y - 13], [x + 13, y - 1], [x + 9, y - 1], [x + 9, y + 10], [x - 9, y + 10], [x - 9, y - 1], [x - 13, y - 1]], base);
  else if (m.type === 'origin') { p.circle(x, y, 12, base); p.polygon([[x - 4, y - 7], [x + 6, y - 3], [x - 4, y + 1]], white); p.line([[x - 4, y - 7], [x - 4, y + 8]], { color: '#fff', width: 2 }); }
  else if (m.type === 'lake' || m.type === 'waterfall') { p.circle(x, y, 10.5, base); p.circle(x, y, 3.5, white); }
  else { p.circle(x, y, 12, base); p.text(String(m.num), x, y + 4.5, { font: `700 13px ${SANS}`, fill: '#fff', anchor: 'middle' }); }
}

function paintScene(p, s) {
  for (const l of s.links) { p.line(l.pts, { color: '#fff', width: 5, op: 0.8 }); p.line(l.pts, { color: l.color, width: 2.5, dash: [7, 7] }); }
  for (const l of s.paths) p.line(l.pts, { color: '#fff', width: 9, op: 0.9 });
  for (const l of s.paths) p.line(l.pts, { color: l.color, width: 5 });
  [...s.marks].sort((a, b) => b.pri - a.pri).forEach((m) => marker(p, m));
  for (const t of s.labels) p.text(t.text, t.x, t.y, { font: s.font, fill: INK, halo: 'rgba(255,255,255,.92)', anchor: t.anchor });
  const c = s.card;
  p.rect(c.x, c.y, c.w, c.h, 14, { fill: PAPER, stroke: '#d9d1bd', sw: 1.5, op: 0.94 });
  p.rect(c.x, c.y + 14, 5, c.h - 28, 2.5, { fill: '#d4532f' });
  p.text(c.title, c.x + 22, c.y + 38, { font: c.tFont, fill: INK });
  p.text(c.sub, c.x + 22, c.y + 62, { font: c.subFont, fill: '#5c665f' });
  if (c.by) p.text(c.by, c.x + 22, c.y + 82, { font: c.subFont, fill: '#8a9288' });
  const lh = 24, ly = s.h - 18 - s.legend.length * lh - 8;
  const lw = Math.max(...s.legend.map((l) => measure(l.text, `700 14px ${SANS}`))) + 50;
  p.rect(18, ly, lw, s.legend.length * lh + 14, 10, { fill: PAPER, stroke: '#d9d1bd', sw: 1.2, op: 0.92 });
  s.legend.forEach((l, i) => {
    p.rect(30, ly + 11 + i * lh, 22, 8, 4, { fill: l.color });
    p.text(l.text, 62, ly + 20 + i * lh, { font: `700 14px ${SANS}`, fill: INK });
  });
  const aw = measure(s.attr, s.attrFont) + 16;
  p.rect(s.w - aw - 8, s.h - 28, aw, 20, 6, { fill: '#fff', op: 0.78 });
  p.text(s.attr, s.w - aw / 2 - 8, s.h - 14, { font: s.attrFont, fill: '#3a423d', anchor: 'middle' });
}

/* ---------- Imagen ---------- */
const slug = (t) => (t || 'excursion').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'excursion';
export function downloadBlob(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

async function renderImage(format) {
  const data = collect();
  if (!data.count) { toast('Añade algo al itinerario antes de exportar la imagen.'); return null; }
  let base = currentBase();
  const view = pickView(data.b, perf.profile.exportPx, base.cfg.opt.maxZoom || 16);
  const ox = (mx(data.b.minLng, view.z) + mx(data.b.maxLng, view.z)) / 2 - view.w / 2;
  const oy = (my(data.b.minLat, view.z) + my(data.b.maxLat, view.z)) / 2 - view.h / 2 + 30;
  const canvas = Object.assign(document.createElement('canvas'), { width: view.w, height: view.h });
  const ctx = canvas.getContext('2d');
  toast('Preparando la imagen…', 3000);
  const paintBg = async (cfg) => { ctx.fillStyle = '#e9e4d6'; ctx.fillRect(0, 0, view.w, view.h); return drawTiles(ctx, cfg, view.z, ox, oy, view.w, view.h); };
  let info = await paintBg(base.cfg);
  if (info.ok < info.total * 0.4 && base.name !== 'OpenStreetMap') { // la capa elegida no permite descargar teselas: alternativa abierta
    toast('Ese mapa no permite copiar sus teselas; uso OpenStreetMap.', 3000);
    base = { name: 'OpenStreetMap', cfg: BASE_LAYERS['OpenStreetMap'] };
    info = await paintBg(base.cfg);
  }
  if (!info.ok) toast('No se pudo descargar el mapa de fondo (¿sin conexión?). Se exporta solo el recorrido.', 5000);
  const scene = buildScene(data, view, ox, oy, base, info);
  const name = slug(metadata.title);
  if (format === 'svg') {
    const bg = canvas.toDataURL('image/jpeg', 0.85);
    const sp = svgPainter(); paintScene(sp, scene);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${view.w}" height="${view.h}" viewBox="0 0 ${view.w} ${view.h}">\n<image x="0" y="0" width="${view.w}" height="${view.h}" href="${bg}" xlink:href="${bg}"/>\n${sp.out.join('\n')}\n</svg>`;
    return { blob: new Blob([svg], { type: 'image/svg+xml' }), name: `${name}.svg`, mime: 'image/svg+xml' };
  }
  paintScene(canvasPainter(ctx), scene);
  const blob = await toBlob(canvas, 'image/jpeg', 0.88);
  if (!blob) throw new Error('El navegador no pudo generar la imagen.');
  return { blob, name: `${name}.jpg`, mime: 'image/jpeg' };
}
export async function exportImage(format) {
  try {
    const r = await renderImage(format);
    if (!r) return;
    downloadBlob(r.blob, r.name);
    toast(`Imagen ${format.toUpperCase()} guardada (${Math.round(r.blob.size / 1024)} KB).`);
  } catch (e) { toast(`No se pudo crear la imagen: ${e.message}`); }
}
/** Compartir la imagen con el menú del sistema (WhatsApp, Telegram, Mensajes…). */
export async function shareImage() {
  try {
    const r = await renderImage('jpg');
    if (!r) return;
    const file = new File([r.blob], r.name, { type: r.mime });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: metadata.title, text: metadata.title }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    downloadBlob(r.blob, r.name);
    toast('Este navegador no puede compartir archivos directamente: la imagen se ha descargado para enviarla.', 5000);
  } catch (e) { toast(`No se pudo compartir: ${e.message}`); }
}

/* ---------- Google Maps / Apple Maps ---------- */
function sampleDay(day, count) {
  const pts = [];
  for (const it of day.items) { if (it.lines) it.lines.forEach((l) => pts.push(...l)); else pts.push([it.lat, it.lng]); }
  if (pts.length < 2) return pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * 111.3, (pts[i][1] - pts[i - 1][1]) * 82));
  const out = [pts[0]];
  for (let k = 1; k < count - 1; k++) { const target = cum.at(-1) * k / (count - 1); out.push(pts[cum.findIndex((c) => c >= target)]); }
  out.push(pts.at(-1));
  return out;
}
export async function openInMaps() {
  const days = state.days.filter((d) => d.items.length);
  if (!days.length) return toast('El itinerario está vacío.');
  const f = await askForm('Abrir en la app de mapas', [
    { name: 'app', label: 'Aplicación', type: 'select', value: 'google', options: [['google', 'Google Maps (ruta a pie con paradas)'], ['apple', 'Apple Maps (inicio y final)']] },
    ...(days.length > 1 ? [{ name: 'day', label: 'Día', type: 'select', value: '0', options: days.map((d) => [String(state.days.indexOf(d)), `Día ${state.days.indexOf(d) + 1}`]) }] : []),
  ], { submitLabel: 'Abrir', intro: 'La app calcula su propia ruta entre los puntos (el trazado exacto no se puede enviar): úsalo como guía de acceso y paradas.' });
  if (!f) return;
  const day = state.days[+(f.day ?? state.days.indexOf(days[0]))];
  const ll = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  let url;
  if (f.app === 'apple') { const s = sampleDay(day, 2); url = `https://maps.apple.com/?saddr=${ll(s[0])}&daddr=${ll(s.at(-1))}&dirflg=w`; }
  else {
    const s = sampleDay(day, 5); // origen + 3 paradas + destino: el máximo que aceptan las apps móviles
    url = `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${ll(s[0])}&destination=${ll(s.at(-1))}${s.length > 2 ? `&waypoints=${encodeURIComponent(s.slice(1, -1).map(ll).join('|'))}` : ''}`;
  }
  const copied = await copyText(url);
  window.open(url, '_blank', 'noopener');
  toast(copied ? 'Abierto. El enlace también se ha copiado para pegarlo en WhatsApp.' : 'Abierto en una pestaña nueva.', 5000);
}

/* ---------- Enlace interactivo (la excursión viaja dentro de la URL) ---------- */
function encNum(v) { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); }
export function encodePolyline(pts) { let o = '', pa = 0, pb = 0; for (const [la, ln] of pts) { const a = Math.round(la * 1e5), b = Math.round(ln * 1e5); o += encNum(a - pa) + encNum(b - pb); pa = a; pb = b; } return o; }
export function decodePolyline(str) {
  const out = []; let i = 0, a = 0, b = 0;
  const next = () => { let r = 0, s = 0, c; do { c = str.charCodeAt(i++) - 63; r |= (c & 0x1f) << s; s += 5; } while (c >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { a += next(); b += next(); out.push([a / 1e5, b / 1e5]); }
  return out;
}
const b64u = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pipe(u8, Stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new Stream('deflate-raw'))).arrayBuffer()); }
export async function packShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return typeof CompressionStream === 'undefined' ? `r${b64u(bytes)}` : `z${b64u(await pipe(bytes, CompressionStream))}`;
}
export async function unpackShare(str) {
  const raw = unb64u(str.slice(1));
  const bytes = str[0] === 'z' ? await pipe(raw, DecompressionStream) : raw;
  return JSON.parse(new TextDecoder().decode(bytes));
}
function shareData(tolMeters) {
  const tol = tolMeters / 111320;
  return {
    v: 1, m: { title: metadata.title, creator: metadata.creator, seasons: metadata.seasons, elevation: metadata.elevation, time: metadata.time, realKm: metadata.realKm, description: metadata.description },
    d: state.days.map((d) => d.items.map((it) => it.lines
      ? { t: it.type, n: it.name, l: it.lines.map((l) => encodePolyline(simplify(l, tol))) }
      : { t: it.type, n: it.name, a: it.lat, o: it.lng, e: it.ele ?? undefined })),
  };
}
export async function buildShareLink() {
  let data, str;
  for (const tol of [8, 16, 32, 64, 120, 250]) { // simplifica más hasta que el enlace sea manejable
    data = shareData(tol); str = await packShare(data);
    if (str.length < 3800) break;
  }
  return { url: `${location.origin}${location.pathname}#s=${str}`, length: str.length };
}
export async function shareInteractiveLink() {
  if (!state.days.some((d) => d.items.length)) return toast('El itinerario está vacío.');
  try {
    const { url, length } = await buildShareLink();
    if (length > 6000) toast('El enlace es muy largo para algunas apps; mejor comparte la imagen.', 5000);
    if (navigator.share) { try { await navigator.share({ title: metadata.title, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    toast((await copyText(url)) ? 'Enlace copiado. Quien lo abra verá la excursión en el mapa interactivo.' : url, 6000);
  } catch (e) { toast(`No se pudo crear el enlace: ${e.message}`); }
}
/** Si la URL trae una excursión compartida (#s=…), devuelve el formato de itinerary.restore(). */
export async function readSharedHash() {
  const m = location.hash.match(/^#s=([zr][\w-]+)$/);
  if (!m) return null;
  const d = await unpackShare(m[1]);
  if (d?.v !== 1) throw new Error('Enlace no compatible');
  const days = d.d.map((items) => ({
    id: uid(),
    items: items.map((it) => {
      const base = { id: uid(), type: it.t, name: it.n };
      if (!it.l) return { ...base, lat: it.a, lng: it.o, ele: it.e ?? null };
      const lines = it.l.map(decodePolyline);
      return { ...base, lat: lines[0][0][0], lng: lines[0][0][1], lines, km: km(lines) };
    }),
  }));
  return { version: 2, metadata: d.m || {}, state: { days, active: days[0]?.id } };
}
