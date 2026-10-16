#!/usr/bin/env python3
"""
Indexador de KML para PirineoPlanner
=====================================
Genera dos índices JSON:
  1. caminos/otrosCaminosKML/kml_index.json  — rutas dinámicas por nivel de zoom y celda geográfica
  2. poi_index.json                           — picos/lagos/cascadas por celda geográfica para carga dinámica

Uso:
    python3 tools/index_kmls.py
"""

import os
import json
import re
import math
import time
from pathlib import Path
from xml.etree import ElementTree as ET

# ─── Configuración ─────────────────────────────────────────────────────────────

SCRIPT_DIR   = Path(__file__).parent
ROOT         = SCRIPT_DIR.parent

ROUTES_DIR   = ROOT / "caminos" / "otrosCaminosKML"
ROUTES_INDEX = ROUTES_DIR / "kml_index.json"

POI_SOURCES = [
    {"file": ROOT / "picos"    / "picos-pirineo.kml",          "kind": "peak"},
    {"file": ROOT / "lagos"    / "lagos-pirineo-altitud.kml",   "kind": "lake"},
    {"file": ROOT / "cascadas" / "cascadas-pirineo-altitud.kml","kind": "waterfall"},
]
POI_INDEX = ROOT / "poi_index.json"

# Tamaño de celda geográfica para el índice espacial (en grados)
# 0.5° ≈ 50 km en latitud → buen equilibrio entre granularidad y nº de celdas
CELL_SIZE = 0.5

# Umbrales de longitud en km para asignar nivel de zoom
#   xl  → caminos muy largos (GR, travesías): se cargan con poco zoom
#   l   → caminos grandes (etapas largas)
#   m   → caminos medianos (excursiones normales)
#   s   → caminos cortos (rutas locales)
ZOOM_LEVELS = [
    ("xl",  200),   # ≥ 200 km  → nivel muy grande, se carga desde zoom 7
    ("l",    50),   # ≥ 50 km   → grande, zoom 9
    ("m",    10),   # ≥ 10 km   → mediano, zoom 11
    ("s",     0),   # < 10 km   → pequeño, zoom 13
]

ZOOM_THRESHOLDS = {  # zoom mínimo de Leaflet para que la categoría se cargue
    "xl": 8,
    "l":  10,
    "m":  12,
    "s":  14,
}

NS = {"kml": "http://www.opengis.net/kml/2.2"}

# ─── Utilidades ────────────────────────────────────────────────────────────────

def haversine_km(lat1, lon1, lat2, lon2):
    """Distancia en km entre dos puntos WGS-84."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def cell_key(lat, lon):
    """Convierte coordenadas a clave de celda (str)."""
    row = math.floor(lat / CELL_SIZE)
    col = math.floor(lon / CELL_SIZE)
    return f"{row}:{col}"

def parse_coords_text(text):
    """Parsea texto de <coordinates> en lista de (lon, lat)."""
    pts = []
    for tok in text.strip().split():
        parts = tok.split(",")
        if len(parts) >= 2:
            try:
                lon, lat = float(parts[0]), float(parts[1])
                if math.isfinite(lon) and math.isfinite(lat):
                    pts.append((lon, lat))
            except ValueError:
                pass
    return pts

def bbox_of_pts(pts):
    """Devuelve (min_lat, min_lon, max_lat, max_lon)."""
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)

def cells_for_bbox(min_lat, min_lon, max_lat, max_lon):
    """Devuelve el conjunto de claves de celda que cubre un bounding box."""
    cells = set()
    r0 = math.floor(min_lat / CELL_SIZE)
    r1 = math.floor(max_lat / CELL_SIZE)
    c0 = math.floor(min_lon / CELL_SIZE)
    c1 = math.floor(max_lon / CELL_SIZE)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            cells.add(f"{r}:{c}")
    return cells

def size_category(km_total):
    for cat, threshold in ZOOM_LEVELS:
        if km_total >= threshold:
            return cat
    return "s"


def simplify_pts(pts, max_pts):
    """Devuelve un % representativo de coordenadas para pintar la ruta desde lejos sin KML."""
    if len(pts) <= max_pts:
        return [[round(p[1], 4), round(p[0], 4)] for p in pts]
    step = (len(pts) - 1) / (max_pts - 1)
    res = []
    for i in range(max_pts - 1):
        idx = int(round(i * step))
        p = pts[min(idx, len(pts) - 1)]
        res.append([round(p[1], 4), round(p[0], 4)])
    p_last = pts[-1]
    res.append([round(p_last[1], 4), round(p_last[0], 4)])
    return res

# ─── Indexador de Rutas ────────────────────────────────────────────────────────

def index_routes():
    print(f"\n{'='*60}")
    print("Indexando rutas de otrosCaminosKML …")
    print(f"Directorio: {ROUTES_DIR}")

    kml_files = sorted(ROUTES_DIR.glob("*.kml"))
    print(f"Archivos encontrados: {len(kml_files)}")

    # El índice almacena una lista de entradas por categoría de zoom.
    # Cada entrada: { file, title, km, bbox, cells }
    # El cliente filtra por celda y zoom.

    entries = []   # todas las entradas
    skipped = 0
    t0 = time.time()

    for i, kml_path in enumerate(kml_files):
        if (i + 1) % 200 == 0:
            elapsed = time.time() - t0
            print(f"  {i+1}/{len(kml_files)} procesados ({elapsed:.1f}s) …")

        rel_path = f"caminos/otrosCaminosKML/{kml_path.name}"

        try:
            tree = ET.parse(kml_path)
            root = tree.getroot()
        except ET.ParseError:
            skipped += 1
            continue

        # Título del documento
        # Buscar <name> hijo directo de <Document>
        title = kml_path.stem
        for doc in root.iter():
            if doc.tag.endswith("}Document") or doc.tag == "Document":
                for child in doc:
                    if child.tag.endswith("}name") or child.tag == "name":
                        t = (child.text or "").strip()
                        if t:
                            title = t
                        break
                break

        # Recopilar todos los puntos de LineString
        all_pts = []
        for elem in root.iter():
            tag = elem.tag
            if tag.endswith("}coordinates") or tag == "coordinates":
                parent = None
                # Averiguar si el padre es LineString
                # ET no tiene referencia al padre; busco en todo el árbol
                # Aproximación: si el texto tiene espacios y comas, es una polilínea
                text = (elem.text or "").strip()
                pts = parse_coords_text(text)
                if len(pts) > 1:
                    all_pts.extend(pts)

        if len(all_pts) < 2:
            skipped += 1
            continue

        # Calcular longitud total
        km_total = 0.0
        for j in range(1, len(all_pts)):
            km_total += haversine_km(all_pts[j-1][1], all_pts[j-1][0],
                                     all_pts[j][1],   all_pts[j][0])

        # Bbox y celdas
        min_lat, min_lon, max_lat, max_lon = bbox_of_pts(all_pts)
        cells = sorted(cells_for_bbox(min_lat, min_lon, max_lat, max_lon))

        cat = size_category(km_total)

        entries.append({
            "file":  rel_path,
            "title": title,
            "km":    round(km_total, 2),
            "cat":   cat,
            "bbox":  [round(min_lat,5), round(min_lon,5), round(max_lat,5), round(max_lon,5)],
            "cells": cells,
        })

    # Construir índice invertido: celda → { cat: [indices de entries] }
    # Para eficiencia en el cliente, generamos un dict cell → list of entry indices por categoría
    cell_index = {}   # cell_key → { "xl": [...], "l": [...], "m": [...], "s": [...] }
    for idx, entry in enumerate(entries):
        for cell in entry["cells"]:
            if cell not in cell_index:
                cell_index[cell] = {"xl": [], "l": [], "m": [], "s": []}
            cell_index[cell][entry["cat"]].append(idx)

    elapsed = time.time() - t0
    print(f"\nResumen de rutas:")
    cats = {"xl": 0, "l": 0, "m": 0, "s": 0}
    for e in entries:
        cats[e["cat"]] += 1
    for cat, count in cats.items():
        zm = ZOOM_THRESHOLDS[cat]
        print(f"  {cat} (zoom≥{zm}): {count} rutas")
    print(f"  Saltadas (sin datos): {skipped}")
    print(f"  Tiempo: {elapsed:.1f}s")

    index = {
        "version": 1,
        "zoom_thresholds": ZOOM_THRESHOLDS,
        "entries": entries,
        "cell_size": CELL_SIZE,
        "cell_index": cell_index,
    }

    with open(ROUTES_INDEX, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = ROUTES_INDEX.stat().st_size / 1024
    print(f"\nÍndice guardado en: {ROUTES_INDEX}")
    print(f"Tamaño: {size_kb:.1f} KB")
    return index


# ─── Indexador de POIs ─────────────────────────────────────────────────────────

def parse_poi_kml(kml_path, kind):
    """Lee un KML de POIs y devuelve lista de dicts."""
    print(f"  Parseando {kml_path.name} …")
    try:
        tree = ET.parse(kml_path)
        root = tree.getroot()
    except ET.ParseError as e:
        print(f"  ERROR: {e}")
        return []

    points = []
    for pm in root.iter():
        if not (pm.tag.endswith("}Placemark") or pm.tag == "Placemark"):
            continue

        name = ""
        ele = None
        sub = ""
        desc = ""
        url = None
        lat = None
        lon = None

        for child in pm:
            tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
            text = (child.text or "").strip()

            if tag == "name":
                name = text
            elif tag == "description":
                desc = text
                # Extraer elevación del texto de descripción (formato: "Elevación: 1234m")
                m = re.search(r"Elevaci[oó]n:\s*(\d+(?:\.\d+)?)", text, re.I)
                if m and ele is None:
                    ele = float(m.group(1))
            elif tag == "elevacion":
                m = re.search(r"(\d+(?:\.\d+)?)", text)
                if m:
                    ele = float(m.group(1))
            elif tag == "tipo":
                sub = text
            elif tag == "link":
                if text.startswith("http"):
                    url = text
            elif tag == "Point":
                for coord_el in child:
                    ctag = coord_el.tag.split("}")[-1] if "}" in coord_el.tag else coord_el.tag
                    if ctag == "coordinates":
                        pts = parse_coords_text(coord_el.text or "")
                        if pts:
                            lon, lat = pts[0]

        # Elevation también puede estar en Data/value
        if ele is None:
            for data_el in pm.iter():
                dtag = data_el.tag.split("}")[-1] if "}" in data_el.tag else data_el.tag
                if dtag == "Data":
                    attr_name = data_el.get("name", "")
                    if attr_name == "elevation":
                        for val in data_el:
                            vtag = val.tag.split("}")[-1] if "}" in val.tag else val.tag
                            if vtag == "value":
                                try:
                                    ele = float((val.text or "").strip())
                                except ValueError:
                                    pass

        if lat is not None and lon is not None and math.isfinite(lat) and math.isfinite(lon):
            entry = {
                "n": name,
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "k": kind,
            }
            if ele is not None:
                entry["e"] = round(ele, 0)
            if sub:
                entry["s"] = sub
            if url:
                entry["u"] = url
            points.append(entry)

    return points


def index_pois():
    print(f"\n{'='*60}")
    print("Indexando POIs (picos, lagos, cascadas) …")

    all_points = []
    for src in POI_SOURCES:
        if not src["file"].exists():
            print(f"  AVISO: No se encontró {src['file']}")
            continue
        pts = parse_poi_kml(src["file"], src["kind"])
        print(f"    → {len(pts)} puntos de tipo '{src['kind']}'")
        all_points.extend(pts)

    print(f"\nTotal POIs: {len(all_points)}")

    # Construir índice por celda
    cell_index = {}  # cell_key → [indices]
    for idx, pt in enumerate(all_points):
        key = cell_key(pt["lat"], pt["lon"])
        if key not in cell_index:
            cell_index[key] = []
        cell_index[key].append(idx)

    index = {
        "version": 1,
        "cell_size": CELL_SIZE,
        "points": all_points,
        "cell_index": cell_index,
    }

    with open(POI_INDEX, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = POI_INDEX.stat().st_size / 1024
    print(f"\nÍndice POI guardado en: {POI_INDEX}")
    print(f"Tamaño: {size_kb:.1f} KB")

    # Estadísticas por tipo
    counts = {}
    for pt in all_points:
        counts[pt["k"]] = counts.get(pt["k"], 0) + 1
    for k, v in counts.items():
        print(f"  {k}: {v}")

    return index


# ─── Punto de entrada ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    t_start = time.time()
    print("PirineoPlanner — Indexador KML")
    print(f"Directorio raíz: {ROOT}")

    route_index = index_routes()
    poi_index   = index_pois()

    total = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"Indexación completa en {total:.1f}s")
    print("Archivos generados:")
    print(f"  {ROUTES_INDEX}")
    print(f"  {POI_INDEX}")
