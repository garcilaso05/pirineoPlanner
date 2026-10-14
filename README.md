# Planificador de excursiones · Pirineos

Ejecutar (los navegadores no permiten `fetch` desde `file://`):

    cd pirineos-planner && python3 -m http.server 8000   # → http://localhost:8000

- `refugios/*.kml` y `caminos/*.kml` se cargan solos. Si tu servidor no lista directorios,
  añade los nombres en `manifest.json` (con `python -m http.server` basta con soltar el archivo).
- Cada `Placemark` con `LineString`/`MultiGeometry` es un tramo seleccionable; cada `Point` es un refugio.
