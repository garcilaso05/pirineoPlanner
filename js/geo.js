// Utilidades geométricas puras (sin DOM ni Leaflet). Todas trabajan con puntos [lat, lng]
// y SIEMPRE sobre la geometría completa del camino (la simplificación es solo visual).

export const M_PER_DEG = 111320;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Proyecta un punto sobre la polilínea completa (no solo sobre sus vértices).
 * Devuelve { i, t, point, d }: segmento i (pts[i]→pts[i+1]), posición t∈[0,1] dentro de él,
 * el punto exacto proyectado y la distancia en metros.
 */
export function projectOnLine(pts, ll) {
  const n = pts.length;
  if (!n) return null;
  if (n === 1) return { i: 0, t: 0, point: [pts[0][0], pts[0][1]], d: Infinity };
  const kx = Math.cos(ll.lat * Math.PI / 180);
  const px = ll.lng * kx, py = ll.lat;
  let bi = 0, bt = 0, bd = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a[1] * kx, ay = a[0];
    const dx = b[1] * kx - ax, dy = b[0] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
    const ex = px - (ax + t * dx), ey = py - (ay + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < bd) { bd = d2; bi = i; bt = t; }
  }
  const a = pts[bi], b = pts[bi + 1];
  return { i: bi, t: bt, point: [a[0] + bt * (b[0] - a[0]), a[1] + bt * (b[1] - a[1])], d: Math.sqrt(bd) * M_PER_DEG };
}

/**
 * Fragmento entre dos proyecciones (a, b) sobre `pts`, con TODOS los vértices originales
 * intermedios. Si b está antes que a, el resultado se devuelve en el sentido a→b (invertido).
 */
export function sliceLine(pts, a, b) {
  const rev = (b.i + b.t) < (a.i + a.t);
  const [s, e] = rev ? [b, a] : [a, b];
  const out = [s.point];
  for (let k = s.i + 1; k <= e.i; k++) out.push(pts[k]);
  out.push(e.point);
  const clean = out.filter((p, k) => k === 0 || !samePt(p, out[k - 1]));
  return rev ? clean.reverse() : clean;
}

/** Douglas-Peucker iterativo (sin recursión). SOLO para dibujar, nunca para recortar. */
export function simplify(points, tolerance = 0.00012) {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const sq = (p, a, b) => {
    const x = b[1] - a[1], y = b[0] - a[0];
    if (!x && !y) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    const t = clamp01(((p[1] - a[1]) * x + (p[0] - a[0]) * y) / (x * x + y * y));
    return (p[0] - (a[0] + t * y)) ** 2 + (p[1] - (a[1] + t * x)) ** 2;
  };
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let best = tol2, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sq(points[i], points[first], points[last]);
      if (d > best) { best = d; index = i; }
    }
    if (index >= 0) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Une LineStrings consecutivas que comparten un extremo (≈1 m) cuando la unión es inequívoca
 * (el extremo lo comparten exactamente dos líneas). Invierte las que haga falta.
 * Así un camino partido en varios tramos (típico de Waymarked Trails) se puede recortar de una vez.
 * Entrada/salida: [{name, pts}]
 */
export function stitchLines(lines) {
  const n = lines.length;
  if (n < 2) return lines;
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const ends = new Map();
  lines.forEach((l, i) => {
    [[0, l.pts[0]], [1, l.pts[l.pts.length - 1]]].forEach(([e, p]) => {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push([i, e]);
    });
  });
  const used = new Array(n).fill(false);
  const partner = (p) => {
    const arr = ends.get(key(p));
    return arr && arr.length === 2 ? arr.find(([j]) => !used[j]) || null : null;
  };
  const out = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = true;
    let pts = lines[s].pts.slice();
    for (let o = partner(pts[pts.length - 1]); o; o = partner(pts[pts.length - 1])) {
      used[o[0]] = true;
      const nxt = o[1] === 0 ? lines[o[0]].pts : lines[o[0]].pts.slice().reverse();
      pts = pts.concat(nxt.slice(1));
    }
    for (let o = partner(pts[0]); o; o = partner(pts[0])) {
      used[o[0]] = true;
      const prv = o[1] === 1 ? lines[o[0]].pts : lines[o[0]].pts.slice().reverse();
      pts = prv.slice(0, -1).concat(pts);
    }
    out.push({ name: lines[s].name, pts });
  }
  return out;
}
