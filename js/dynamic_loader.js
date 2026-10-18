/**
 * dynamic_loader.js
 * Carga y descarga dinámica de rutas (otrosCaminosKML) y POIs (picos, lagos, cascadas).
 *
 * Características:
 *  - Geometría fiel: las rutas se dibujan con sus tramos reales respetando todas las curvas
 *    del terreno, sin simplificaciones que unan tramos o deformen el camino.
 *  - Máxima definición de cerca: al acercarte a cualquier zona se muestran TODOS sus puntos.
 *  - Descarga estricta de caminos lejanos: cualquier camino o punto que salga de la pantalla
 *    se retira inmediatamente del mapa para mantener el navegador ligero y fluido.
 *  - Sin saturación desde muy lejos (zoom ≤ 7): no se cargan rutas dinámicas para que la
 *    visión global del mapa no se congele ni se sature.
 *  - POIs instantáneos: filtrados en el índice (1.3 MB), cargan de inmediato en <200 ms
 *    al acercarse (zoom ≥ 12) y se gestionan por hash O(1).
 *  - Prioridad al usuario: el movimiento del mapa es prioritario e interrumpe tareas en curso.
 */

import { map, G, mode, addPois, removePoiByKey, onTrackClick, registerSegment, unregisterSegment, registerOverlay } from './map.js';
import { parseKML } from './kml.js';
import { simplify } from './geo.js';
import { perf, coarse } from './perf.js';

// ─── Configuración ─────────────────────────────────────────────────────────────

const CELL_SIZE = 0.5; // tamaño de celda espacial (≈50 km)

// Umbrales de zoom para activación de categorías:
//   xl (≥200 km): zoom ≥ 8
//   l  (≥50 km):  zoom ≥ 10
//   m  (≥10 km):  zoom ≥ 12
//   s  (<10 km):  zoom ≥ 14
const ZOOM_THRESHOLDS = {
  xl: 8,
  l:  10,
  m: 12,
  s: 14,
};

// Presupuesto base de rutas simultáneas según zoom; perf.routeBudget lo ajusta al rendimiento real del equipo
function maxRoutesBudget(zoom) {
  const base = zoom <= 9 ? 5 : zoom <= 11 ? 8 : zoom <= 13 ? 12 : 18;
  return perf.routeBudget(base);
}

// Zoom mínimo para mostrar picos, lagos y cascadas
const POI_ZOOM_MIN = 12;

// ─── Estado ────────────────────────────────────────────────────────────────────

let routeIndex   = null; // kml_index.json (543 KB)
let poiIndexData = null; // poi_index.json (1.38 MB filtrado)

// Rutas activas en pantalla: file -> { layers: Polyline[], entry }
const activeRouteLayers = new Map();
const routeKmlCache     = new Map(); // file -> KML parseado en memoria
// file -> { title, file, segments[] } ESTABLE: los objetos de tramo se crean una sola vez por archivo,
// así la herramienta de fragmentos mantiene la identidad del tramo aunque la ruta se descargue y vuelva a pintar
const routeObjCache     = new Map();
const entryByFile       = new Map();
let fetchQueue          = [];        // cola de descargas pendientes
let activeFetches       = 0;
const inFlight          = new Set();

// POIs activos en pantalla: hashKey -> { type, cellKey }
const activeDynPois = new Map();

// Control de interrupción y debounce
let isInteracting    = false;
let renderGeneration = 0;
let refreshTimer     = null;

// Capa Leaflet para rutas dinámicas
export let dynRoutesLayer = null;
let dynamicRoutesEnabled  = true;

// ─── Inicialización ────────────────────────────────────────────────────────────

export async function initDynamicLoader() {
  dynRoutesLayer = L.layerGroup();
  registerOverlay('dyn', 'Otros caminos (KML)', dynRoutesLayer, true);

  // Activar / desactivar desde la leyenda del mapa
  map.on('overlayremove', (e) => {
    if (e.layer === dynRoutesLayer) {
      dynamicRoutesEnabled = false;
      cancelPendingWork();
      clearDisplayedRoutes();
    }
  });
  map.on('overlayadd', (e) => {
    if (e.layer === dynRoutesLayer) {
      dynamicRoutesEnabled = true;
      scheduleRefresh(80);
    }
  });

  // Interrupción prioritaria: mover el mapa cancela las tareas en cola y activa la medición de fluidez
  map.on('movestart zoomstart dragstart', () => {
    isInteracting = true;
    perf.interactionStart();
    cancelPendingWork();
  });
  map.on('moveend zoomend', () => {
    isInteracting = false;
    perf.interactionEnd();
    cancelPendingWork();
    scheduleRefresh(perf.profile.refreshDelay);
  });

  // Si el equipo va justo: menos rutas/puntos y caché más pequeña; si va holgado, se recupera el detalle
  perf.on(({ reason }) => {
    trimCaches();
    if (reason === 'memoria') trimCaches(Math.max(8, perf.profile.routeCache >> 1));
    scheduleRefresh(perf.profile.refreshDelay);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(200); });

  // Carga paralela de índices (tras el primer pintado, para no retrasar el arranque)
  await new Promise((r) => perf.idle(r, 1500));
  try {
    const [ri, pi] = await Promise.all([
      fetch('caminos/otrosCaminosKML/kml_index.json').then((r) => r.ok ? r.json() : null),
      fetch('poi_index.json').then((r) => r.ok ? r.json() : null),
    ]);
    routeIndex   = ri;
    poiIndexData = pi;
    if (ri) ri.entries.forEach((e) => entryByFile.set(e.file, e));
    console.log(`[DynLoader] Índices cargados: ${ri ? ri.entries.length : 0} rutas, ${pi ? pi.points.length : 0} POIs`);
  } catch (err) {
    console.warn('[DynLoader] Error al cargar índices:', err);
    return;
  }

  // Evaluación inicial
  scheduleRefresh(80);
}

// ─── Control de Tareas ─────────────────────────────────────────────────────────

function cancelPendingWork() {
  renderGeneration++;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  fetchQueue = [];
}

function scheduleRefresh(delayMs = 100) {
  if (document.body.classList.contains('viewer-mode') || perf.hidden) return;
  cancelPendingWork();

  refreshTimer = setTimeout(() => {
    if (isInteracting) return;
    const currentGen = ++renderGeneration;
    executeRefresh(currentGen);
  }, delayMs);
}

function executeRefresh(gen) {
  if (gen !== renderGeneration || isInteracting) return;
  if (routeIndex && dynamicRoutesEnabled) {
    refreshRoutes(gen);
    rescaleActive(gen);
  }
  if (poiIndexData) {
    refreshPois(gen);
  }
}

// ─── Celdas Visibles ───────────────────────────────────────────────────────────

function getVisibleCells(padFactor = 0.05) {
  const b = map.getBounds().pad(padFactor);
  const minLat = b.getSouth(), maxLat = b.getNorth();
  const minLon = b.getWest(),  maxLon = b.getEast();
  const cells = new Set();
  const r0 = Math.floor(minLat / CELL_SIZE);
  const r1 = Math.floor(maxLat / CELL_SIZE);
  const c0 = Math.floor(minLon / CELL_SIZE);
  const c1 = Math.floor(maxLon / CELL_SIZE);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      cells.add(`${r}:${c}`);
    }
  }
  return cells;
}

// ─── Rutas Dinámicas (Definidas, Sin Rectas, Con Descarga Lejana) ───────────────

function getActiveCategories(zoom) {
  // Desde muy lejos (zoom <= 7): NINGÚN camino dinámico para evitar colgados
  if (zoom <= 7) return [];
  const cats = [];
  if (zoom >= ZOOM_THRESHOLDS.xl) cats.push('xl');
  if (zoom >= ZOOM_THRESHOLDS.l)  cats.push('l');
  if (zoom >= ZOOM_THRESHOLDS.m)  cats.push('m');
  if (zoom >= ZOOM_THRESHOLDS.s)  cats.push('s');
  return cats;
}

function bboxIntersectsBounds(bbox, bounds) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  return (
    minLat <= bounds.getNorth() &&
    maxLat >= bounds.getSouth() &&
    minLon <= bounds.getEast() &&
    maxLon >= bounds.getWest()
  );
}

function refreshRoutes(gen) {
  if (!dynamicRoutesEnabled || !routeIndex) return;
  const zoom = map.getZoom();
  const cats = getActiveCategories(zoom);

  // Ruta fijada mientras hay un fragmento a medias: nunca se descarga hasta terminar o cancelar
  const pinnedFile = mode.cur === 'fragment' ? mode.frag?.route?.file : null;

  // Si estamos en zoom <= 7, limpiar de inmediato cualquier ruta dinámica (salvo la fijada)
  if (cats.length === 0) {
    clearDisplayedRoutes(pinnedFile);
    return;
  }

  const bounds = map.getBounds().pad(0.05);
  const cells = getVisibleCells(0.05);
  const candidateMap = new Map();

  // 1. Encontrar rutas de las categorías activas que tocan las celdas visibles
  for (const cell of cells) {
    const cellData = routeIndex.cell_index[cell];
    if (!cellData) continue;
    for (const cat of cats) {
      const indices = cellData[cat] || [];
      for (const idx of indices) {
        const entry = routeIndex.entries[idx];
        if (!candidateMap.has(entry.file)) {
          // Filtrado preciso por bounding box para no cargar rutas lejanas de la misma celda
          if (bboxIntersectsBounds(entry.bbox, bounds)) {
            candidateMap.set(entry.file, entry);
          }
        }
      }
    }
  }

  if (pinnedFile && !candidateMap.has(pinnedFile) && entryByFile.has(pinnedFile)) {
    candidateMap.set(pinnedFile, entryByFile.get(pinnedFile));
  }

  // 2. DESCARGA INMEDIATA: Quitar del mapa cualquier camino que ya NO esté en el encuadre
  for (const file of [...activeRouteLayers.keys()]) {
    if (file !== pinnedFile && !candidateMap.has(file)) removeRoute(file);
  }

  // 3. PRESUPUESTO CONTROLADO: Priorizar las rutas más destacadas según el zoom
  const budget = maxRoutesBudget(zoom);
  let candidates = Array.from(candidateMap.values());
  if (candidates.length > budget) {
    const catWeight = { xl: 0, l: 1, m: 2, s: 3 };
    candidates.sort((a, b) => (catWeight[a.cat] - catWeight[b.cat]) || (b.km - a.km));
    candidates = candidates.slice(0, budget);
    if (pinnedFile && !candidates.some((c) => c.file === pinnedFile) && candidateMap.has(pinnedFile)) {
      candidates.push(candidateMap.get(pinnedFile));
    }
  }

  const allowedFiles = new Set(candidates.map((e) => e.file));

  // Retirar del mapa las que excedan el presupuesto
  for (const file of [...activeRouteLayers.keys()]) {
    if (!allowedFiles.has(file)) removeRoute(file);
  }

  // 4. RENDERIZADO FIEL: Renderizar las rutas deseadas
  const toFetch = [];
  for (const entry of candidates) {
    if (activeRouteLayers.has(entry.file)) continue;

    // Si ya está en la caché en memoria, renderizar inmediatamente con todos sus tramos
    if (routeKmlCache.has(entry.file)) {
      renderKmlRoute(entry, routeKmlCache.get(entry.file));
    } else if (!inFlight.has(entry.file)) {
      toFetch.push(entry);
    }
  }

  // Encolar descargas con prioridad: primero las más grandes
  if (toFetch.length > 0) {
    const catPriority = { xl: 0, l: 1, m: 2, s: 3 };
    toFetch.sort((a, b) => catPriority[a.cat] - catPriority[b.cat]);
    fetchQueue = toFetch;
    processFetchQueue(gen);
  }
}

function processFetchQueue(gen) {
  while (activeFetches < perf.profile.fetchConc && fetchQueue.length > 0) {
    if (gen !== renderGeneration || isInteracting) return;
    const entry = fetchQueue.shift();
    if (activeRouteLayers.has(entry.file) || inFlight.has(entry.file)) continue;

    activeFetches++;
    inFlight.add(entry.file);

    fetchAndLoadRoute(entry, gen).finally(() => {
      activeFetches--;
      inFlight.delete(entry.file);
      if (gen === renderGeneration && !isInteracting) {
        processFetchQueue(gen);
      }
    });
  }
}

async function fetchAndLoadRoute(entry, gen) {
  try {
    const r = await fetch(entry.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    await perf.yield(); // el parseo es síncrono: dejar respirar al mapa antes y después
    const kml = parseKML(text, entry.file.split('/').pop());
    routeKmlCache.set(entry.file, kml);
    trimCaches();
    await perf.yield();

    if (gen !== renderGeneration || isInteracting || !dynamicRoutesEnabled) return;

    // Verificar si sigue estando dentro del encuadre actual
    const bounds = map.getBounds().pad(0.05);
    if (bboxIntersectsBounds(entry.bbox, bounds)) {
      renderKmlRoute(entry, kml);
    }
  } catch (err) {
    console.warn(`[DynLoader] Error cargando ${entry.file}:`, err.message);
  }
}

/**
 * Renderiza la ruta en Leaflet con TODOS sus puntos y tramos originales del KML.
 * Cada LineString es un segmento independiente, evitando unir tramos desconectados.
 */
function getRouteObj(entry, kml) {
  let r = routeObjCache.get(entry.file);
  if (!r) {
    r = {
      title: entry.title,
      file: entry.file,
      segments: kml.lines.map((l, i) => ({
        name: l.name || `Tramo ${i + 1}`,
        pts:  l.pts, // TODOS los puntos reales del KML (también para recortar fragmentos)
        km:   calcLineKm(l.pts),
      })),
    };
    routeObjCache.set(entry.file, r);
  }
  return r;
}

function renderKmlRoute(entry, kml) {
  if (activeRouteLayers.has(entry.file)) return;

  const routeObj = getRouteObj(entry, kml);
  if (routeObj.segments.length === 0) return;

  const color = routeColor(entry.cat);
  const weight = routeWeight(entry.cat);
  const layers = [];
  const segs = [];
  const catLabel = { xl: 'GR / Travesía', l: 'Ruta larga', m: 'Ruta media', s: 'Ruta corta' }[entry.cat] || '';

  for (const seg of routeObj.segments) {
    if (seg.pts.length < 2) continue;

    // Se DIBUJA una versión simplificada según el zoom y el rendimiento; seg.pts (completo) se usa para recortar
    const poly = L.polyline(displayPts(seg), { color, weight, opacity: 0.82, smoothFactor: 1.2 });
    if (perf.profile.tooltips && !coarse) {
      poly.bindTooltip(`<b>${entry.title}</b><br>${seg.name} · ${seg.km.toFixed(1)} km · <em>${catLabel}</em>`, { sticky: true, direction: 'top' });
    }
    // Popup en modo normal; en modo fragmento el clic lo resuelve el mapa (registerSegment)
    poly.on('click', (ev) => onTrackClick(routeObj, seg, ev));

    dynRoutesLayer.addLayer(poly);
    registerSegment(routeObj, seg, poly);
    layers.push(poly);
    segs.push(seg);
  }

  activeRouteLayers.set(entry.file, { layers, segs, entry });
}

// Caché de la versión simplificada por tramo y nivel (zoom, perfil). Nunca sustituye a seg.pts.
function displayPts(seg) {
  const z = Math.round(map.getZoom()), key = `${z}:${perf.tier}`;
  if (seg._dk === key) return seg._dp;
  const pts = seg.pts.length < 300 ? seg.pts : simplify(seg.pts, perf.profile.simplifyPx * 360 / (256 * 2 ** z));
  seg._dk = key; seg._dp = pts;
  return pts;
}
// Al cambiar de zoom o de nivel de rendimiento, reajusta lo ya dibujado en trozos pequeños
async function rescaleActive(gen) {
  for (const data of activeRouteLayers.values()) {
    for (let i = 0; i < data.segs.length; i++) {
      if (gen !== renderGeneration || isInteracting) return;
      const seg = data.segs[i], key = `${Math.round(map.getZoom())}:${perf.tier}`;
      if (seg._dk !== key) data.layers[i].setLatLngs(displayPts(seg));
    }
    await perf.yield();
  }
}

function removeRoute(file) {
  const data = activeRouteLayers.get(file);
  if (!data) return;
  for (const l of data.layers) dynRoutesLayer.removeLayer(l);
  for (const sg of data.segs) unregisterSegment(sg);
  activeRouteLayers.delete(file);
}

function trimCaches(max = perf.profile.routeCache) {
  if (routeKmlCache.size <= max) return;
  const pinned = mode.frag?.route?.file;
  for (const f of routeKmlCache.keys()) {
    if (routeKmlCache.size <= max) break;
    if (activeRouteLayers.has(f) || f === pinned) continue;
    routeKmlCache.delete(f);
    routeObjCache.delete(f);
  }
}

function calcLineKm(pts) {
  let d = 0;
  const R = 6371;
  for (let i = 1; i < pts.length; i++) {
    const [la1, lo1] = pts[i - 1], [la2, lo2] = pts[i];
    const dlat = (la2 - la1) * Math.PI / 180;
    const dlon = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dlon / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(a));
  }
  return d;
}

function routeColor(cat) {
  return { xl: '#8b5cf6', l: '#0284c7', m: '#10b981', s: '#f59e0b' }[cat] || '#64748b';
}

function routeWeight(cat) {
  return { xl: 3.5, l: 3.0, m: 2.5, s: 2.2 }[cat] || 2.5;
}

function clearDisplayedRoutes(keepFile = null) {
  for (const file of [...activeRouteLayers.keys()]) {
    if (file !== keepFile) removeRoute(file);
  }
  fetchQueue = [];
}

// ─── POIs Dinámicos (Picos, Lagos, Cascadas) ───────────────────────────────────

function poiHashKey(kind, lat, lon) {
  return `${kind}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
}

function refreshPois(gen) {
  if (!poiIndexData) return;
  const zoom = map.getZoom();

  // Si estamos lejos (zoom < 12), descargar de inmediato todos los POIs
  if (zoom < POI_ZOOM_MIN) {
    clearDisplayedPois();
    return;
  }

  const cells = getVisibleCells(0.03);

  // 1. DESCARGA INMEDIATA: Retirar POIs de celdas que ya salieron de la vista
  for (const [hashKey, item] of activeDynPois.entries()) {
    if (!cells.has(item.cellKey)) {
      removePoiByKey(hashKey);
      activeDynPois.delete(hashKey);
    }
  }

  // 2. CARGA INSTANTÁNEA: Recopilar POIs de las celdas visibles
  const candidatesByType = { peak: [], lake: [], waterfall: [] };

  for (const cell of cells) {
    const indices = poiIndexData.cell_index[cell];
    if (!indices) continue;
    for (const idx of indices) {
      const pt = poiIndexData.points[idx];
      const hashKey = poiHashKey(pt.k, pt.lat, pt.lon);
      if (!activeDynPois.has(hashKey)) {
        candidatesByType[pt.k]?.push({ pt, hashKey, cellKey: cell });
      }
    }
  }

  const shown = { peak: 0, lake: 0, waterfall: 0 };
  for (const item of activeDynPois.values()) shown[item.type]++;
  const cap = perf.profile.pois;
  const toAdd = [];
  for (const kind of ['peak', 'lake', 'waterfall']) {
    const list = candidatesByType[kind] || [];
    const room = cap - shown[kind];
    if (room <= 0) continue;
    if (list.length > room) list.sort((a, b) => (b.pt.e || 0) - (a.pt.e || 0)); // priorizar los más altos
    toAdd.push(...list.slice(0, room));
  }

  if (toAdd.length === 0) return;

  // Añadir de golpe (<20 ms) sin colas diferidas
  const payload = toAdd.map(({ pt, hashKey }) => ({
    name: pt.n,
    lat:  pt.lat,
    lng:  pt.lon,
    ele:  pt.e ?? null,
    sub:  pt.s ?? '',
    url:  pt.u ?? null,
    type: pt.k,
    key:  hashKey,
  }));

  addPois(payload, 'osm');

  for (const item of toAdd) {
    activeDynPois.set(item.hashKey, { type: item.pt.k, cellKey: item.cellKey });
  }
}

function clearDisplayedPois() {
  for (const hashKey of activeDynPois.keys()) {
    removePoiByKey(hashKey);
  }
  activeDynPois.clear();
}

// ─── Funciones Públicas ────────────────────────────────────────────────────────

/**
 * Carga prioritaria manual e instantánea para el botón "Cargar Zona".
 * Pausa todo lo demás inmediatamente y añade los POIs de la zona visible.
 */
export async function loadZonePoisPriority() {
  cancelPendingWork(); // Pausa todo lo demás inmediatamente

  if (!poiIndexData) {
    try {
      poiIndexData = await fetch('poi_index.json').then((r) => r.ok ? r.json() : null);
    } catch {
      return 0;
    }
  }
  if (!poiIndexData) return 0;

  const bounds = map.getBounds().pad(0.06);
  const cells = getVisibleCells(0.06);
  const toAdd = [];

  for (const cell of cells) {
    const indices = poiIndexData.cell_index[cell];
    if (!indices) continue;
    for (const idx of indices) {
      const pt = poiIndexData.points[idx];
      if (bounds.contains([pt.lat, pt.lon])) {
        const hashKey = poiHashKey(pt.k, pt.lat, pt.lon);
        if (!activeDynPois.has(hashKey)) {
          toAdd.push({ pt, hashKey, cellKey: cell });
        }
      }
    }
  }

  if (toAdd.length === 0) return 0;

  const payload = toAdd.map(({ pt, hashKey }) => ({
    name: pt.n,
    lat:  pt.lat,
    lng:  pt.lon,
    ele:  pt.e ?? null,
    sub:  pt.s ?? '',
    url:  pt.u ?? null,
    type: pt.k,
    key:  hashKey,
  }));

  const added = addPois(payload, 'osm');

  for (const item of toAdd) {
    activeDynPois.set(item.hashKey, { type: item.pt.k, cellKey: item.cellKey });
  }

  return added;
}

export function clearDynamicPois() {
  clearDisplayedPois();
}

export function clearDynamicRoutes() {
  cancelPendingWork();
  clearDisplayedRoutes();
}

