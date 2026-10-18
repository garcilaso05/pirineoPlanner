// perf.js — Gestor de rendimiento adaptativo.
// Mide fluidez real (fotogramas durante el movimiento del mapa, tareas largas, memoria) y ajusta
// presupuestos (rutas en pantalla, puntos, descargas simultáneas, simplificación, esperas).
// Baja de nivel rápido si el equipo sufre y sube despacio cuando va holgado.

const nav = navigator;
export const coarse = matchMedia('(pointer: coarse)').matches;
const mem = nav.deviceMemory || (coarse ? 4 : 8);
const cores = nav.hardwareConcurrency || 4;
const saveData = !!nav.connection?.saveData;

// 0 = ahorro, 1 = equilibrado, 2 = máximo
export const PROFILES = [
  { name: 'ahorro', routesMul: 0.45, minRoutes: 3, routeCache: 20, pois: 10, fetchConc: 1, refreshDelay: 320, simplifyPx: 2.4, tooltips: false, mouseMs: 90, exportPx: 1200 },
  { name: 'equilibrado', routesMul: 0.75, minRoutes: 4, routeCache: 50, pois: 20, fetchConc: 2, refreshDelay: 180, simplifyPx: 1.3, tooltips: true, mouseMs: 40, exportPx: 1600 },
  { name: 'máximo', routesMul: 1, minRoutes: 5, routeCache: 120, pois: 35, fetchConc: 3, refreshDelay: 100, simplifyPx: 0.7, tooltips: true, mouseMs: 16, exportPx: 2000 },
];

let tier = saveData || mem <= 2 || cores <= 2 ? 0 : (coarse || mem <= 4 || cores <= 4 ? 1 : 2);
const CEIL = saveData ? 1 : 2;
let forced = null;            // el usuario puede fijar «ahorro»
let lastChange = 0, badStreak = 0, goodStreak = 0;
const listeners = new Set();

const emit = (reason) => listeners.forEach((f) => { try { f({ tier: perf.tier, profile: perf.profile, reason }); } catch { /* ignorar */ } });
function setTier(n, reason) {
  n = Math.max(0, Math.min(CEIL, n));
  if (n === tier) return;
  tier = n; lastChange = performance.now(); badStreak = goodStreak = 0;
  if (!forced) emit(reason);
}

export const perf = {
  coarse,
  hidden: document.hidden,
  get tier() { return forced ?? tier; },
  get profile() { return PROFILES[forced ?? tier]; },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  /** Fija el modo ahorro manualmente (true) o vuelve al automático (false). */
  setSaver(on) { forced = on ? 0 : null; emit('manual'); },
  get saver() { return forced === 0; },
  routeBudget(base) { return Math.max(this.profile.minRoutes, Math.round(base * this.profile.routesMul)); },
  /** Ejecuta cuando el navegador está ocioso (o tras `timeout` ms). */
  idle(fn, timeout = 1200) {
    if ('requestIdleCallback' in window) return requestIdleCallback(fn, { timeout });
    return setTimeout(() => fn({ timeRemaining: () => 8 }), 40);
  },
  /** Cede el hilo principal para que el mapa pueda responder entre tareas pesadas. */
  yield() {
    if (globalThis.scheduler?.yield) return scheduler.yield();
    return new Promise((r) => setTimeout(r, 0));
  },
  interactionStart, interactionEnd,
};

/* ---------- Muestreo de fotogramas durante el movimiento ---------- */
let sampling = false, last = 0, frames = [], rafId = 0;
function tick(t) {
  if (!sampling) return;
  if (last) frames.push(t - last);
  last = t; rafId = requestAnimationFrame(tick);
}
function interactionStart() {
  if (sampling || document.hidden) return;
  sampling = true; last = 0; frames = [];
  rafId = requestAnimationFrame(tick);
}
function interactionEnd() {
  if (!sampling) return;
  sampling = false; cancelAnimationFrame(rafId);
  if (forced !== null || frames.length < 8) return;
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const slow = frames.filter((d) => d > 48).length / frames.length;
  const worst = Math.max(...frames);
  const cool = performance.now() - lastChange > 15000;
  if (slow > 0.35 || avg > 42 || worst > 700) {
    goodStreak = 0;
    if (++badStreak >= 2 || worst > 700) setTier(tier - 1, 'fotogramas');
  } else if (avg < 20 && slow < 0.08) {
    badStreak = 0;
    if (cool && ++goodStreak >= 6) setTier(tier + 1, 'holgado');
  } else { badStreak = Math.max(0, badStreak - 1); }
}

/* ---------- Tareas largas y memoria (Chromium) ---------- */
try {
  let longMs = 0, since = performance.now();
  new PerformanceObserver((list) => {
    const now = performance.now();
    if (now - since > 8000) { longMs = 0; since = now; }
    for (const e of list.getEntries()) longMs += e.duration;
    if (longMs > 1800 && forced === null && now - lastChange > 8000) { longMs = 0; setTier(tier - 1, 'tareas largas'); }
  }).observe({ entryTypes: ['longtask'] });
} catch { /* no soportado */ }

setInterval(() => {
  const m = performance.memory;
  if (!m || document.hidden) return;
  if (m.usedJSHeapSize > 0.8 * m.jsHeapSizeLimit) { setTier(tier - 1, 'memoria'); emit('memoria'); }
}, 10000);

document.addEventListener('visibilitychange', () => { perf.hidden = document.hidden; if (document.hidden) interactionEnd(); });
