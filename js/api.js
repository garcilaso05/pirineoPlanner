// OpenStreetMap vía Overpass. Devuelve POIs {key,type,name,lat,lng,ele,src,url}
import { OVERPASS_MIRRORS } from './config.js';

async function timed(url, opt = {}, ms = 20000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctl.signal }); } finally { clearTimeout(t); }
}

let opBest = 0;
async function overpass(b) {
  const bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:20];(node["natural"="peak"]["name"](${bb});nwr["natural"="water"]["name"](${bb});nwr["natural"="water"]["name"~"ib[oó]n|estany|llac|lac|étang|lago|laguna",i](${bb});nwr["water"~"^(lake|reservoir|pond|lagoon|glacial_lake|oxbow)$"]["name"](${bb}););out center 300;`;
  let last;
  for (let k = 0; k < OVERPASS_MIRRORS.length; k++) {
    const i = (opBest + k) % OVERPASS_MIRRORS.length;
    try {
      const r = await timed(OVERPASS_MIRRORS[i], { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) }, 25000);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const els = (await r.json()).elements || [];
      opBest = i;
      const points = els.map((e) => {
        const t = e.tags || {}, c = e.center || e;
        const ele = parseFloat(String(t.ele || '').replace(',', '.'));
        return { key: `osm:${e.type}/${e.id}`, type: t.natural === 'peak' ? 'peak' : 'lake', name: t.name || t['name:es'] || t['name:ca'] || t['name:oc'] || t['name:fr'] || 'Lago sin nombre', lat: c.lat, lng: c.lon, ele: Number.isFinite(ele) ? ele : null, src: 'osm', url: `https://www.openstreetmap.org/${e.type}/${e.id}` };
      }).filter((p) => p.lat != null);
      return points.filter((p, i) => points.findIndex((q) => q.key === p.key) === i);
    } catch (e) { last = e; }
  }
  throw new Error(`Overpass no disponible (${last?.message || 'error de red'})`);
}

export async function fetchPois(bounds) {
  try { return { items: await overpass(bounds), errors: [] }; }
  catch (e) { return { items: [], errors: [e.message] }; }
}
