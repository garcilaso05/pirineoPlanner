// pathfinder.js — Conexión inteligente entre dos puntos de caminos distintos (herramienta de tijeras).
// Busca un recorrido a través de cruces entre tramos, con un máximo de `maxTransitions` cambios de CAMINO
// (1 = cruce directo GR11→GR10; 2 = un camino puente GR11→puente→GR10). Cambiar de tramo dentro del
// mismo camino NO cuenta como cambio. Funciona siempre con la geometría completa. Sin DOM ni Leaflet.
import { sliceLine } from './geo.js';

const M = 111320;
const CELL = 150;                 // metros por celda de la rejilla espacial
const SEG_BITS = 4194304;         // 2^22 aristas máx. por tramo en la referencia numérica
const KEY_OFF = 1048576, KEY_MUL = 2097152;

const idOf = new WeakMap(); let nextId = 1;
/** Dos objetos de camino son «el mismo camino» si son el mismo objeto o comparten título (p. ej. GR 11 duplicado). */
export function routeId(r) {
  const t = (r?.title || '').trim().toLowerCase();
  if (t) return `t:${t}`;
  if (!idOf.has(r)) idOf.set(r, nextId++);
  return `o:${idOf.get(r)}`;
}
export const sameRoute = (a, b) => a === b || routeId(a) === routeId(b);

// Distancia mínima entre dos segmentos 2D; devuelve d² y los parámetros t (en AB) y u (en CD)
function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den) {
    const qx = cx - ax, qy = cy - ay;
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return { d2: 0, t, u };
  }
  let best = { d2: Infinity, t: 0, u: 0 };
  const pt = (px, py, x0, y0, x1, y1) => { // proyección del punto en el segmento
    const vx = x1 - x0, vy = y1 - y0, l2 = vx * vx + vy * vy;
    const k = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / l2)) : 0;
    const ex = px - (x0 + k * vx), ey = py - (y0 + k * vy);
    return { k, d2: ex * ex + ey * ey };
  };
  let r = pt(ax, ay, cx, cy, dx, dy); if (r.d2 < best.d2) best = { d2: r.d2, t: 0, u: r.k };
  r = pt(bx, by, cx, cy, dx, dy); if (r.d2 < best.d2) best = { d2: r.d2, t: 1, u: r.k };
  r = pt(cx, cy, ax, ay, bx, by); if (r.d2 < best.d2) best = { d2: r.d2, t: r.k, u: 0 };
  r = pt(dx, dy, ax, ay, bx, by); if (r.d2 < best.d2) best = { d2: r.d2, t: r.k, u: 1 };
  return best;
}

class Heap { // cola de prioridad mínima
  constructor() { this.a = []; }
  push(c, v) { const a = this.a; a.push([c, v]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

const lenKm = (lines) => { let d = 0; for (const l of lines) for (let i = 1; i < l.length; i++) d += Math.hypot((l[i][0] - l[i - 1][0]) * M, (l[i][1] - l[i - 1][1]) * M * Math.cos(l[i][0] * Math.PI / 180)); return d / 1000; };

/**
 * candidates: [{ seg, route }]  (seg = { pts:[[lat,lng],…] })
 * start / end: { seg, pr }      (pr = proyección { i, t, point } sobre seg.pts)
 * Devuelve { sections:[{ route, lines:[pts…] }], km } o null si no hay conexión.
 */
export function findConnection({ candidates, start, end, tol = 25, maxTransitions = 2, penalty = 20000 }) {
  if (start.seg === end.seg) {
    return { sections: [{ route: candidates.find((c) => c.seg === start.seg)?.route, lines: [sliceLine(start.seg.pts, start.pr, end.pr)] }], km: 0 };
  }
  const segs = [], idx = new Map();
  for (const c of candidates) if (c.seg.pts?.length > 1 && !idx.has(c.seg)) { idx.set(c.seg, segs.length); segs.push(c); }
  if (!idx.has(start.seg) || !idx.has(end.seg)) return null;
  const S = start.seg ? idx.get(start.seg) : -1, E = idx.get(end.seg);

  // Geometría local en metros (equirrectangular alrededor del inicio)
  const kx = Math.cos(start.pr.point[0] * Math.PI / 180);
  const geo = segs.map(({ seg }) => {
    const n = seg.pts.length, X = new Float64Array(n), Y = new Float64Array(n), C = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = seg.pts[i][1] * kx * M; Y[i] = seg.pts[i][0] * M; if (i) C[i] = C[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]); }
    return { X, Y, C, n };
  });
  const rid = segs.map((c) => routeId(c.route));

  // 1) Rejilla espacial de aristas
  const key = (cx, cy) => (cx + KEY_OFF) * KEY_MUL + (cy + KEY_OFF);
  const cellsOf = (g, e) => {
    const len = g.C[e + 1] - g.C[e], steps = Math.max(1, Math.ceil(len / 60)), out = [];
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const x = g.X[e] + (g.X[e + 1] - g.X[e]) * s / steps, y = g.Y[e] + (g.Y[e + 1] - g.Y[e]) * s / steps;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), k = key(cx, cy);
      if (k !== last) { out.push([cx, cy]); last = k; }
    }
    return out;
  };
  const grid = new Map();
  geo.forEach((g, si) => { for (let e = 0; e < g.n - 1; e++) for (const [cx, cy] of cellsOf(g, e)) { const k = key(cx, cy); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(si * SEG_BITS + e); } });

  // 2) Cruces entre tramos distintos (a ≤ tol metros)
  const tol2 = tol * tol, pairs = new Map();
  geo.forEach((g, si) => {
    for (let e = 0; e < g.n - 1; e++) {
      const seen = new Set();
      for (const [cx, cy] of cellsOf(g, e)) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(key(cx + ox, cy + oy));
        if (!bucket) continue;
        for (const r of bucket) {
          const sj = Math.floor(r / SEG_BITS);
          if (sj <= si || seen.has(r)) continue;
          seen.add(r);
          const f = r - sj * SEG_BITS, h = geo[sj];
          const q = segSeg(g.X[e], g.Y[e], g.X[e + 1], g.Y[e + 1], h.X[f], h.Y[f], h.X[f + 1], h.Y[f + 1]);
          if (q.d2 > tol2) continue;
          const pk = si * 100000 + sj;
          let arr = pairs.get(pk); if (!arr) pairs.set(pk, arr = { si, sj, list: [] });
          arr.list.push({ da: g.C[e] + q.t * (g.C[e + 1] - g.C[e]), db: h.C[f] + q.u * (h.C[f + 1] - h.C[f]), ei: e, ta: q.t, fi: f, tb: q.u });
        }
      }
    }
  });

  // 3) Agrupar cruces consecutivos (tramos que van juntos) y conservar el primero y el último de cada grupo
  const stops = []; // { seg, d, i, t, partner }
  const addStop = (seg, d, i, t) => { stops.push({ seg, d, i, t, partner: -1 }); return stops.length - 1; };
  for (const { si, sj, list } of pairs.values()) {
    list.sort((a, b) => a.da - b.da);
    const keep = []; let cluster = [list[0]];
    const flush = () => { keep.push(cluster[0]); if (cluster.length > 1) keep.push(cluster.at(-1)); };
    for (let k = 1; k < list.length; k++) {
      const prev = cluster.at(-1), cur = list[k];
      if (cur.da - prev.da <= 150 && Math.abs(cur.db - prev.db) <= 400) cluster.push(cur); else { flush(); cluster = [cur]; }
    }
    flush();
    for (const j of keep) {
      const a = addStop(si, j.da, j.ei, j.ta), b = addStop(sj, j.db, j.fi, j.tb);
      stops[a].partner = b; stops[b].partner = a;
    }
  }
  const dOf = (si, p) => geo[si].C[p.i] + p.t * (geo[si].C[p.i + 1] - geo[si].C[p.i]);
  const sStop = addStop(S, dOf(S, start.pr), start.pr.i, start.pr.t);
  const eStop = addStop(E, dOf(E, end.pr), end.pr.i, end.pr.t);

  const bySeg = new Map();
  stops.forEach((s, id) => { if (!bySeg.has(s.seg)) bySeg.set(s.seg, []); bySeg.get(s.seg).push(id); });
  const rank = new Int32Array(stops.length);
  for (const arr of bySeg.values()) { arr.sort((x, y) => stops[x].d - stops[y].d); arr.forEach((id, k) => { rank[id] = k; }); }

  // 4) Dijkstra con estado (parada, cambios de camino usados)
  const K = maxTransitions + 1, dist = new Float64Array(stops.length * K).fill(Infinity), pred = new Int32Array(stops.length * K).fill(-1);
  const heap = new Heap(); dist[sStop * K] = 0; heap.push(0, sStop * K);
  let goal = -1;
  while (heap.size) {
    const [c, st] = heap.pop();
    if (c > dist[st]) continue;
    const id = Math.floor(st / K), k = st % K, s = stops[id];
    if (id === eStop) { goal = st; break; }
    const relax = (nid, nk, cost) => { const ns = nid * K + nk; if (cost < dist[ns]) { dist[ns] = cost; pred[ns] = st; heap.push(cost, ns); } };
    const list = bySeg.get(s.seg), r = rank[id];
    if (r > 0) relax(list[r - 1], k, c + Math.abs(s.d - stops[list[r - 1]].d));
    if (r < list.length - 1) relax(list[r + 1], k, c + Math.abs(stops[list[r + 1]].d - s.d));
    if (s.partner >= 0) {
      const p = stops[s.partner], diff = rid[s.seg] !== rid[p.seg];
      if (!diff) relax(s.partner, k, c);
      else if (k + 1 <= maxTransitions) relax(s.partner, k + 1, c + penalty);
    }
  }
  if (goal < 0) return null;

  // 5) Reconstruir tramos recorridos y agruparlos por camino
  const path = []; for (let st = goal; st >= 0; st = pred[st]) path.push(Math.floor(st / K));
  path.reverse();
  const posOf = (id) => { const s = stops[id], p = segs[s.seg].seg.pts, a = p[s.i], b = p[s.i + 1]; return { i: s.i, t: s.t, point: [a[0] + s.t * (b[0] - a[0]), a[1] + s.t * (b[1] - a[1])] }; };
  const pieces = []; let cur = null;
  path.forEach((id, n) => {
    if (!cur) { cur = { si: stops[id].seg, from: posOf(id), to: posOf(id) }; return; }
    if (stops[path[n - 1]].partner === id) { pieces.push(cur); cur = { si: stops[id].seg, from: posOf(id), to: posOf(id) }; } else cur.to = posOf(id);
  });
  pieces.push(cur);
  const sections = [];
  for (const p of pieces) {
    const line = sliceLine(segs[p.si].seg.pts, p.from, p.to);
    if (line.length < 2 || lenKm([line]) < 0.002) continue; // piezas de longitud nula (cruce justo en el punto marcado)
    const last = sections.at(-1);
    if (last && last.rid === rid[p.si]) last.lines.push(line); else sections.push({ rid: rid[p.si], route: segs[p.si].route, lines: [line] });
  }
  if (!sections.length) return null;
  return { sections: sections.map(({ route, lines }) => ({ route, lines })), km: lenKm(sections.flatMap((s) => s.lines)) };
}
