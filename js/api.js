// Camptocamp (principal) + Overpass (complemento). Devuelve POIs {key,type,name,lat,lng,ele,src,url}
const R = 6378137;
const toM = (lat, lng) => [lng * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R]; // WGS84 → EPSG:3857
const fromM = (x, y) => [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, x / R * 180 / Math.PI];
const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111000, (a.lng - b.lng) * 111000 * Math.cos(a.lat * Math.PI / 180));

async function c2c(b) {
  const [x1, y1] = toM(b.getSouth(), b.getWest()), [x2, y2] = toM(b.getNorth(), b.getEast());
  const out = [];
  for (let off = 0; off < 400; off += 100) {
    // URLSearchParams codifica las comas (%2C), igual que la petición que la API acepta
    const qs = new URLSearchParams({ bbox: `${x1},${y1},${x2},${y2}`, limit: 100, offset: off, pl: 'es', wtyp: 'summit,lake' });
    const r = await fetch(`https://api.camptocamp.org/waypoints?${qs}`);
    if (!r.ok) throw new Error(`Camptocamp ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const g = typeof d.geometry?.geom === 'string' ? JSON.parse(d.geometry.geom) : d.geometry?.geom;
      if (!g?.coordinates) continue;
      const [lat, lng] = fromM(g.coordinates[0], g.coordinates[1]);
      const loc = d.locales?.find((l) => l.lang === 'es') || d.locales?.[0];
      out.push({ key: `c2c:${d.document_id}`, type: d.waypoint_type === 'lake' ? 'lake' : 'peak', name: loc?.title || 'Sin nombre', lat, lng, ele: d.elevation || null, src: 'c2c', url: `https://www.camptocamp.org/waypoints/${d.document_id}` });
    }
    if (off + 100 >= (j.total || 0)) break;
  }
  return out;
}

async function overpass(b) {
  const bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q = `[out:json][timeout:25];(node["natural"="peak"]["name"](${bb});nwr["natural"="water"]["name"]["water"!~"river|stream|canal|pond|basin|moat"](${bb}););out center 500;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
  if (!r.ok) throw new Error(`Overpass ${r.status}`);
  return (await r.json()).elements.map((e) => {
    const t = e.tags || {}, c = e.center || e;
    const ele = parseFloat(String(t.ele || '').replace(',', '.'));
    return { key: `osm:${e.type}/${e.id}`, type: t.natural === 'peak' ? 'peak' : 'lake', name: t['name:es'] || t.name, lat: c.lat, lng: c.lon, ele: Number.isFinite(ele) ? ele : null, src: 'osm', url: `https://www.openstreetmap.org/${e.type}/${e.id}` };
  }).filter((p) => p.lat != null);
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
