# Planificador de excursiones · Pirineos

Ejecutar (los navegadores no permiten `fetch` desde `file://`):

    cd pirineos-planner && python3 -m http.server 8000   # → http://localhost:8000

- `refugios/*.kml` y `caminos/*.kml` se cargan solos. Si tu servidor no lista directorios,
  añade los nombres en `manifest.json` (con `python -m http.server` basta con soltar el archivo).
- Cada `Placemark` con `LineString`/`MultiGeometry` es un tramo seleccionable; cada `Point` es un refugio.

## Notas de despliegue (GitHub Pages)
- La búsqueda de picos y lagos usa OpenStreetMap mediante Overpass.
- La consulta contempla etiquetas `natural=water`, `water=lake/reservoir/glacial_lake` y nombres como
    `ibón`, `estany`, `llac`, `lac`, `étang`, `lago` y `laguna`.
- Overpass rota entre los espejos de `OVERPASS_MIRRORS` si uno da 504.
- En GitHub Pages no hay listado de directorios: añade cada KML a `manifest.json`.
