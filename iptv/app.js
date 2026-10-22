/* Quiet TV — a browser player for Xtream Codes services. No build step, no server. */
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

  // ---------- network ----------
  function viaRelay(url) {
    const p = (settings.relay || '').trim();
    if (!p) return null;
    return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + url;
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

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#loginErr'); err.hidden = true;
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'signing in…';
    settings.relay = $('#inRelay').value.trim(); saveSettings();
    try {
      await signIn($('#inServers').value.split(/\n|,/), $('#inUser').value.trim(), $('#inPass').value);
      showMain();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false; btn.textContent = 'Sign in';
  });
  $('#signOut').addEventListener('click', () => { store.set('account', null); acct = null; cache.clear(); $('#settings').close(); location.reload(); });

  // ---------- main browsing ----------
  function showMain() {
    $('#login').hidden = true; $('#player').hidden = true; $('#main').hidden = false;
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
    else favs.push({ sec, id, name: item.name, icon: item.stream_icon || item.cover, ext: item.container_extension, num: item.num });
    store.set('favs', favs);
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
          x.tv_archive ? h('span', { class: 'meta' }, 'catch-up') : null,
          isFav(s, x[SEC[s]?.id] ?? x.id) ? h('span', { class: 'star' }, '★') : null);
      }), capNote);
    } else {
      listEl.replaceChildren(h('div', { class: 'grid' }, ...list.map(x => {
        const img = safeImg(x.stream_icon || x.cover);
        return h('div', { class: 'card', onclick: () => open(sec, x) },
          settings.logos && img ? h('img', { class: 'poster', src: img, loading: 'lazy', alt: '', onerror: e => { e.target.replaceWith(h('div', { class: 'poster' }, x.name)); } }) : h('div', { class: 'poster' }, x.name),
          h('div', { class: 'cap' }, x.name, h('small', null, [x.year, x.rating ? `★ ${x.rating}` : null].filter(Boolean).join(' · '))));
      })), capNote);
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
  const maskUrl = u => String(u).replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//, '/$1/…/…/');
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
  function startLive(base, fmt) {
    current.base = base; current.fmt = fmt;
    current.url = streamUrl('live', current.id, fmt, base);
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
      showMsg(`trying the .${alt} version…`);
      current.url = streamUrl('live', current.id, alt, current.base); current.fmt = alt;
      return playUrl(current.url, { live: true, keepMsg: true });
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
    return settings.format === 'auto' ? (acct.info?.user_info?.allowed_output_formats?.includes('m3u8') ? 'm3u8' : 'ts') : settings.format;
  }

  async function open(sec, item) {
    current = { sec, item };
    $('#main').hidden = true; $('#player').hidden = false; window.scrollTo(0, 0);
    $('#pName').textContent = item.name; $('#pSub').textContent = '';
    $('#epg').replaceChildren(); $('#episodes').replaceChildren();
    const id = item[SEC[sec].id] ?? item.id;
    $('#pFav').classList.toggle('on', isFav(sec, id));
    $('#pFav').onclick = () => { toggleFav(sec, { ...item, [SEC[sec].id]: id }); $('#pFav').classList.toggle('on', isFav(sec, id)); };
    if (sec === 'live') {
      current.id = id;
      startLive(streamBases()[0], preferredFmt());
      loadEpg(id);
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
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    settings.logos = $('#optLogos').checked; settings.format = $('#optFormat').value;
    settings.relay = $('#optRelay').value.trim(); settings.relayStreams = $('#optRelayStreams').checked;
    saveSettings(); if (!$('#main').hidden) renderList();
  });

  // ---------- boot ----------
  if (acct?.base) {
    $('#main').hidden = false;
    api('').then(info => { acct.info = info; showMain(); }).catch(() => { $('#main').hidden = true; $('#login').hidden = false; $('#inServers').value = (acct.servers || []).join('\n'); $('#inUser').value = acct.username; });
  } else {
    $('#login').hidden = false; $('#inRelay').value = settings.relay;
  }
})();
