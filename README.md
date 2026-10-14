# Planificador de excursiones · Pirineos

Ejecutar (los navegadores no permiten `fetch` desde `file://`):

    cd pirineos-planner && python3 -m http.server 8000   # → http://localhost:8000

- `refugios/*.kml` y `caminos/*.kml` se cargan solos. Si tu servidor no lista directorios,
  añade los nombres en `manifest.json` (con `python -m http.server` basta con soltar el archivo).
- Cada `Placemark` con `LineString`/`MultiGeometry` es un tramo seleccionable; cada `Point` es un refugio.

## Notas de despliegue (GitHub Pages)
- Los picos y lagos se cargan desde `picos/` y `lagos/` mediante KML estáticos.
- La aplicación puede exportar una excursión como ZIP con `excursion.json`, KML importados y fotos.
- El ZIP se puede importar de nuevo, editar y volver a exportar con metadatos nuevos.
- En GitHub Pages no hay listado de directorios: añade cada KML a `manifest.json`.
