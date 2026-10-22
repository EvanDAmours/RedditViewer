// IPTV relay — a Cloudflare Worker that forwards playlist, Xtream API and (optionally)
// stream requests from a browser IPTV player to the provider, adding CORS headers and
// letting an https page reach http:// providers.
//
// It carries your provider login, so it is protected by a secret path segment:
//   https://<worker>/<KEY>/?url=<encoded provider url>
// In the IPTV app, set the CORS proxy to:   https://<worker>/<KEY>/?url={url}
// Set the key with:  npx wrangler secret put RELAY_KEY

const MAX_REDIRECTS = 5;

function isPrivateHost(host) {
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return host.includes(':'); // block raw IPv6 literals
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const reply = (body, status) => new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply('GET only', 405);

    const u = new URL(request.url);
    const key = u.pathname.split('/')[1] || '';
    if (!env.RELAY_KEY || key !== env.RELAY_KEY) return reply('forbidden', 403);

    let target;
    try { target = new URL(u.searchParams.get('url') || ''); } catch { return reply('missing or bad ?url=', 400); }
    if (!/^https?:$/.test(target.protocol)) return reply('only http(s) targets', 400);
    if (isPrivateHost(target.hostname)) return reply('target not allowed', 400);

    // Forward only the headers that matter for media playback; never cookies.
    const headers = { 'User-Agent': request.headers.get('X-Relay-UA') || 'VLC/3.0.20 LibVLC/3.0.20', 'Accept': '*/*' };
    const range = request.headers.get('Range'); if (range) headers['Range'] = range;

    let res, current = target.toString();
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      res = await fetch(current, { method: request.method, headers, redirect: 'manual' });
      const loc = res.headers.get('Location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc) break;
      const next = new URL(loc, current);
      if (!/^https?:$/.test(next.protocol) || isPrivateHost(next.hostname)) return reply('redirect not allowed', 400);
      current = next.toString();
    }

    // Playlists refer to other URLs (segments, keys, variants); rewrite relative/absolute ones through the relay
    // so streams and HLS keep working when "proxy streams" is on.
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    const looksPlaylist = /mpegurl|x-mpegurl|application\/vnd\.apple/.test(ct) || /\.m3u8?(\?|$)/i.test(new URL(current).pathname);
    const out = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Last-Modified', 'ETag', 'Cache-Control']) {
      const v = res.headers.get(h); if (v) out.set(h, v);
    }
    for (const [k, v] of Object.entries(cors)) out.set(k, v);

    if (looksPlaylist && res.ok && request.method === 'GET') {
      const text = await res.text();
      // Only HLS playlists (#EXT-X-) are rewritten: their segments must come through the relay too.
      // A plain M3U channel list is passed through untouched so the player decides how to fetch streams.
      if (!/^#EXT-X-/m.test(text)) { out.delete('Content-Length'); return new Response(text, { status: res.status, headers: out }); }
      const relay = `${u.origin}/${key}/?url=`;
      const abs = (ref) => { try { return relay + encodeURIComponent(new URL(ref, current).toString()); } catch { return ref; } };
      const rewritten = text.split(/\r?\n/).map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, r) => `URI="${abs(r)}"`);
        return abs(line.trim());
      }).join('\n');
      out.delete('Content-Length');
      return new Response(rewritten, { status: res.status, headers: out });
    }
    return new Response(res.body, { status: res.status, headers: out });
  },
};
