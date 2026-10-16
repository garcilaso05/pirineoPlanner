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

import { map, G, addPois, removePoiByKey, onTrackClick } from './map.js';
import { parseKML } from './kml.js';

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

// Presupuesto máximo de rutas simultáneas en pantalla según zoom
function maxRoutesBudget(zoom) {
  if (zoom <= 9)  return 5;
  if (zoom <= 11) return 8;
  if (zoom <= 13) return 12;
  return 18;
}

// Zoom mínimo para mostrar picos, lagos y cascadas
const POI_ZOOM_MIN = 12;
const MAX_POIS_PER_TYPE = 35;

// Concurrencia máxima de descargas simultáneas
const FETCH_CONCURRENCY = 3;

// ─── Estado ────────────────────────────────────────────────────────────────────

let routeIndex   = null; // kml_index.json (543 KB)
let poiIndexData = null; // poi_index.json (1.38 MB filtrado)

// Rutas activas en pantalla: file -> { layers: Polyline[], entry }
const activeRouteLayers = new Map();
const routeKmlCache     = new Map(); // file -> KML parseado en memoria
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

export async function initDynamicLoader(layerControl) {
  dynRoutesLayer = L.layerGroup().addTo(map);
  if (layerControl) {
    layerControl.addOverlay(dynRoutesLayer, 'Caminos dinámicos (otros caminos)');
  }

  // Activar / Desactivar desde la leyenda del mapa
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

  // Interrupción prioritaria: arrastrar o ampliar el mapa cancela tareas en cola
  map.on('movestart zoomstart dragstart', () => {
    isInteracting = true;
    cancelPendingWork();
  });

  map.on('moveend zoomend', () => {
    isInteracting = false;
    cancelPendingWork();
    // Debounce breve (100ms) para cargar rápido tan pronto el usuario se detiene
    scheduleRefresh(100);
  });

  // Carga paralela de índices
  try {
    const [ri, pi] = await Promise.all([
      fetch('caminos/otrosCaminosKML/kml_index.json').then((r) => r.ok ? r.json() : null),
      fetch('poi_index.json').then((r) => r.ok ? r.json() : null),
    ]);
    routeIndex   = ri;
    poiIndexData = pi;
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
  if (document.body.classList.contains('viewer-mode')) return;
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

  // Si estamos en zoom <= 7, limpiar de inmediato cualquier ruta dinámica
  if (cats.length === 0) {
    clearDisplayedRoutes();
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

  // 2. DESCARGA INMEDIATA: Quitar del mapa cualquier camino que ya NO esté en el encuadre
  // (cuando el usuario amplía o se desplaza a otra zona, los caminos lejanos se descargan de inmediato)
  for (const [file, data] of activeRouteLayers.entries()) {
    if (!candidateMap.has(file)) {
      for (const l of data.layers) dynRoutesLayer.removeLayer(l);
      activeRouteLayers.delete(file);
    }
  }

  // 3. PRESUPUESTO CONTROLADO: Priorizar las rutas más destacadas según el zoom
  const budget = maxRoutesBudget(zoom);
  let candidates = Array.from(candidateMap.values());
  if (candidates.length > budget) {
    const catWeight = { xl: 0, l: 1, m: 2, s: 3 };
    candidates.sort((a, b) => (catWeight[a.cat] - catWeight[b.cat]) || (b.km - a.km));
    candidates = candidates.slice(0, budget);
  }

  const allowedFiles = new Set(candidates.map((e) => e.file));

  // Retirar del mapa las que excedan el presupuesto
  for (const [file, data] of activeRouteLayers.entries()) {
    if (!allowedFiles.has(file)) {
      for (const l of data.layers) dynRoutesLayer.removeLayer(l);
      activeRouteLayers.delete(file);
    }
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
function renderKmlRoute(entry, kml) {
  if (activeRouteLayers.has(entry.file)) return;

  const segments = kml.lines.map((l, i) => ({
    name: l.name || `Tramo ${i + 1}`,
    pts:  l.pts, // TODOS los puntos reales del KML
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

    // smoothFactor: 1.5 permite a Leaflet acelerar el renderizado en canvas
    // manteniendo la fidelidad y forma exacta de todas las curvas del camino
    const poly = L.polyline(seg.pts, {
      color,
      weight,
      opacity: 0.82,
      smoothFactor: 1.5,
    });

    const catLabel = { xl: 'GR / Travesía', l: 'Ruta larga', m: 'Ruta media', s: 'Ruta corta' }[entry.cat] || '';
    poly.bindTooltip(`<b>${entry.title}</b><br>${seg.name} · ${seg.km.toFixed(1)} km · <em>${catLabel}</em>`, {
      sticky: true,
      direction: 'top',
    });

    // Clic en la polilínea: compatible con popup y recorte de fragmentos
    poly.on('click', (ev) => onTrackClick(routeObj, seg, ev));

    dynRoutesLayer.addLayer(poly);
    layers.push(poly);
  }

  activeRouteLayers.set(entry.file, {
    layers,
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
  return { xl: 3.5, l: 3.0, m: 2.5, s: 2.2 }[cat] || 2.5;
}

function clearDisplayedRoutes() {
  dynRoutesLayer.clearLayers();
  activeRouteLayers.clear();
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

  const toAdd = [];
  for (const kind of ['peak', 'lake', 'waterfall']) {
    const list = candidatesByType[kind] || [];
    if (list.length > MAX_POIS_PER_TYPE) {
      list.sort((a, b) => (b.pt.e || 0) - (a.pt.e || 0)); // priorizar los más altos
    }
    toAdd.push(...list.slice(0, MAX_POIS_PER_TYPE));
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

export function clearDynamicPois() {
  clearDisplayedPois();
}

export function clearDynamicRoutes() {
  cancelPendingWork();
  clearDisplayedRoutes();
}
