# Planificador de excursiones · Pirineos

Ejecutar (los navegadores no permiten `fetch` desde `file://`):

    cd pirineos-planner && python3 -m http.server 8000   # → http://localhost:8000

- `refugios/*.kml` y `caminos/*.kml` se cargan solos. Si tu servidor no lista directorios,
  añade los nombres en `manifest.json` (con `python -m http.server` basta con soltar el archivo).
- Cada `Placemark` con `LineString`/`MultiGeometry` es un tramo seleccionable; cada `Point` es un refugio.

## Notas de despliegue (GitHub Pages)
- Camptocamp bloquea las peticiones directas desde GitHub Pages por origen. El proxy propio está en
    `worker/` y se despliega automáticamente con `.github/workflows/deploy-c2c-proxy.yml`.
- Para activarlo, crea en GitHub los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`,
    ejecuta el workflow una vez y copia la URL `https://pirineo-planner-c2c.<subdominio>.workers.dev/waypoints`
    en `C2C_PROXY_URL` dentro de `js/config.js`. Después, otro push publica el frontend usando el proxy.
- El Worker acepta únicamente GET y reenvía solo la ruta de waypoints de Camptocamp; no es un proxy abierto.
- Overpass rota entre los espejos de `OVERPASS_MIRRORS` si uno da 504.
- En GitHub Pages no hay listado de directorios: añade cada KML a `manifest.json`.
