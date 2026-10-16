// Parser KML: devuelve {title, points[], lines[]}. Soporta Point, LineString y MultiGeometry (formato Waymarked Trails).
const parseCoords = (node) => {
  const t = node.getElementsByTagName('coordinates')[0]?.textContent || '';
  return t.trim().split(/\s+/).map((s) => {
    const [lng, lat, ele] = s.split(',').map(Number);
    return [lat, lng, ele];
  }).filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
};
export function parseKML(text, fileName = 'KML') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error(`KML no válido: ${fileName}`);
  const docName = doc.getElementsByTagName('Document')[0]?.getElementsByTagName('name')[0];
  const title = (docName?.parentNode?.nodeName === 'Document' ? docName.textContent.trim() : '') || fileName.replace(/\.kml$/i, '');
  const points = [], lines = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = pm.getElementsByTagName('name')[0]?.textContent.trim() || '';
    const desc = pm.getElementsByTagName('description')[0]?.textContent.trim() || '';
    const data = {};
    for (const d of pm.getElementsByTagName('Data')) data[d.getAttribute('name')] = d.getElementsByTagName('value')[0]?.textContent || '';
    const tipoTag = pm.getElementsByTagName('tipo')[0]?.textContent.trim() || '';
    const eleTag = pm.getElementsByTagName('elevacion')[0]?.textContent.trim() || pm.getElementsByTagName('elevation')[0]?.textContent.trim() || '';
    
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

    // Enlace explícito en tag <link>
    const linkTag = pm.getElementsByTagName('link')[0]?.textContent?.trim() || '';
    const kmlLink = linkTag.startsWith('http') ? linkTag : null;

    // También extraer URLs de la descripción (refugios de pyrenees.kml)
    const descUrl = (desc.match(/https?:\/\/\S+/) || [])[0] || null;

    for (const p of pm.getElementsByTagName('Point')) {
      const c = parseCoords(p)[0];
      if (c) {
        const pointEle = ele !== null ? ele : (Number.isFinite(c[2]) && c[2] ? c[2] : null);
        points.push({ name, desc, data, sub, lat: c[0], lng: c[1], ele: pointEle, url: kmlLink || descUrl || null });
      }
    }
    for (const l of pm.getElementsByTagName('LineString')) {
      const c = parseCoords(l);
      if (c.length > 1) lines.push({ name, pts: c.map(([la, ln]) => [la, ln]) });
    }
  }
  return { title, points, lines };
}
