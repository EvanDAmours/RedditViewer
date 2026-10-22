/* Quiet TV — a browser player for Xtream Codes services and M3U playlists. No build step, no server. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem('qtv-' + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('qtv-' + k, JSON.stringify(v)); } catch {} },
  };
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ---------- state ----------
  const settings = Object.assign({ logos: true, format: 'auto', relay: '', relayStreams: false }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);
  let acct = store.get('account', null);   // { servers:[], username, password, base }
  let favs = store.get('favs', []);          // [{sec, id, name, ...}]
  const cache = new Map();
  const state = { sec: 'live', cat: null, query: '' };
  let entries = [];                          // M3U mode: parsed playlist entries
  const favKey = () => (acct?.mode === 'm3u' ? 'favs-m3u' : 'favs');

  // ---------- network ----------
  // Accepts the relay address however it was typed: with a {url} placeholder, ending in "?url=" or "=",
  // or just the relay's base address (then "?url=" is added).
  function viaRelay(url) {
    let p = (settings.relay || '').trim();
    if (!p) return null;
    if (p.includes('{url}')) return p.replace('{url}', encodeURIComponent(url));
    if (/[=?]$/.test(p)) return p + encodeURIComponent(url);
    if (!/\?/.test(p)) p = p.replace(/\/?$/, '/') + '?url=';
    else p += '&url=';
    return p + encodeURIComponent(url);
  }
  function normalizeServer(s) {
    s = String(s || '').trim(); if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    try { const u = new URL(s); return u.origin; } catch { return ''; }
  }
  // Candidate base URLs: https first (works from an https page without a relay), then http via relay.
  function candidates(origin) {
    const u = new URL(origin), host = u.host.replace(/:80$/, '');
    const list = [];
    if (u.protocol === 'https:' || /:\d+$/.test(host) === false) list.push('https://' + host.replace(/:443$/, ''));
    list.push('http://' + host);
    return [...new Set(list)];
  }
  async function getJSON(url, timeout = 20000) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const tries = [url]; const r = viaRelay(url); if (r) tries.push(r);
      let last;
      for (const u of tries) {
        if (u.startsWith('http:') && location.protocol === 'https:') { last = new Error('mixed content'); continue; }
        try {
          const res = await fetch(u, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
          if (!res.ok) { last = new Error('HTTP ' + res.status); continue; }
          const text = (await res.text()).replace(/^﻿/, '');
          try { return JSON.parse(text); } catch { last = new Error('not JSON'); continue; }
        } catch (e) { last = e; }
      }
      throw last || new Error('unreachable');
    } finally { clearTimeout(t); }
  }
  async function api(action, params = {}) {
    const key = action + JSON.stringify(params);
    if (cache.has(key)) return cache.get(key);
    const q = new URLSearchParams({ username: acct.username, password: acct.password });
    if (action) q.set('action', action);
    for (const [k, v] of Object.entries(params)) q.set(k, v);
    const data = await getJSON(`${acct.base}/player_api.php?${q}`);
    cache.set(key, data);
    return data;
  }
  // Every base URL a stream could come from: the signed-in server first, then the other addresses.
  function streamBases() {
    if (acct?.mode === 'm3u') return [];
    const list = [acct.base];
    for (const srv of acct.servers || []) {
      const o = normalizeServer(srv); if (!o) continue;
      for (const c of candidates(o)) if (!list.includes(c)) list.push(c);
    }
    return list.filter(b => !(b.startsWith('http:') && location.protocol === 'https:' && !settings.relayStreams));
  }
  function streamUrl(kind, id, ext, base = acct.base) {
    const u = `${base}/${kind}/${encodeURIComponent(acct.username)}/${encodeURIComponent(acct.password)}/${id}.${ext}`;
    return settings.relayStreams && viaRelay(u) ? viaRelay(u) : u;
  }

  // ---------- relay usage counter ----------
  // Counts requests this browser sends to the relay, per UTC day (Cloudflare's daily reset).
  // Uses the browser's resource-timing record, so hls.js and API calls are all seen.
  const relayOrigin = () => { try { const p = (settings.relay || '').trim(); return p ? new URL(p.replace('{url}', '')).origin : ''; } catch { return ''; } };
  const stats = Object.assign({ day: '', total: 0 }, store.get('relayStats', {}));
  let sessionCount = 0;
  const precounted = new Map(); // url -> how many starts were counted before their resource entry arrives
  const todayUTC = () => new Date().toISOString().slice(0, 10);
  function bump(n) {
    if (stats.day !== todayUTC()) { stats.day = todayUTC(); stats.total = 0; }
    stats.total += n; sessionCount += n; store.set('relayStats', stats); renderStats();
  }
  function renderStats() {
    if (stats.day !== todayUTC()) { stats.day = todayUTC(); stats.total = 0; store.set('relayStats', stats); }
    const on = !!relayOrigin();
    document.querySelectorAll('.relayBadge').forEach(el => {
      el.hidden = !on;
      el.textContent = `relay: ${stats.total.toLocaleString()} today`;
      el.title = `${sessionCount.toLocaleString()} this session. Counted in this browser only; the Cloudflare dashboard has the total across all devices.`;
    });
    const t = $('#relayToday'); if (t) t.textContent = stats.total.toLocaleString();
    const c = $('#relaySession'); if (c) c.textContent = sessionCount.toLocaleString();
    document.querySelectorAll('.relayToggleWrap').forEach(w => { w.hidden = !on; w.querySelector('input').checked = !!settings.relayStreams; });
  }
  document.querySelectorAll('.relayToggle').forEach(cb => cb.addEventListener('change', () => {
    settings.relayStreams = cb.checked; saveSettings(); renderStats();
    if (current?.sec === 'live' && !$('#player').hidden) { current.log = []; current.triedAlt = false; startLive(current.base, preferredFmt()); }
  }));
  function precount(url) { // for long-lived streams (MPEG-TS): count when they start, not when they end
    const o = relayOrigin(); if (!o || !url.startsWith(o + '/')) return;
    precounted.set(url, (precounted.get(url) || 0) + 1); bump(1);
  }
  if (window.PerformanceObserver) {
    try {
      performance.setResourceTimingBufferSize?.(2000);
      performance.addEventListener?.('resourcetimingbufferfull', () => performance.clearResourceTimings());
      new PerformanceObserver(list => {
        const o = relayOrigin(); if (!o) return;
        let n = 0;
        for (const e of list.getEntries()) {
          if (!e.name.startsWith(o + '/')) continue;
          const pre = precounted.get(e.name) || 0;
          if (pre > 0) { pre === 1 ? precounted.delete(e.name) : precounted.set(e.name, pre - 1); continue; }
          n++;
        }
        if (n) bump(n);
      }).observe({ type: 'resource', buffered: false });
    } catch {}
  }

  // ---------- playlist (M3U) mode ----------
  // Small IndexedDB key/value store for the playlist text and the guide subset (too big for localStorage).
  const idb = {
    db: null,
    open() { return new Promise((res, rej) => { if (!window.indexedDB) return rej(new Error('no IndexedDB')); const r = indexedDB.open('qtv', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { try { const db = this.db || (this.db = await this.open()); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch { return undefined; } },
    async set(k, v) { try { const db = this.db || (this.db = await this.open()); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch {} },
    async del(k) { try { const db = this.db || (this.db = await this.open()); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch {} },
  };
  const decodeEnt = str => String(str || '').replace(/&(amp|lt|gt|quot|apos|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi, (m, n, d, x) =>
    n === 'amp' ? '&' : n === 'lt' ? '<' : n === 'gt' ? '>' : n === 'quot' ? '"' : (n === 'apos' || n === '#39' || n === '#x27') ? "'" : d ? String.fromCodePoint(+d) : x ? String.fromCodePoint(parseInt(x, 16)) : m);

  // Fetch a URL directly, then through the relay if that fails. GitHub "/raw/" links are moved to the
  // raw host, which allows browser requests; github.com itself does not.
  // Google Drive: ordinary share links become direct-download links. Drive refuses downloads that a
  // browser marks as coming from another site (Sec-Fetch-Site: cross-site), which a page cannot avoid,
  // so Drive links are fetched through the relay only.
  const isDrive = u => /^https?:\/\/(drive|docs)\.(usercontent\.)?google\.com\//i.test(u);
  function normalizeDrive(u) {
    const m = /^https?:\/\/drive\.google\.com\/(?:file\/d\/([\w-]+)|open\?id=([\w-]+)|uc\?(?:export=download&)?id=([\w-]+))/i.exec(u);
    const id = m && (m[1] || m[2] || m[3]);
    return id ? `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` : u;
  }
  async function fetchAny(url) {
    url = normalizeDrive(url.trim()).replace(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\//, 'https://raw.githubusercontent.com/$1/$2/');
    const r = viaRelay(url);
    if (isDrive(url) && !r) throw new Error('Google Drive refuses downloads requested by another website. Enter the relay URL above (the download is a single relay request), or download the file and use "open a .m3u file".');
    const tries = isDrive(url) ? [r] : [url, ...(r ? [r] : [])];
    let last;
    for (const u of tries) {
      if (u.startsWith('http:') && location.protocol === 'https:') { last = new Error('plain http link on an https page'); continue; }
      const viaR = u === r;
      try {
        const res = await fetch(u, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) { last = new Error(viaR && (res.status === 403 || res.status === 404) ? `the relay refused (HTTP ${res.status}); check the relay URL, it must include your key` : (viaR ? 'relay: ' : '') + 'HTTP ' + res.status); continue; }
        return res;
      } catch (e) { last = new Error((viaR ? 'relay: ' : '') + (e.message === 'Load failed' || e.message === 'Failed to fetch' ? 'the browser could not complete the request' : e.message)); }
    }
    throw last || new Error('unreachable');
  }

  function parseM3U(text) {
    const out = []; let tvg = '';
    const lines = text.split(/\r?\n/);
    let pending = null, group = '';
    for (const raw of lines) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith('#EXTM3U')) { const m = /(?:url-tvg|x-tvg-url)="([^"]*)"/i.exec(line); if (m) tvg = m[1].split(',')[0].trim(); continue; }
      if (line.startsWith('#EXTINF')) {
        const attrs = {}; for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
        const q = line.lastIndexOf('"'); const c = line.indexOf(',', q < 0 ? 0 : q);
        pending = { name: (c >= 0 ? line.slice(c + 1) : '').trim() || attrs['tvg-name'] || 'Untitled', attrs };
        continue;
      }
      if (line.startsWith('#EXTGRP:')) { group = line.slice(8).trim(); continue; }
      if (line.startsWith('#')) continue;
      if (!pending) continue;
      const a = pending.attrs, url = line;
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const ext = (path.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || '';
      const kind = /\/movie\//.test(path) || /^(mp4|mkv|avi|mov|wmv|flv|webm)$/.test(ext) ? 'vod' : /\/series\//.test(path) ? 'series' : 'live';
      out.push({ name: pending.name, url, stream_id: url, stream_icon: a['tvg-logo'] || '', group: a['group-title'] || group || '', epg_channel_id: a['tvg-id'] || '', kind, num: out.length + 1 });
      pending = null;
    }
    return { entries: out, tvg };
  }

  // ----- guide (XMLTV) -----
  const guide = { byChannel: null, fetchedAt: 0, url: '', matched: 0, programmes: 0, status: '' };
  function xmltvTime(str) { // "20261022000000 +0000"
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(str || ''); if (!m) return 0;
    let t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (m[7]) { const off = (+m[8] * 60 + +m[9]) * 60000; t -= m[7] === '+' ? off : -off; }
    return t / 1000;
  }
  const guideFor = id => (id && guide.byChannel && guide.byChannel[id]) || null;
  function guideNow(id) { const l = guideFor(id); if (!l) return null; const now = Date.now() / 1000; return l.find(p => p[0] <= now && now < p[1]) || null; }
  function guideStatus(text) { guide.status = text || ''; const el = $('#guideStatus'); if (el) el.textContent = guideText(); }
  function guideText() {
    if (guide.status) return guide.status;
    if (!acct?.epgUrl) return 'no guide URL';
    if (!guide.byChannel) return 'guide not loaded';
    return `${guide.matched.toLocaleString()} channels matched, ${guide.programmes.toLocaleString()} programmes, fetched ${ago(guide.fetchedAt)}`;
  }
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  let guideLoading = null;
  function loadGuide(force) { return guideLoading || (guideLoading = loadGuideInner(force).finally(() => { guideLoading = null; })); }
  async function loadGuideInner(force) {
    if (!acct?.epgUrl || !entries.length) return;
    const wanted = new Set(entries.map(e => e.epg_channel_id).filter(Boolean));
    if (!wanted.size) { guideStatus('playlist has no tvg-id tags, so the guide cannot be matched'); return; }
    const cached = await idb.get('guide');
    if (!force && cached && cached.url === acct.epgUrl && Date.now() - cached.fetchedAt < 12 * 3600e3) { Object.assign(guide, cached, { status: '' }); renderList(); guideStatus(); return; }
    if (!window.DecompressionStream || !window.TextDecoderStream) { guideStatus('this browser is too old to read the guide'); return; }
    guideStatus('loading guide…');
    try {
      const res = await fetchAny(acct.epgUrl);
      const reader = res.body.getReader();
      const first = await reader.read();
      const head = first.value || new Uint8Array();
      const isGz = head[0] === 0x1f && head[1] === 0x8b;
      const rest = new ReadableStream({ start(c) { if (first.value) c.enqueue(first.value); if (first.done) c.close(); }, async pull(c) { const r = await reader.read(); if (r.done) c.close(); else c.enqueue(r.value); } });
      const text = (isGz ? rest.pipeThrough(new DecompressionStream('gzip')) : rest).pipeThrough(new TextDecoderStream()).getReader();
      const byChannel = {}; let buf = '', count = 0, bytes = 0;
      const lo = Date.now() / 1000 - 3 * 3600, hi = Date.now() / 1000 + 30 * 3600;   // keep a bit of the past and the next ~day
      const re = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
      while (true) {
        const { value, done } = await text.read(); if (done) break;
        buf += value; bytes += value.length;
        let last = 0, m; re.lastIndex = 0;
        while ((m = re.exec(buf))) {
          last = re.lastIndex;
          const attrs = m[1];
          const ch = decodeEnt((/channel="([^"]*)"/.exec(attrs) || [])[1]);
          if (!wanted.has(ch)) continue;
          const start = xmltvTime((/start="([^"]*)"/.exec(attrs) || [])[1]), stop = xmltvTime((/stop="([^"]*)"/.exec(attrs) || [])[1]);
          if (stop < lo || start > hi) continue;
          const title = decodeEnt((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]) || [])[1]);
          const desc = decodeEnt((/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]) || [])[1]).slice(0, 300);
          (byChannel[ch] ||= []).push([start, stop, title, desc]); count++;
        }
        if (last) buf = buf.slice(last);
        else { const cut = buf.lastIndexOf('<programme'); if (cut > 0) buf = buf.slice(cut); }
        if (bytes % 5e6 < value.length) guideStatus(`loading guide… ${(bytes / 1e6).toFixed(0)} MB read, ${count.toLocaleString()} programmes kept`);
      }
      for (const k in byChannel) byChannel[k].sort((a, b) => a[0] - b[0]);
      Object.assign(guide, { byChannel, fetchedAt: Date.now(), url: acct.epgUrl, matched: Object.keys(byChannel).length, programmes: count, status: '' });
      idb.set('guide', { byChannel, fetchedAt: guide.fetchedAt, url: guide.url, matched: guide.matched, programmes: count });
      guideStatus(); renderList();
    } catch (e) { guideStatus('guide failed: ' + e.message); }
  }

  // ----- playlist sign-in / loading -----
  async function usePlaylist(text, { playlistUrl = '', epgUrl = '', name = '' } = {}) {
    const parsed = parseM3U(text);
    if (!parsed.entries.length) throw new Error(/<html/i.test(text.slice(0, 2000)) ? 'That link returned a web page instead of a playlist. Download the file and use "open a .m3u file" instead.' : 'No channels found in that playlist.');
    entries = parsed.entries;
    const groups = new Set(entries.map(e => e.group)).size;
    acct = { mode: 'm3u', playlistUrl, epgUrl: (epgUrl || parsed.tvg || '').trim(), name: name || (playlistUrl ? new URL(playlistUrl).hostname : 'playlist'), count: entries.length, groups, fetchedAt: Date.now() };
    cache.clear();
    await idb.set('playlist', text);
    store.set('account', acct);
    return acct;
  }
  async function signInM3U(playlistUrl, epgUrl) {
    let res;
    try { res = await fetchAny(playlistUrl); } catch (e) { throw new Error(`Could not download the playlist (${e.message}). If the link opens fine in a browser tab, download the file and use "open a .m3u file" instead.`); }
    return usePlaylist(await res.text(), { playlistUrl, epgUrl });
  }
  async function bootM3U() {
    let text = await idb.get('playlist');
    if (!text && acct.playlistUrl) { text = await (await fetchAny(acct.playlistUrl)).text(); await idb.set('playlist', text); }
    if (!text) throw new Error('stored playlist missing');
    entries = parseM3U(text).entries;
  }

  // ---------- sign in ----------
  async function signIn(servers, username, password) {
    let lastErr = 'No server answered.';
    for (const origin of servers.map(normalizeServer).filter(Boolean)) {
      for (const base of candidates(origin)) {
        try {
          acct = { servers, username, password, base };
          cache.clear();
          const info = await getJSON(`${base}/player_api.php?${new URLSearchParams({ username, password })}`, 12000);
          if (!info?.user_info) { lastErr = 'That address did not answer like an Xtream service.'; continue; }
          if (String(info.user_info.auth) !== '1') { lastErr = 'Wrong username or password, or the account is not active.'; continue; }
          acct.info = info;
          // Prefer https when the server advertises it and we are not already on it.
          store.set('account', acct);
          return acct;
        } catch (e) {
          lastErr = e.message === 'mixed content'
            ? 'This service is plain http and the page is https, so the browser blocks it. Set a relay URL under Advanced.'
            : `Could not reach ${base} (${e.message}).`;
        }
      }
    }
    acct = null;
    throw new Error(lastErr);
  }

  let loginMode = store.get('loginMode', 'xtream');
  function setLoginMode(m) {
    loginMode = m; store.set('loginMode', m);
    document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#modeXtream').hidden = m !== 'xtream'; $('#modeM3u').hidden = m !== 'm3u';
    document.querySelectorAll('#modeXtream input, #modeXtream textarea').forEach(i => { i.required = m === 'xtream' && i.id !== 'inServers' ? false : false; });
  }
  document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setLoginMode(b.dataset.mode)));
  async function withBusy(fn) {
    const err = $('#loginErr'); err.hidden = true;
    const btn = $('#loginForm button[type=submit]'); btn.disabled = true; btn.textContent = 'signing in…';
    settings.relay = $('#inRelay').value.trim(); settings.relayStreams = $('#inRelayStreams').checked; saveSettings(); renderStats();
    try { await fn(); showMain(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false; btn.textContent = 'Sign in';
  }
  $('#loginForm').addEventListener('submit', e => {
    e.preventDefault();
    withBusy(async () => {
      if (loginMode === 'm3u') {
        const url = $('#inPlaylist').value.trim(); if (!url) throw new Error('Enter the playlist link, or open a .m3u file from this device.');
        await signInM3U(url, $('#inEpg').value.trim());
      } else {
        await signIn($('#inServers').value.split(/\n|,/), $('#inUser').value.trim(), $('#inPass').value);
      }
    });
  });
  $('#inFile').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    withBusy(async () => usePlaylist(await f.text(), { epgUrl: $('#inEpg').value.trim(), name: f.name }));
    e.target.value = '';
  });
  $('#signOut').addEventListener('click', async () => { store.set('account', null); acct = null; entries = []; cache.clear(); await idb.del('playlist'); await idb.del('guide'); $('#settings').close(); location.reload(); });

  // ---------- main browsing ----------
  function showMain() {
    $('#login').hidden = true; $('#player').hidden = true; $('#main').hidden = false;
    favs = store.get(favKey(), []);
    if (acct.mode === 'm3u') {
      $('#who').textContent = `${acct.name} · ${acct.count.toLocaleString()} entries in ${acct.groups} folders`;
      loadSection(state.sec);
      loadGuide(false);
      return;
    }
    const ui = acct.info?.user_info || {};
    $('#who').textContent = `${acct.username} @ ${acct.base.replace(/^https?:\/\//, '')}` + (ui.exp_date ? ` · expires ${new Date(ui.exp_date * 1000).toLocaleDateString()}` : '');
    loadSection(state.sec);
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    state.sec = b.dataset.sec; state.cat = null; state.query = ''; $('#search').value = ''; loadSection(state.sec);
  }));
  $('#search').addEventListener('input', e => { state.query = e.target.value.trim().toLowerCase(); renderList(); });

  const SEC = {
    live:   { cats: 'get_live_categories',   items: 'get_live_streams',  id: 'stream_id', kind: 'live' },
    vod:    { cats: 'get_vod_categories',    items: 'get_vod_streams',   id: 'stream_id', kind: 'movie' },
    series: { cats: 'get_series_categories', items: 'get_series',        id: 'series_id', kind: 'series' },
  };
  let items = [];
  async function loadSection(sec) {
    const catsEl = $('#cats'), listEl = $('#list');
    listEl.replaceChildren(h('p', { class: 'notice' }, 'loading…'));
    if (sec === 'fav') { catsEl.replaceChildren(); items = favs.map(f => ({ ...f, _fav: true })); renderList(); return; }
    if (acct.mode === 'm3u') {
      // Folders (group-title) of this section, in playlist order.
      const groups = [...new Set(entries.filter(e => e.kind === sec).map(e => e.group))];
      catsEl.replaceChildren(
        h('button', { 'data-id': '', onclick: () => pickCat(null) }, 'All'),
        ...groups.map(g => h('button', { 'data-id': g, onclick: () => pickCat(g), title: g || '(no folder)' }, g || '(no folder)')));
      await pickCat(state.cat);
      return;
    }
    try {
      const cats = await api(SEC[sec].cats);
      catsEl.replaceChildren(
        h('button', { 'data-id': '', onclick: () => pickCat(null) }, 'All'),
        ...cats.map(c => h('button', { 'data-id': c.category_id, onclick: () => pickCat(c.category_id), title: c.category_name }, c.category_name)));
      // Whole-catalogue fetches for movies/series are huge; start on the first category there.
      if (state.cat == null && sec !== 'live' && cats.length) state.cat = cats[0].category_id;
      await pickCat(state.cat);
    } catch (e) { listEl.replaceChildren(h('p', { class: 'notice err' }, 'Could not load: ' + e.message)); }
  }
  async function pickCat(id) {
    state.cat = id;
    document.querySelectorAll('#cats button').forEach(b => b.classList.toggle('on', b.dataset.id === (id == null ? '' : String(id))));
    document.querySelector('#cats button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('#list').replaceChildren(h('p', { class: 'notice' }, 'loading…'));
    if (acct.mode === 'm3u') { items = entries.filter(e => e.kind === state.sec && (id == null || e.group === id)); renderList(); return; }
    try {
      items = await api(SEC[state.sec].items, id == null ? {} : { category_id: id });
      items = Array.isArray(items) ? items : [];
      renderList();
    } catch (e) { $('#list').replaceChildren(h('p', { class: 'notice err' }, 'Could not load: ' + e.message)); }
  }

  const isFav = (sec, id) => favs.some(f => f.sec === sec && String(f.id) === String(id));
  function toggleFav(sec, item) {
    const id = item[SEC[sec].id];
    if (isFav(sec, id)) favs = favs.filter(f => !(f.sec === sec && String(f.id) === String(id)));
    else favs.push({ sec, id, name: item.name, icon: item.stream_icon || item.cover, ext: item.container_extension, num: item.num, epg: item.epg_channel_id || item.epg || '', url: item.url || '' });
    store.set(favKey(), favs);
  }

  // On an https page, http images are blocked (mixed content); skip them instead of spamming errors.
  const safeImg = u => (u && (location.protocol !== 'https:' || /^https:/i.test(u))) ? u : '';
  function renderList() {
    const listEl = $('#list');
    const q = state.query;
    let list = items.filter(x => !q || (x.name || '').toLowerCase().includes(q));
    if (!list.length) { listEl.replaceChildren(h('p', { class: 'notice' }, q ? 'no matches' : 'nothing here')); return; }
    const CAP = 800, total = list.length;
    if (total > CAP) list = list.slice(0, CAP);
    const capNote = total > CAP ? h('p', { class: 'notice' }, `showing ${CAP} of ${total.toLocaleString()}; search or pick a category to narrow it down`) : null;
    const sec = state.sec;
    if (sec === 'live' || sec === 'fav') {
      listEl.replaceChildren(...list.map(x => {
        const s = x._fav ? x.sec : 'live';
        const header = s === 'live' && /^#+.*#+$/.test(x.name || '');
        if (header) return h('div', { class: 'header' }, x.name.replace(/#/g, '').trim());
        return h('div', { class: 'row', onclick: () => open(s, x) },
          settings.logos && safeImg(x.stream_icon || x.icon || x.cover) ? h('img', { class: 'logo', src: safeImg(x.stream_icon || x.icon || x.cover), loading: 'lazy', alt: '', onerror: e => { e.target.style.visibility = 'hidden'; } }) : null,
          h('span', { class: 'num' }, x.num ? String(x.num) : ''),
          h('span', { class: 'name' }, x.name),
          (() => { const p = guideNow(x.epg_channel_id || x.epg); return p ? h('span', { class: 'meta now', title: p[2] }, p[2]) : null; })(),
          x.tv_archive ? h('span', { class: 'meta' }, 'catch-up') : null,
          isFav(s, x[SEC[s]?.id] ?? x.id) ? h('span', { class: 'star' }, '★') : null);
      }), ...(capNote ? [capNote] : []));
    } else {
      listEl.replaceChildren(h('div', { class: 'grid' }, ...list.map(x => {
        const img = safeImg(x.stream_icon || x.cover);
        return h('div', { class: 'card', onclick: () => open(sec, x) },
          settings.logos && img ? h('img', { class: 'poster', src: img, loading: 'lazy', alt: '', onerror: e => { e.target.replaceWith(h('div', { class: 'poster' }, x.name)); } }) : h('div', { class: 'poster' }, x.name),
          h('div', { class: 'cap' }, x.name, h('small', null, [x.year, x.rating ? `★ ${x.rating}` : null].filter(Boolean).join(' · '))));
      })), ...(capNote ? [capNote] : []));
    }
  }

  // ---------- player ----------
  let hls = null, tsPlayer = null;
  function stopPlayback() {
    const v = $('#video');
    if (hls) { hls.destroy(); hls = null; }
    if (tsPlayer) { try { tsPlayer.pause(); tsPlayer.unload(); tsPlayer.detachMediaElement(); tsPlayer.destroy(); } catch {} tsPlayer = null; }
    v.pause(); v.removeAttribute('src'); v.load();
  }
  function showMsg(text, err, extra) {
    const m = $('#pMsg'); m.hidden = !text;
    m.replaceChildren(h('div', null, text, err ? h('div', { class: 'err' }, err) : null, extra || null));
  }
  // Hide login details and the relay key in anything shown on screen (plain and URL-encoded forms).
  const maskUrl = u => {
    let out = String(u)
      .replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/…/…/')
      .replace(/%2F(live|movie|series)%2F[^%]+%2F[^%]+%2F/i, '%2F$1%2F…%2F…%2F');
    const o = relayOrigin();
    if (o && out.startsWith(o + '/')) { const m = out.slice(o.length).match(/^\/([^/?]+)(\/.*)$/); if (m) out = o + '/…' + m[2]; }
    return out;
  };
  const CONNECT_LIMIT = 12000;
  let watchdog = null;
  function playUrl(url, { live, keepMsg } = {}) {
    stopPlayback(); if (!keepMsg) showMsg('connecting…');
    const v = $('#video');
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { if (!$('#pMsg').hidden && /^(connecting|trying)/.test($('#pMsg').textContent)) fail(url, `no video after ${CONNECT_LIMIT / 1000} seconds`); }, CONNECT_LIMIT);
    v.onplaying = () => { clearTimeout(watchdog); showMsg(''); };
    const isHls = /\.m3u8(\?|$)/i.test(url), isTs = /\.ts(\?|$)/i.test(url);
    if (isHls && window.Hls && Hls.isSupported()) {
      // Safari plays HLS natively (HEVC and Dolby audio included); prefer that when available.
      if (v.canPlayType('application/vnd.apple.mpegurl') && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent)) {
        precount(url); // Safari's own player isn't visible to the counter; count the start
        v.src = url; v.play().catch(() => {});
        v.onerror = () => fail(url, v.error ? `media error ${v.error.code}` : 'cannot play');
        return;
      }
      // Few retries on purpose: a refused stream should fail in seconds, not sit on "buffering".
      const inst = hls = new Hls({
        enableWorker: true, lowLatencyMode: false, backBufferLength: live ? 30 : 90, maxBufferLength: 30,
        liveDurationInfinity: true, manifestLoadingMaxRetry: 1, manifestLoadingTimeOut: 10000,
        levelLoadingMaxRetry: 1, levelLoadingTimeOut: 10000, fragLoadingMaxRetry: 1, fragLoadingTimeOut: 10000,
      });
      let recovered = false;
      inst.loadSource(url); inst.attachMedia(v);
      inst.on(Hls.Events.ERROR, (_, d) => {
        if (hls !== inst) return;
        const code = d.response?.code;
        console.warn('hls', d.type, d.details, code || '', d.fatal ? 'fatal' : '');
        if (!d.fatal && !(code && code >= 400)) return;
        const codec = /incompatiblecodecs|codec|buffercreate|bufferaddcodec/i.test(d.details);
        // One shot at recovering a non-codec media error (a bad segment, an audio switch) before giving up.
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !codec && !recovered) { recovered = true; inst.recoverMediaError(); return; }
        // Defer: destroying hls.js from inside its own event handler breaks it.
        setTimeout(() => fail(url, d.type + ': ' + d.details + (code ? ` (HTTP ${code})` : '')), 0);
      });
    } else if (isTs && window.mpegts && window.mpegts.isSupported()) {
      precount(url);
      tsPlayer = window.mpegts.createPlayer({ type: 'mpegts', isLive: !!live, url }, { enableWorker: false, lazyLoad: false, liveBufferLatencyChasing: !!live, liveBufferLatencyMaxLatency: 6, liveBufferLatencyMinRemain: 1.5, autoCleanupSourceBuffer: true });
      tsPlayer.attachMediaElement(v); tsPlayer.load(); tsPlayer.play().catch(() => {});
      tsPlayer.on(window.mpegts.Events.ERROR, (t, d, info) => setTimeout(() => fail(url, `${t}: ${d}${info?.code ? ` (HTTP ${info.code})` : ''}`), 0));
    } else if (isTs) {
      setTimeout(() => fail(url, 'this browser cannot play MPEG-TS streams'), 0);
    } else {
      v.src = url; v.play().catch(() => {});
      v.onerror = () => fail(url, v.error ? `media error ${v.error.code}` : 'cannot play');
    }
  }
  let current = null;
  function liveUrlFor(fmt, base) {
    if (acct.mode === 'm3u') {
      let u = current.item.url || String(current.id);
      if (fmt && settings.format !== 'auto' && /\.(ts|m3u8)(\?|$)/i.test(u)) u = u.replace(/\.(ts|m3u8)(\?|$)/i, `.${fmt}$2`);
      else if (fmt && current.triedAlt && /\.(ts|m3u8)(\?|$)/i.test(u)) u = u.replace(/\.(ts|m3u8)(\?|$)/i, `.${fmt}$2`);
      return settings.relayStreams && viaRelay(u) ? viaRelay(u) : u;
    }
    return streamUrl('live', current.id, fmt, base);
  }
  function startLive(base, fmt) {
    current.base = base; current.fmt = fmt;
    current.url = liveUrlFor(fmt, base);
    playUrl(current.url, { live: true });
  }
  // On failure: one more try with the other format on the same server, then stop and explain.
  // Other servers are offered as a button, not cycled automatically, so a refused stream is
  // reported within seconds instead of looking like endless buffering.
  function fail(url, why) {
    if (!current || url !== current.url) return; // stale error from a player we already replaced
    clearTimeout(watchdog);
    stopPlayback();
    current.log = current.log || [];
    current.log.push(`${maskUrl(url)} → ${why}`);
    const codecProblem = /bufferAddCodecError|bufferIncompatibleCodecs|bufferAppendError|media error 4|media error 3/.test(why);
    if (current.sec === 'live' && !codecProblem && settings.format === 'auto' && !current.triedAlt) {
      current.triedAlt = true;
      const alt = current.fmt === 'm3u8' ? 'ts' : 'm3u8';
      const altUrl = liveUrlFor(alt, current.base);
      if (altUrl !== url) {
        showMsg(`trying the .${alt} version…`);
        current.url = altUrl; current.fmt = alt;
        return playUrl(current.url, { live: true, keepMsg: true });
      }
    }
    const all = current.log.join('\n');
    const refused = /HTTP (4\d\d|5\d\d)/.test(all);
    const hint = refused
      ? 'The service answered but refused to send this stream. Sign-in works, so the account is fine; the service is declining video to this device or network (connection limit, or a block on this network).'
      : codecProblem
      ? 'The stream arrived but this browser cannot decode its video or audio format, usually HEVC (H.265) video or Dolby (AC-3) audio. Chrome plays HEVC only on computers whose graphics chip supports it, with "Use graphics acceleration when available" switched on in Settings → System. Otherwise try Edge or Safari, an HD/SD version of the channel, or "⤓ .m3u" to open it in VLC.'
      : /no video after/.test(why)
      ? 'No video arrived in time. The request may be hanging on the way to the service, or the stream is very slow.'
      : location.protocol === 'https:'
      ? 'The stream could not be loaded. Many services send video from plain http:// addresses, which this https page is not allowed to load: use the offline copy from the sign-in page instead.'
      : 'The stream could not be loaded.';
    const bases = current.sec === 'live' ? streamBases() : [];
    const hostOf = u => u.replace(/^https?:\/\//, '');
    const i = bases.indexOf(current.base);
    const rotated = [...bases.slice(i + 1), ...bases.slice(0, i)];
    const next = rotated.find(b => hostOf(b) !== hostOf(current.base)) || rotated[0];
    const buttons = h('div', { class: 'pbtns' },
      next && next !== current.base ? h('button', { type: 'button', onclick: () => { current.log = []; current.triedAlt = false; startLive(next, preferredFmt()); } }, `try ${next}`) : null,
      h('button', { type: 'button', onclick: () => { current.log = []; current.triedAlt = false; if (current.sec === 'live') startLive(current.base, preferredFmt()); else playUrl(current.url); } }, 'retry'),
      h('button', { type: 'button', onclick: () => $('#pExt').click() }, 'open in VLC (.m3u)'));
    showMsg(hint, current.log.join('\n'), buttons);
  }
  function preferredFmt() {
    if (settings.format !== 'auto') return settings.format;
    if (acct.mode === 'm3u') { const u = current?.item?.url || String(current?.id || ''); return /\.m3u8(\?|$)/i.test(u) ? 'm3u8' : 'ts'; }
    return acct.info?.user_info?.allowed_output_formats?.includes('m3u8') ? 'm3u8' : 'ts';
  }

  async function open(sec, item) {
    current = { sec, item };
    $('#main').hidden = true; $('#player').hidden = false; window.scrollTo(0, 0);
    $('#pName').textContent = item.name; $('#pSub').textContent = '';
    $('#epg').replaceChildren(); $('#episodes').replaceChildren();
    const id = item[SEC[sec].id] ?? item.id;
    $('#pFav').classList.toggle('on', isFav(sec, id));
    $('#pFav').onclick = () => { toggleFav(sec, { ...item, [SEC[sec].id]: id }); $('#pFav').classList.toggle('on', isFav(sec, id)); };
    if (acct.mode === 'm3u' && sec !== 'live') {
      current.url = settings.relayStreams && viaRelay(item.url || String(id)) ? viaRelay(item.url || String(id)) : (item.url || String(id));
      const ext = ((item.url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1] || '';
      if (/^(mkv|avi|wmv|flv)$/i.test(ext)) showMsg(`This is an .${ext} file, which browsers usually can't play. Use "⤓ .m3u" to open it in VLC.`);
      playUrl(current.url);
    } else if (sec === 'live') {
      current.id = id;
      startLive(streamBases()[0], preferredFmt());
      loadEpg(acct.mode === 'm3u' ? (item.epg_channel_id || item.epg || '') : id);
    } else if (sec === 'vod') {
      const ext = item.container_extension || item.ext || 'mp4';
      current.url = streamUrl('movie', id, ext);
      if (/^(mkv|avi|wmv|flv)$/i.test(ext)) showMsg(`This is an .${ext} file, which browsers usually can't play. Use "⤓ .m3u" to open it in VLC.`);
      playUrl(current.url);
      api('get_vod_info', { vod_id: id }).then(i => { const inf = i?.info || {}; $('#pSub').textContent = [inf.genre, inf.releasedate, inf.duration].filter(Boolean).join(' · '); if (inf.plot) $('#epg').replaceChildren(h('p', { class: 'desc' }, inf.plot)); }).catch(() => {});
    } else if (sec === 'series') {
      stopPlayback(); showMsg('pick an episode below');
      loadSeries(id);
    }
    $('#pExt').onclick = () => {
      const body = `#EXTM3U\n#EXTINF:-1,${item.name}\n${current.url || ''}\n`;
      const a = h('a', { href: URL.createObjectURL(new Blob([body], { type: 'audio/x-mpegurl' })), download: (item.name || 'stream').replace(/[^\w .-]+/g, '').slice(0, 60) + '.m3u' });
      document.body.append(a); a.click(); a.remove();
    };
  }
  $('#pClose').addEventListener('click', () => { stopPlayback(); current = null; $('#player').hidden = true; $('#main').hidden = false; });

  const b64 = s => { try { return decodeURIComponent(escape(atob(s))); } catch { return s || ''; } };
  async function loadEpg(id) {
    if (acct.mode === 'm3u') {
      const now = Date.now() / 1000;
      const all = guideFor(id) || [];
      const from = Math.max(0, all.findIndex(p => p[1] > now));
      const list = all.length ? all.slice(from, from + 6) : [];
      const fmt = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('#epg').replaceChildren(...list.map(p => h('div', { class: 'prog' + (p[0] <= now && now < p[1] ? ' now' : '') },
        h('div', { class: 'time' }, `${fmt(p[0])} – ${fmt(p[1])}`),
        h('div', null, h('b', null, p[2]), p[3] ? h('div', { class: 'desc' }, p[3]) : null))));
      if (!list.length) $('#epg').replaceChildren(h('p', { class: 'notice' }, id ? (guide.byChannel ? 'no listings for this channel' : guideText()) : 'this channel has no guide id'));
      const cur = list.find(p => p[0] <= now && now < p[1]); if (cur) $('#pSub').textContent = 'now: ' + cur[2];
      return;
    }
    try {
      const d = await api('get_short_epg', { stream_id: id, limit: 6 });
      const list = d?.epg_listings || [];
      const now = Date.now() / 1000;
      $('#epg').replaceChildren(...list.map(p => {
        const s = +p.start_timestamp, e = +p.stop_timestamp;
        const fmt = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return h('div', { class: 'prog' + (s <= now && now < e ? ' now' : '') },
          h('div', { class: 'time' }, `${fmt(s)} – ${fmt(e)}`),
          h('div', null, h('b', null, b64(p.title)), p.description ? h('div', { class: 'desc' }, b64(p.description)) : null));
      }));
      const cur = list.find(p => +p.start_timestamp <= now && now < +p.stop_timestamp);
      if (cur) $('#pSub').textContent = 'now: ' + b64(cur.title);
    } catch {}
  }
  async function loadSeries(id) {
    try {
      const d = await api('get_series_info', { series_id: id });
      const eps = d?.episodes || {};
      const seasons = Object.keys(eps).sort((a, b) => a - b);
      if (!seasons.length) { $('#episodes').replaceChildren(h('p', { class: 'notice' }, 'no episodes listed')); return; }
      $('#pSub').textContent = d?.info?.plot ? d.info.plot.slice(0, 200) : '';
      const box = $('#episodes');
      const sel = h('select', { onchange: e => renderSeason(e.target.value) }, seasons.map(s => h('option', { value: s }, `Season ${s}`)));
      const epList = h('div');
      box.replaceChildren(sel, epList);
      function renderSeason(s) {
        epList.replaceChildren(...eps[s].map(ep => {
          const row = h('div', { class: 'row' }, h('span', { class: 'num' }, `E${ep.episode_num}`), h('span', { class: 'name' }, ep.title || `Episode ${ep.episode_num}`), ep.info?.duration ? h('span', { class: 'meta' }, ep.info.duration) : null);
          row.onclick = () => {
            epList.querySelectorAll('.row').forEach(r => r.classList.toggle('on', r === row));
            current.url = streamUrl('series', ep.id, ep.container_extension || 'mp4');
            $('#pName').textContent = `${current.item.name} · S${s}E${ep.episode_num}`;
            playUrl(current.url);
          };
          return row;
        }));
      }
      renderSeason(seasons[0]);
    } catch (e) { $('#episodes').replaceChildren(h('p', { class: 'notice err' }, 'Could not load episodes: ' + e.message)); }
  }

  // ---------- settings ----------
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    $('#optLogos').checked = settings.logos; $('#optFormat').value = settings.format;
    $('#optRelay').value = settings.relay; $('#optRelayStreams').checked = settings.relayStreams;
    renderStats();
    const src = $('#srcInfo');
    if (acct?.mode === 'm3u') {
      src.hidden = false;
      src.replaceChildren(
        h('div', null, `Playlist: ${acct.name}, ${acct.count.toLocaleString()} entries in ${acct.groups} folders, fetched ${ago(acct.fetchedAt)}. `,
          acct.playlistUrl ? h('button', { type: 'button', class: 'link', onclick: async e => { e.target.textContent = 'refreshing…'; try { await signInM3U(acct.playlistUrl, acct.epgUrl); showMain(); e.target.textContent = 'refreshed'; } catch (ex) { e.target.textContent = 'failed: ' + ex.message; } } }, 'refresh playlist') : null),
        h('div', null, 'Guide: ', h('span', { id: 'guideStatus' }, guideText()), ' ',
          acct.epgUrl ? h('button', { type: 'button', class: 'link', onclick: () => loadGuide(true) }, 'refresh guide') : null));
    } else src.hidden = true;
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    settings.logos = $('#optLogos').checked; settings.format = $('#optFormat').value;
    settings.relay = $('#optRelay').value.trim(); settings.relayStreams = $('#optRelayStreams').checked;
    saveSettings(); renderStats(); if (!$('#main').hidden) renderList();
  });
  $('#relayReset').addEventListener('click', () => { stats.total = 0; sessionCount = 0; store.set('relayStats', stats); renderStats(); });

  renderStats();

  // ---------- boot ----------
  setLoginMode(loginMode);
  if (acct?.mode === 'm3u') {
    $('#main').hidden = false; $('#list').replaceChildren(h('p', { class: 'notice' }, 'loading playlist…'));
    bootM3U().then(showMain).catch(() => { $('#main').hidden = true; $('#login').hidden = false; setLoginMode('m3u'); $('#inPlaylist').value = acct.playlistUrl || ''; $('#inEpg').value = acct.epgUrl || ''; prefillRelay(); });
  } else if (acct?.base) {
    $('#main').hidden = false;
    api('').then(info => { acct.info = info; showMain(); }).catch(() => { $('#main').hidden = true; $('#login').hidden = false; $('#inServers').value = (acct.servers || []).join('\n'); $('#inUser').value = acct.username; prefillRelay(); });
  } else {
    $('#login').hidden = false; prefillRelay();
  }
  function prefillRelay() { $('#inRelay').value = settings.relay; $('#inRelayStreams').checked = !!settings.relayStreams; }
})();
