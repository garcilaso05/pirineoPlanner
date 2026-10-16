/**
 * dynamic_loader.js
 * Carga y descarga dinámica de alto rendimiento para PirineoPlanner.
 *
 * Optimizaciones clave:
 *  1. Prioridad absoluta a la interacción: arrastrar o hacer zoom en el mapa interrumpe
 *     inmediatamente cualquier cálculo o renderizado en curso.
 *  2. Muestreo inteligente de coordenadas (% de puntos según zoom): los caminos muy grandes,
 *     grandes y medianos se dibujan desde lejos con un porcentaje reducido de vértices (5-20%),
 *     reduciendo el peso de renderizado un 90% y aumentando el detalle al acercarse.
 *  3. Límite de saturación visual: se limita el presupuesto de caminos simultáneos en pantalla.
 *  4. POIs cercanos al suelo (zoom ≥ 13): picos, lagos y cascadas solo aparecen cuando se está
 *     cerca, borrándose de inmediato de la memoria y del mapa en cuanto salen de la vista.
 *  5. Búsqueda y gestión por Hash O(1) con identificadores únicos estables.
 *  6. Renderizado en segundo plano por lotes (time-slicing con requestAnimationFrame).
 */

import { map, G, addPois, removePoiByKey, onTrackClick } from './map.js';
import { parseKML } from './kml.js';

// ─── Constantes y Configuración ────────────────────────────────────────────────

const CELL_SIZE = 0.5; // tamaño en grados de la celda espacial (≈50 km)

// Umbrales de zoom refinados para evitar saturación:
//   xl: rutas transpirenaicas muy grandes (≥200 km) -> zoom ≥ 8
//   l:  rutas grandes (≥50 km)                      -> zoom ≥ 10
//   m:  rutas medianas (≥10 km)                     -> zoom ≥ 12
//   s:  rutas cortas y paseos (<10 km)              -> zoom ≥ 14
const ZOOM_THRESHOLDS = {
  xl: 8,
  l:  10,
  m: 12,
  s: 14,
};

// Zoom mínimo para POIs (picos, lagos, cascadas): cerca del suelo
const POI_ZOOM_MIN = 13;

// Límites máximos por pantalla para evitar saturación visual y sobrecarga del navegador
const MAX_VISIBLE_ROUTES = 28;
const MAX_POIS_PER_TYPE  = 40;

// Concurrencia de descargas HTTP simultáneas
const FETCH_CONCURRENCY = 3;

// ─── Estado Global ─────────────────────────────────────────────────────────────

let routeIndex   = null; // kml_index.json
let poiIndexData = null; // poi_index.json

// Rutas activas en pantalla: file -> { cat, layers: Polyline[], zoomRendered, entry, segments }
const activeRouteLayers = new Map();
const routeKmlCache     = new Map(); // file -> parsed KML
let fetchQueue          = [];        // cola de { file, entry }
let activeFetches       = 0;
const inFlight          = new Set(); // archivos actualmente en descarga

// POIs activos en pantalla: hashKey -> { type, cellKey }
const activeDynPois = new Map();

// Control de interrupción y tareas en segundo plano
let isInteracting    = false;
let renderGeneration = 0;
let refreshTimer     = null;
let animFrameId      = null;

// Capa Leaflet para rutas dinámicas
export let dynRoutesLayer = null;
let dynamicRoutesEnabled  = true;

// ─── Inicialización ────────────────────────────────────────────────────────────

export async function initDynamicLoader(layerControl) {
  dynRoutesLayer = L.layerGroup().addTo(map);
  if (layerControl) {
    layerControl.addOverlay(dynRoutesLayer, 'Caminos dinámicos (otros caminos)');
  }

  // Control de activación desde la leyenda
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
      scheduleIdleRefresh(100);
    }
  });

  // Interrupción prioritaria: arrastrar o hacer zoom congela cargas en curso
  map.on('movestart zoomstart dragstart', () => {
    isInteracting = true;
    cancelPendingWork();
  });

  map.on('moveend zoomend', () => {
    isInteracting = false;
    cancelPendingWork();
    // Debounce: solo cuando el usuario se detiene de verdad (280ms)
    scheduleIdleRefresh(280);
  });

  // Carga asíncrona de índices precalculados
  try {
    const [ri, pi] = await Promise.all([
      fetch('caminos/otrosCaminosKML/kml_index.json').then((r) => r.ok ? r.json() : null),
      fetch('poi_index.json').then((r) => r.ok ? r.json() : null),
    ]);
    routeIndex   = ri;
    poiIndexData = pi;
    console.log(`[DynLoader] Índices cargados: ${ri ? ri.entries.length : 0} rutas, ${pi ? pi.points.length : 0} POIs`);
  } catch (err) {
    console.warn('[DynLoader] No se pudieron cargar los índices:', err);
    return;
  }

  // Primera carga si no estamos interactuando
  scheduleIdleRefresh(150);
}

// ─── Cancelación e Interrupción ────────────────────────────────────────────────

function cancelPendingWork() {
  renderGeneration++; // invalida cualquier bucle de renderizado activo
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  fetchQueue = []; // vaciar cola de peticiones no iniciadas
}

function scheduleIdleRefresh(delayMs = 250) {
  if (document.body.classList.contains('viewer-mode')) return;
  if (refreshTimer) clearTimeout(refreshTimer);

  refreshTimer = setTimeout(() => {
    if (isInteracting) return;
    const currentGen = ++renderGeneration;

    // Ejecutar en segundo plano mediante time-slicing
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => runRefreshPass(currentGen), { timeout: 400 });
    } else {
      setTimeout(() => runRefreshPass(currentGen), 10);
    }
  }, delayMs);
}

function runRefreshPass(gen) {
  if (gen !== renderGeneration || isInteracting) return;
  if (routeIndex && dynamicRoutesEnabled) {
    refreshRoutes(gen);
  }
  if (poiIndexData) {
    refreshPois(gen);
  }
}

// ─── Celdas Geográficas ────────────────────────────────────────────────────────

function visibleCells(padFactor = 0.08) {
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

// ─── Muestreo y Simplificación de Coordenadas (% según zoom) ───────────────────

/**
 * Reduce el número de vértices de un tramo según la lejanía (zoom).
 * De lejos se pinta un % bajo para máxima velocidad; de cerca, el 100%.
 */
function samplePointsForZoom(pts, zoom, cat) {
  const len = pts.length;
  if (len <= 4) return pts;

  let step = 1;
  if (zoom <= 8) {
    // Muy lejos: ~6% - 10% de coordenadas
    step = cat === 'xl' ? 14 : 10;
  } else if (zoom <= 10) {
    // Lejos: ~12% - 20%
    step = cat === 'xl' ? 8 : (cat === 'l' ? 6 : 4);
  } else if (zoom <= 12) {
    // Medio: ~25% - 40%
    step = cat === 'xl' ? 4 : (cat === 'l' ? 3 : 2);
  } else if (zoom <= 13) {
    // Cercano: ~50%
    step = 2;
  } else {
    // Cerca del suelo (zoom >= 14): 100% de los puntos
    step = 1;
  }

  if (step <= 1) return pts;

  const sampled = [pts[0]];
  for (let i = step; i < len - 1; i += step) {
    sampled.push(pts[i]);
  }
  sampled.push(pts[len - 1]);
  return sampled;
}

// ─── Rutas Dinámicas (Carga y Descarga) ────────────────────────────────────────

function getActiveCategories(zoom) {
  const cats = [];
  if (zoom >= ZOOM_THRESHOLDS.xl) cats.push('xl');
  if (zoom >= ZOOM_THRESHOLDS.l)  cats.push('l');
  if (zoom >= ZOOM_THRESHOLDS.m)  cats.push('m');
  if (zoom >= ZOOM_THRESHOLDS.s)  cats.push('s');
  return cats;
}

function refreshRoutes(gen) {
  if (!dynamicRoutesEnabled || !routeIndex) return;
  const zoom = map.getZoom();
  const cats = getActiveCategories(zoom);

  // Si estamos muy lejos (zoom < 8), limpiar caminos dinámicos para pantalla limpia
  if (cats.length === 0) {
    clearDisplayedRoutes();
    return;
  }

  const cells = visibleCells(0.08);
  const desiredFiles = new Map(); // file -> entry

  // Recopilar candidatos de las celdas visibles
  for (const cell of cells) {
    const cellData = routeIndex.cell_index[cell];
    if (!cellData) continue;
    for (const cat of cats) {
      const indices = cellData[cat] || [];
      for (const idx of indices) {
        const entry = routeIndex.entries[idx];
        if (!desiredFiles.has(entry.file)) {
          desiredFiles.set(entry.file, entry);
        }
      }
    }
  }

  // 1. DESCARGA: Retirar del mapa los que ya no están visibles o cuya categoría no corresponde
  for (const [file, data] of activeRouteLayers.entries()) {
    if (!desiredFiles.has(file)) {
      for (const l of data.layers) dynRoutesLayer.removeLayer(l);
      activeRouteLayers.delete(file);
    }
  }

  // Si hay más rutas deseadas que el presupuesto máximo, priorizar las más largas/relevantes
  let toConsider = Array.from(desiredFiles.values());
  if (toConsider.length > MAX_VISIBLE_ROUTES) {
    const catWeight = { xl: 0, l: 1, m: 2, s: 3 };
    toConsider.sort((a, b) => (catWeight[a.cat] - catWeight[b.cat]) || (b.km - a.km));
    toConsider = toConsider.slice(0, MAX_VISIBLE_ROUTES);
  }

  const finalDesiredFiles = new Set(toConsider.map((e) => e.file));

  // Retirar del mapa los que excedan el presupuesto
  for (const [file, data] of activeRouteLayers.entries()) {
    if (!finalDesiredFiles.has(file)) {
      for (const l of data.layers) dynRoutesLayer.removeLayer(l);
      activeRouteLayers.delete(file);
    }
  }

  // 2. CARGA: Identificar qué rutas faltan por añadir o necesitan actualizar resolución
  const toRenderNow = [];
  const toFetch     = [];

  for (const entry of toConsider) {
    const existing = activeRouteLayers.get(entry.file);
    if (existing) {
      // Si el nivel de zoom cambió sustancialmente (de lejos a cerca), actualizar resolución
      const zoomDiff = Math.abs(zoom - existing.zoomRendered);
      if (zoomDiff >= 2 && routeKmlCache.has(entry.file)) {
        for (const l of existing.layers) dynRoutesLayer.removeLayer(l);
        activeRouteLayers.delete(entry.file);
        toRenderNow.push(entry);
      }
    } else {
      if (routeKmlCache.has(entry.file)) {
        toRenderNow.push(entry);
      } else if (!inFlight.has(entry.file)) {
        toFetch.push(entry);
      }
    }
  }

  // Renderizar en lotes no bloqueantes las que ya están en memoria
  if (toRenderNow.length > 0) {
    renderRouteBatch(toRenderNow, zoom, gen);
  }

  // Encolar las que requieren descarga HTTP
  if (toFetch.length > 0) {
    const catPriority = { xl: 0, l: 1, m: 2, s: 3 };
    toFetch.sort((a, b) => catPriority[a.cat] - catPriority[b.cat]);
    fetchQueue = toFetch;
    processFetchQueue(gen);
  }
}

/**
 * Renderiza rutas en trozos pequeños (2 por frame) para no congelar la interfaz.
 */
function renderRouteBatch(list, zoom, gen) {
  let index = 0;
  function step() {
    if (gen !== renderGeneration || isInteracting) return;
    const end = Math.min(index + 2, list.length);
    for (; index < end; index++) {
      const entry = list[index];
      const kml = routeKmlCache.get(entry.file);
      if (kml) renderRoute(entry, kml, zoom);
    }
    if (index < list.length) {
      animFrameId = requestAnimationFrame(step);
    }
  }
  animFrameId = requestAnimationFrame(step);
}

function processFetchQueue(gen) {
  while (activeFetches < FETCH_CONCURRENCY && fetchQueue.length > 0) {
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
    const kml = parseKML(text, entry.file.split('/').pop());
    routeKmlCache.set(entry.file, kml);

    if (gen !== renderGeneration || isInteracting || !dynamicRoutesEnabled) return;

    const currentZoom = map.getZoom();
    const currentCats = getActiveCategories(currentZoom);
    if (!currentCats.includes(entry.cat)) return;

    renderRoute(entry, kml, currentZoom);
  } catch (err) {
    console.warn(`[DynLoader] Error al descargar ${entry.file}:`, err.message);
  }
}

function renderRoute(entry, kml, zoom) {
  if (activeRouteLayers.has(entry.file)) return;

  const segments = kml.lines.map((l, i) => ({
    name: l.name || `Tramo ${i + 1}`,
    pts:  l.pts, // coordenadas originales intactas para fragmentos e itinerario
    km:   calcLineKm(l.pts),
  }));
  if (segments.length === 0) return;

  const color = routeColor(entry.cat);
  const weight = routeWeight(entry.cat);
  const layers = [];

  const routeObj = {
    title: entry.title,
    segments,
  };

  for (const seg of segments) {
    if (seg.pts.length < 2) continue;

    // Muestreo adaptativo de coordenadas según zoom (optimización de rendimiento)
    const sampledPts = samplePointsForZoom(seg.pts, zoom, entry.cat);

    const poly = L.polyline(sampledPts, {
      color,
      weight,
      opacity: 0.8,
      smoothFactor: 2,
    });

    const catLabel = { xl: 'GR / Travesía', l: 'Ruta larga', m: 'Ruta media', s: 'Ruta corta' }[entry.cat] || '';
    poly.bindTooltip(`<b>${entry.title}</b><br>${seg.name} · ${seg.km.toFixed(1)} km · <em>${catLabel}</em>`, {
      sticky: true,
      direction: 'top',
    });

    // Clic en la ruta: utiliza los puntos originales intactos
    poly.on('click', (ev) => onTrackClick(routeObj, seg, ev));

    dynRoutesLayer.addLayer(poly);
    layers.push(poly);
  }

  activeRouteLayers.set(entry.file, {
    cat: entry.cat,
    layers,
    zoomRendered: zoom,
    entry,
  });
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
  return { xl: 4, l: 3.2, m: 2.5, s: 2 }[cat] || 2.5;
}

function clearDisplayedRoutes() {
  dynRoutesLayer.clearLayers();
  activeRouteLayers.clear();
  fetchQueue = [];
}

// ─── POIs Dinámicos (Picos, Lagos, Cascadas) ───────────────────────────────────

function poiHashKey(kind, lat, lon) {
  // Hash único con 5 decimales de precisión (resolución de ~1 metro)
  return `${kind}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
}

function refreshPois(gen) {
  if (!poiIndexData) return;
  const zoom = map.getZoom();

  // Si estamos lejos (zoom < 13), descargar de inmediato todos los POIs dinámicos
  if (zoom < POI_ZOOM_MIN) {
    clearDisplayedPois();
    return;
  }

  const cells = visibleCells(0.05); // margen ajustado para descargar rápido lo que no esté en vista

  // 1. DESCARGA INMEDIATA: Borrar de la memoria y de Leaflet los POIs que salieron del encuadre
  for (const [hashKey, item] of activeDynPois.entries()) {
    if (!cells.has(item.cellKey)) {
      removePoiByKey(hashKey);
      activeDynPois.delete(hashKey);
    }
  }

  // 2. CARGA: Identificar POIs en las celdas visibles que no estén ya cargados
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

  // Limitar por tipo para evitar saturación en zonas de muchos lagos o picos
  const toAdd = [];
  for (const kind of ['peak', 'lake', 'waterfall']) {
    const list = candidatesByType[kind] || [];
    // Si hay muchos, priorizar los de mayor altitud
    if (list.length > MAX_POIS_PER_TYPE) {
      list.sort((a, b) => (b.pt.e || 0) - (a.pt.e || 0));
    }
    toAdd.push(...list.slice(0, MAX_POIS_PER_TYPE));
  }

  if (toAdd.length === 0) return;

  // Renderizar los POIs en lotes no bloqueantes (20 por frame)
  renderPoisBatch(toAdd, gen);
}

function renderPoisBatch(list, gen) {
  let index = 0;
  function step() {
    if (gen !== renderGeneration || isInteracting) return;
    const end = Math.min(index + 20, list.length);
    const chunk = list.slice(index, end);

    const payload = chunk.map(({ pt, hashKey }) => ({
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

    for (const item of chunk) {
      activeDynPois.set(item.hashKey, { type: item.pt.k, cellKey: item.cellKey });
    }

    index = end;
    if (index < list.length) {
      animFrameId = requestAnimationFrame(step);
    }
  }
  animFrameId = requestAnimationFrame(step);
}

function clearDisplayedPois() {
  for (const hashKey of activeDynPois.keys()) {
    removePoiByKey(hashKey);
  }
  activeDynPois.clear();
}

// ─── Funciones Públicas de Limpieza ────────────────────────────────────────────

export function clearDynamicPois() {
  clearDisplayedPois();
}

export function clearDynamicRoutes() {
  cancelPendingWork();
  clearDisplayedRoutes();
}
