// Quiet Reddit relay — a tiny Cloudflare Worker that forwards requests to Reddit
// and adds the CORS headers browsers need.
//
// Reddit refuses anonymous JSON requests from cloud IPs but still serves RSS/Atom
// feeds, which is what the app uses. JSON endpoints are also relayed if you have an
// approved Reddit API app; set these worker secrets (wrangler secret put NAME):
//   REDDIT_CLIENT_ID      the string under the app name
//   REDDIT_CLIENT_SECRET  the "secret" (omit for "installed app" type apps)

// Optional: restrict who may use this relay. Leave empty to allow any origin.
const ALLOWED_ORIGINS = ['https://evandamours.github.io'];
const UA = 'web:quiet-reddit-relay:1.0 (personal reader)';

let tokenCache = { value: null, expires: 0 };

async function appToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60000) return tokenCache.value;
  if (!env.REDDIT_CLIENT_ID) return null;
  const body = new URLSearchParams(env.REDDIT_CLIENT_SECRET
    ? { grant_type: 'client_credentials' }
    : { grant_type: 'https://oauth.reddit.com/grants/installed_client', device_id: 'DO_NOT_TRACK_THIS_DEVICE' });
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.REDDIT_CLIENT_ID + ':' + (env.REDDIT_CLIENT_SECRET || '')),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body,
  });
  if (!res.ok) throw new Error('token request failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  tokenCache = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.length ? (ALLOWED_ORIGINS.includes(origin) ? origin : 'null') : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    };
    const reply = (body, status, type = 'text/plain') => new Response(body, { status, headers: { ...cors, 'Content-Type': type } });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return reply('GET only', 405);
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return reply('forbidden', 403);

    const u = new URL(request.url);
    let target;
    const raw = u.searchParams.get('url');
    if (raw) {
      try { target = new URL(raw); } catch { return reply('bad url', 400); }
    } else {
      target = new URL('https://www.reddit.com' + u.pathname + u.search);
    }
    if (!/(^|\.)reddit\.com$/.test(target.hostname)) return reply('only reddit.com is relayed', 400);
    const isFeed = /\.rss$/.test(target.pathname);
    if (!isFeed && !/\.json$/.test(target.pathname) && !target.pathname.startsWith('/api/morechildren')) return reply('only feed and JSON endpoints are relayed', 400);

    // RSS/Atom feeds are served to anonymous clients; JSON needs an authenticated app.
    const headers = isFeed
      ? { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept': 'application/atom+xml, application/xml' }
      : { 'User-Agent': UA, 'Accept': 'application/json' };
    let token = null;
    if (!isFeed) {
      try { token = await appToken(env); } catch (e) { return reply(JSON.stringify({ error: e.message }), 502, 'application/json'); }
    }
    if (token) {
      target.hostname = 'oauth.reddit.com';
      headers['Authorization'] = 'Bearer ' + token;
    }

    const upstream = await fetch(target.toString(), { headers, cf: { cacheTtl: 60, cacheEverything: true } });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=60' },
    });
  },
};
