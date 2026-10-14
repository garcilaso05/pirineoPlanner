# Planificador de excursiones · Pirineos

Ejecutar (los navegadores no permiten `fetch` desde `file://`):

    cd pirineos-planner && python3 -m http.server 8000   # → http://localhost:8000

- `refugios/*.kml` y `caminos/*.kml` se cargan solos. Si tu servidor no lista directorios,
  añade los nombres en `manifest.json` (con `python -m http.server` basta con soltar el archivo).
- Cada `Placemark` con `LineString`/`MultiGeometry` es un tramo seleccionable; cada `Point` es un refugio.

## Notas de despliegue (GitHub Pages)
- Camptocamp no envía cabeceras CORS a orígenes que no están en su lista (responde 400). La app prueba
  primero directo y luego los proxies de `js/config.js` (`C2C_PROXIES`). Para no depender de terceros,
  despliega un proxy propio (Cloudflare Worker que reenvíe `?url=` añadiendo `Access-Control-Allow-Origin`)
  y ponlo el primero de la lista.
- Overpass rota entre los espejos de `OVERPASS_MIRRORS` si uno da 504.
- En GitHub Pages no hay listado de directorios: añade cada KML a `manifest.json`.
