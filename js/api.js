// Camptocamp (principal) + Overpass (complemento). Devuelve POIs {key,type,name,lat,lng,ele,src,url}
import { C2C_PROXY_URL, OVERPASS_MIRRORS } from './config.js';

const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 111000 * Math.cos(a.lat * Math.PI / 180));

async function timed(url, opt = {}, ms = 20000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function c2cJson(url) {
  const endpoint = C2C_PROXY_URL ? `${C2C_PROXY_URL}${url.slice(url.indexOf('?'))}` : url;
  const r = await timed(endpoint);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function c2c(b) {
  const out = [];
  for (let off = 0; off < 400; off += 100) {
    const qs = new URLSearchParams({ bbox: b.toBBoxString(), limit: 100, offset: off, pl: 'es', wtyp: 'summit,lake' });
    const j = await c2cJson(`https://api.camptocamp.org/waypoints?${qs}`);
    for (const d of j.documents || []) {
      const g = typeof d.geometry?.geom === 'string' ? JSON.parse(d.geometry.geom) : d.geometry?.geom;
      if (!g?.coordinates) continue;
      const [lng, lat] = g.coordinates;
      const loc = d.locales?.find((l) => l.lang === 'es') || d.locales?.[0];
      out.push({ key: `c2c:${d.document_id}`, type: d.waypoint_type === 'lake' ? 'lake' : 'peak', name: loc?.title || 'Sin nombre', lat, lng, ele: d.elevation || null, src: 'c2c', url: `https://www.camptocamp.org/waypoints/${d.document_id}` });
    }
    if (off + 100 >= (j.total || 0)) break;
  }
  return out;
}

let opBest = 0;
async function overpass(b) {
  const bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:20];(node["natural"="peak"]["name"](${bb});nwr["natural"="water"]["name"]["water"!~"river|stream|canal|pond|basin|moat"](${bb}););out center 400;`;
  let last;
  for (let k = 0; k < OVERPASS_MIRRORS.length; k++) {
    const i = (opBest + k) % OVERPASS_MIRRORS.length;
    try {
      const r = await timed(OVERPASS_MIRRORS[i], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 25000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const els = (await r.json()).elements || [];
      opBest = i;
      return els.map((e) => {
        const t = e.tags || {}, c = e.center || e;
        const ele = parseFloat(String(t.ele || '').replace(',', '.'));
        return { key: `osm:${e.type}/${e.id}`, type: t.natural === 'peak' ? 'peak' : 'lake', name: t['name:es'] || t.name, lat: c.lat, lng: c.lon, ele: Number.isFinite(ele) ? ele : null, src: 'osm', url: `https://www.openstreetmap.org/${e.type}/${e.id}` };
      }).filter((p) => p.lat != null);
    } catch (e) { last = e; }
  }
  throw new Error(`Overpass no disponible (${last?.message || 'error de red'})`);
}

export async function fetchPois(bounds) {
  const [a, b] = await Promise.allSettled([c2c(bounds), overpass(bounds)]);
  const items = a.status === 'fulfilled' ? [...a.value] : [];
  const errors = [a, b].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  if (b.status === 'fulfilled') {
    for (const p of b.value) {
      const dup = items.some((q) => q.type === p.type && (meters(p, q) < (p.type === 'lake' ? 400 : 200) || (q.name.toLowerCase() === p.name.toLowerCase() && meters(p, q) < 2000)));
      if (!dup) items.push(p);
    }
  }
  return { items, errors };
}
