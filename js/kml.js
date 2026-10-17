// Parser KML: devuelve {title, points[], lines[]}.
// Soporta Point, LineString, LinearRing, MultiGeometry, gx:Track, prefijos de namespace,
// coordenadas con espacios/saltos de línea ("lng, lat, ele") y ExtendedData/SimpleData.
// Las `lines` contienen SIEMPRE todas las coordenadas originales (sin simplificar).
import { stitchLines } from './geo.js';

const local = (n) => n.localName || n.nodeName.split(':').pop();
const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const kids = (node) => Array.from(node.childNodes).filter((c) => c.nodeType === 1);
const childText = (node, name) => {
  const c = node && kids(node).find((k) => local(k) === name);
  return c ? c.textContent.trim() : '';
};
const firstText = (node, name) => all(node, name)[0]?.textContent.trim() || '';

// "lng,lat[,ele]" separados por espacios o saltos de línea; tolera "lng, lat, ele"
function parseCoordText(text) {
  const out = [];
  const norm = (text || '').replace(/\s*,\s*/g, ',').trim();
  if (!norm) return out;
  for (const tok of norm.split(/\s+/)) {
    const [lng, lat, ele] = tok.split(',').map(parseFloat);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) out.push([lat, lng, ele]);
  }
  return out;
}
// gx:coord → "lng lat ele" separado por espacios
function parseGxCoord(text) {
  const [lng, lat, ele] = (text || '').trim().split(/\s+/).map(parseFloat);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng, ele] : null;
}
const dedupe = (pts) => pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);

function collectLines(pm, name, stitch) {
  const raw = [];
  const push = (c) => {
    const pts = dedupe(c.map(([la, ln]) => [la, ln]));
    if (pts.length > 1) raw.push({ name, pts });
  };
  for (const g of [...all(pm, 'LineString'), ...all(pm, 'LinearRing')]) {
    const c = all(g, 'coordinates')[0];
    if (c) push(parseCoordText(c.textContent));
  }
  for (const t of all(pm, 'Track')) push(all(t, 'coord').map((c) => parseGxCoord(c.textContent)).filter(Boolean));
  return stitch ? stitchLines(raw) : raw;
}

export function parseKML(text, fileName = 'KML', { stitch = true } = {}) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (all(doc, 'parsererror').length) throw new Error(`KML no válido: ${fileName}`);
  const container = all(doc, 'Document')[0] || all(doc, 'Folder')[0];
  const title = childText(container, 'name') || fileName.replace(/\.kml$/i, '');
  const points = [], lines = [];
  for (const pm of all(doc, 'Placemark')) {
    const name = childText(pm, 'name');
    const desc = childText(pm, 'description');
    const data = {};
    for (const d of all(pm, 'Data')) data[d.getAttribute('name')] = childText(d, 'value');
    for (const d of all(pm, 'SimpleData')) data[d.getAttribute('name')] = d.textContent;
    const tipoTag = firstText(pm, 'tipo');
    const eleTag = firstText(pm, 'elevacion') || firstText(pm, 'elevation');

    // Extracción robusta de altitud
    let ele = null;
    if (eleTag) {
      const em = eleTag.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (em) ele = +em[1];
    }
    if (ele === null && desc) {
      const dm = desc.match(/Elevaci[oó]n:\s*([0-9]+(?:\.[0-9]+)?)/i);
      if (dm) ele = +dm[1];
    }
    if (ele === null && data.elevation) {
      const num = parseFloat(data.elevation);
      if (Number.isFinite(num)) ele = num;
    }

    // Subtipo si existe
    const sub = tipoTag || data.type_hebergement || (desc.match(/Tipo:\s*([^\n\r]+)/i)?.[1]?.trim()) || '';

    // Enlace explícito en tag <link> o URL dentro de la descripción
    const linkTag = firstText(pm, 'link');
    const kmlLink = linkTag.startsWith('http') ? linkTag : null;
    const descUrl = (desc.match(/https?:\/\/[^\s"'<>]+/) || [])[0] || null;

    for (const p of all(pm, 'Point')) {
      const c = parseCoordText(all(p, 'coordinates')[0]?.textContent)[0];
      if (c) {
        const pointEle = ele !== null ? ele : (Number.isFinite(c[2]) && c[2] ? c[2] : null);
        points.push({ name, desc, data, sub, lat: c[0], lng: c[1], ele: pointEle, url: kmlLink || descUrl || null });
      }
    }
    // Las líneas de un mismo Placemark se unen si comparten extremos; Placemarks distintos nunca se mezclan
    lines.push(...collectLines(pm, name, stitch));
  }
  return { title, points, lines };
}
