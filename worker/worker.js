// Quiet Reddit relay — a tiny Cloudflare Worker that forwards requests to Reddit
// and adds the CORS headers browsers need. Deploy it free at workers.cloudflare.com,
// then paste its URL into ⚙ settings → CORS proxy in the app.

// Optional: restrict who may use this relay. Leave empty to allow any origin.
const ALLOWED_ORIGINS = []; // e.g. ['https://evandamours.github.io']

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.length ? (ALLOWED_ORIGINS.includes(origin) ? origin : 'null') : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403, headers: cors });

    const u = new URL(request.url);
    // Accept either ?url=<full reddit url> or a reddit path mirrored on this worker (/r/pics/hot.json?...)
    let target;
    const raw = u.searchParams.get('url');
    if (raw) {
      try { target = new URL(raw); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    } else {
      target = new URL('https://www.reddit.com' + u.pathname + u.search);
    }
    if (!/(^|\.)reddit\.com$/.test(target.hostname)) return new Response('only reddit.com is relayed', { status: 400, headers: cors });
    if (!/\.json$/.test(target.pathname) && !target.pathname.startsWith('/api/morechildren')) return new Response('only JSON endpoints are relayed', { status: 400, headers: cors });

    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'web:quiet-reddit-relay:1.0 (personal reader)', 'Accept': 'application/json' },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=60' },
    });
  },
};
