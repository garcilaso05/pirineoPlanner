const ALLOWED_ORIGIN = 'https://garcilaso05.github.io';
const C2C_ENDPOINT = 'https://api.camptocamp.org/waypoints';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders() });
    }

    const incoming = new URL(request.url);
    const target = new URL(C2C_ENDPOINT);
    incoming.searchParams.forEach((value, key) => target.searchParams.set(key, value));

    const upstream = await fetch(target, {
      headers: { Accept: 'application/json' },
    });
    const headers = new Headers(upstream.headers);
    Object.entries(corsHeaders()).forEach(([key, value]) => headers.set(key, value));

    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
