/* Quiet Reddit — a low-profile, client-side Reddit reader.
   No build step, no server: fetches Reddit's public JSON straight from the browser. */
(() => {
  'use strict';

  // ---------- settings ----------
  const DEFAULTS = {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    thumbs: false, nsfw: false, stickied: false,
    home: 'popular', mute: '', proxy: '', favs: []
  };
  const settings = Object.assign({}, DEFAULTS, load('qr-settings'));
  function load(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }
  function save() { try { localStorage.setItem('qr-settings', JSON.stringify(settings)); } catch {} }
  function applyTheme() { document.documentElement.dataset.theme = settings.theme; }
  applyTheme();

  // ---------- DOM helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ---------- fetching ----------
  // Reddit no longer reliably sends CORS headers for unauthenticated browser requests,
  // so we try a few direct hosts and then a user-supplied relay (see worker/).
  function viaProxy(url) {
    const p = settings.proxy.trim();
    if (!p) return null;
    if (/[=?]$/.test(p)) return p + encodeURIComponent(url);           // https://relay/?url=
    const base = p.replace(/\/+$/, '');
    return base + url.replace(/^https?:\/\/[^/]+/, '');                // https://relay  (path mirrored)
  }
  const SETUP_HINT = ' Reddit blocks direct browser requests on most networks now; set up the free relay described in the README and paste its URL into ⚙ settings.';
  async function redditRaw(pathAndQuery) {
    const direct = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'].map(hst => hst + pathAndQuery);
    const prox = viaProxy(direct[0]);
    const attempts = prox ? [prox, ...direct] : direct;
    let lastErr;
    for (const target of attempts) {
      let res;
      try { res = await fetch(target, { credentials: 'omit' }); }
      catch (e) { lastErr = new Error('Could not reach Reddit (network/CORS).' + (prox ? '' : SETUP_HINT)); continue; }
      if (res.ok) {
        try { return await res.json(); } catch { lastErr = new Error('Reddit returned something that was not JSON.'); continue; }
      }
      if (res.status === 429) lastErr = new Error('Reddit is rate-limiting requests (429). Wait a minute and try again.');
      else if (res.status === 403) lastErr = new Error('Reddit refused the request (403): private/quarantined subreddit, or Reddit is blocking this network.' + (prox ? '' : SETUP_HINT));
      else if (res.status === 404) { throw new Error('Not found (404). Check the subreddit name.'); }
      else lastErr = new Error('Reddit returned HTTP ' + res.status);
    }
    throw lastErr;
  }
  function reddit(path, params = {}) {
    const q = new URLSearchParams({ raw_json: '1' });
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
    return redditRaw(path + '.json?' + q);
  }

  // ---------- post filtering / sanitizing ----------
  function muteWords() { return settings.mute.split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
  function isAd(p) { return p.promoted || p.is_created_from_ads_ui || p.author === 'promoted' || p.domain === 'alb.reddit.com' || p.distinguished === 'promoted'; }
  function keep(p) {
    if (isAd(p)) return false;
    if (p.over_18 && !settings.nsfw) return false;
    if (p.stickied && !settings.stickied) return false;
    const words = muteWords();
    if (words.length) {
      const hay = (p.title + ' ' + (p.link_flair_text || '') + ' ' + p.subreddit).toLowerCase();
      if (words.some(w => hay.includes(w))) return false;
    }
    return true;
  }

  // Reddit already sanitizes its HTML server-side; this is a second pass that also strips
  // inline images so nothing visual loads without a click.
  function sanitize(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    const root = doc.body.firstChild;
    root.querySelectorAll('script,style,iframe,object,embed').forEach(e => e.remove());
    const ok = new Set(['P','BR','A','STRONG','EM','B','I','U','S','DEL','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','TABLE','THEAD','TBODY','TR','TD','TH','HR','SUP','SUB','SPAN','DIV']);
    for (const el of [...root.querySelectorAll('*')]) {
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        el.replaceWith(doc.createTextNode(''), Object.assign(doc.createElement('a'), { href: src, textContent: '[image]', className: 'imglink' }));
        continue;
      }
      if (!ok.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) if (a.name !== 'href' || !/^https?:\/\//i.test(a.value)) el.removeAttribute(a.name);
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
    }
    return root.innerHTML;
  }

  // ---------- formatting ----------
  function ago(utc) {
    const s = Math.max(0, Date.now() / 1000 - utc);
    const u = [[31536000,'y'],[2592000,'mo'],[604800,'w'],[86400,'d'],[3600,'h'],[60,'m']];
    for (const [n, l] of u) if (s >= n) return Math.floor(s / n) + l;
    return 'now';
  }
  const num = n => n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

  // ---------- media (hidden until clicked) ----------
  function mediaFor(p) {
    const items = [];
    const hint = p.post_hint;
    const url = p.url_overridden_by_dest || p.url || '';
    if (p.is_gallery && p.media_metadata) {
      const order = (p.gallery_data?.items || []).map(i => i.media_id);
      for (const id of order.length ? order : Object.keys(p.media_metadata)) {
        const m = p.media_metadata[id];
        if (!m || m.status !== 'valid') continue;
        const src = m.s?.u || m.s?.gif || (m.p || []).at(-1)?.u;
        if (src) items.push({ type: 'image', src });
      }
      return items.length ? { kind: 'gallery', items } : null;
    }
    if (p.is_video && p.media?.reddit_video) {
      const v = p.media.reddit_video;
      return { kind: 'video', src: v.fallback_url, hls: v.hls_url, poster: p.preview?.images?.[0]?.source?.url };
    }
    if (p.preview?.reddit_video_preview) {
      return { kind: 'video', src: p.preview.reddit_video_preview.fallback_url };
    }
    if (hint === 'image' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
      const variants = p.preview?.images?.[0];
      const gif = variants?.variants?.gif?.source?.url || variants?.variants?.mp4?.source?.url;
      return { kind: 'image', src: /\.gif/i.test(url) && gif ? gif : (variants?.source?.url || url) };
    }
    if (hint === 'rich:video' || p.media?.oembed) {
      return { kind: 'embed', url, title: p.media?.oembed?.title || p.domain };
    }
    if (hint === 'link' && p.preview?.images?.[0]) {
      return { kind: 'linkpreview', src: p.preview.images[0].source.url, url };
    }
    return null;
  }

  function thumbEl(p) {
    if (!settings.thumbs) return null;
    const t = p.thumbnail;
    if (!t || !/^https?:/.test(t)) return null;
    return h('img', { class: 'thumb' + (p.over_18 || p.spoiler ? ' blur' : ''), src: t, alt: '', loading: 'lazy' });
  }

  function mediaBlock(p) {
    const m = mediaFor(p);
    if (!m) return null;
    const box = h('div', { class: 'media' });
    const label = { image: 'image', gallery: `gallery (${m.items?.length})`, video: 'video', embed: 'embedded video', linkpreview: 'link preview' }[m.kind];
    const btn = h('button', { class: 'reveal', type: 'button' }, thumbEl(p), `▸ show ${label}`);
    btn.addEventListener('click', () => {
      box.replaceChildren(renderMedia(m), h('button', { class: 'hide', type: 'button', onclick: () => box.replaceChildren(btn) }, '▴ hide'));
    });
    box.append(btn);
    return box;
  }

  function renderMedia(m) {
    const img = src => h('img', { class: 'full', src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    switch (m.kind) {
      case 'image': return img(m.src);
      case 'linkpreview': return h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, img(m.src));
      case 'gallery': return h('div', { class: 'gallery' }, m.items.map(i => img(i.src)));
      case 'video': {
        const v = h('video', { controls: true, preload: 'metadata', playsinline: true, poster: m.poster });
        v.src = m.src; // Reddit's fallback mp4 has no audio track; HLS carries audio where supported
        if (m.hls && v.canPlayType('application/vnd.apple.mpegurl')) v.src = m.hls;
        return v;
      }
      case 'embed': return h('p', null, h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, `open ${m.title} ↗`));
    }
  }

  // ---------- views ----------
  function postEl(p, { full = false } = {}) {
    const permalink = `#/r/${p.subreddit}/comments/${p.id}`;
    const external = !p.is_self && p.url && !/^https?:\/\/(www\.)?reddit\.com\//.test(p.url);
    const title = h('a', { class: 'title', href: external ? p.url : permalink, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null, html: esc(p.title) });
    const el = h('article', { class: 'post', dataset: { id: p.id } },
      h('div', { class: 'score' }, h('b', null, num(p.score)), p.upvote_ratio ? `${Math.round(p.upvote_ratio * 100)}%` : ''),
      h('div', null,
        h('div', null, title,
          external ? h('span', { class: 'domain' }, p.domain) : null,
          p.link_flair_text ? h('span', { class: 'flair' }, p.link_flair_text) : null,
          p.over_18 ? h('span', { class: 'tag nsfw' }, 'nsfw') : null,
          p.spoiler ? h('span', { class: 'tag spoiler' }, 'spoiler') : null),
        h('div', { class: 'meta' },
          h('a', { href: `#/r/${p.subreddit}` }, `r/${p.subreddit}`), ' · ',
          h('a', { href: `https://www.reddit.com/user/${p.author}`, target: '_blank', rel: 'noopener noreferrer' }, `u/${p.author}`),
          ` · ${ago(p.created_utc)} · `,
          h('a', { href: permalink }, `${num(p.num_comments)} comments`),
          ' · ', h('a', { href: 'https://www.reddit.com' + p.permalink, target: '_blank', rel: 'noopener noreferrer' }, 'reddit ↗')),
        mediaBlock(p),
        full && p.selftext_html ? h('div', { class: 'selftext md', html: sanitize(p.selftext_html) }) : null));
    return el;
  }

  async function listing(sub, sort, t, after) {
    const data = await reddit(`/r/${sub}/${sort}`, { t: sort === 'top' ? t : null, after, limit: 25 });
    const posts = data.data.children.map(c => c.data).filter(keep);
    return { posts, after: data.data.after };
  }

  function showListing(sub, sort, t) {
    app.replaceChildren(h('p', { class: 'notice' }, 'loading…'));
    document.title = `r/${sub} · quiet reddit`;
    let after = null;
    const frag = h('div', { class: 'listing' });
    const more = h('button', { class: 'more', type: 'button' }, 'load more');
    async function page() {
      more.disabled = true; more.textContent = 'loading…';
      try {
        const r = await listing(sub, sort, t, after);
        after = r.after;
        if (!r.posts.length && !frag.children.length) frag.append(h('p', { class: 'notice' }, 'nothing here (or everything was filtered)'));
        r.posts.forEach(p => frag.append(postEl(p)));
      } catch (e) {
        app.replaceChildren(h('p', { class: 'notice error' }, e.message));
        return;
      }
      if (!app.contains(frag)) app.replaceChildren(frag);
      if (after) { more.disabled = false; more.textContent = 'load more'; app.append(more); } else more.remove();
    }
    more.addEventListener('click', page);
    page();
  }

  function commentEl(c, op, sub) {
    if (c.kind === 'more') {
      if (!c.data.children?.length) return null;
      const b = h('button', { class: 'loadmore', type: 'button' }, `load ${c.data.count || c.data.children.length} more comments`);
      b.addEventListener('click', async () => {
        b.textContent = 'loading…'; b.disabled = true;
        try {
          const ids = c.data.children.slice(0, 100);
          const q = new URLSearchParams({ raw_json: '1', api_type: 'json', link_id: 't3_' + op.id, children: ids.join(',') });
          const j = await redditRaw('/api/morechildren.json?' + q);
          const things = j.json?.data?.things || [];
          // morechildren returns a flat list with parent_id; rebuild the tree
          const byId = new Map(things.map(t => [t.data.name, Object.assign(t, { data: Object.assign({}, t.data, { replies: { data: { children: [] } } }) })]));
          const roots = [];
          for (const t of things) { const par = byId.get(t.data.parent_id); (par ? par.data.replies.data.children : roots).push(t); }
          b.replaceWith(...roots.map(t => commentEl(t, op, sub)).filter(Boolean));
        } catch { b.textContent = 'failed to load'; }
      });
      return b;
    }
    const d = c.data;
    const kids = d.replies?.data?.children || [];
    const el = h('div', { class: 'comment' + (d.collapsed ? ' collapsed' : ''), dataset: { id: d.id } });
    const head = h('div', { class: 'chead' },
      h('span', { class: 'toggle' }, d.collapsed ? '▸' : '▾'), ' ',
      h('span', { class: 'author' + (d.author === op.author ? ' op' : '') }, d.author),
      d.distinguished ? h('span', { class: 'flair' }, d.distinguished) : null,
      ` · ${num(d.score ?? 0)} pts · ${ago(d.created_utc)}`,
      d.stickied ? ' · pinned' : '');
    head.addEventListener('click', () => { el.classList.toggle('collapsed'); head.firstChild.textContent = el.classList.contains('collapsed') ? '▸' : '▾'; });
    el.append(head,
      h('div', { class: 'body md', html: sanitize(d.body_html) }),
      kids.length ? h('div', { class: 'children' }, kids.map(k => commentEl(k, op, sub)).filter(Boolean)) : null);
    return el;
  }

  async function showThread(sub, id, csort) {
    app.replaceChildren(h('p', { class: 'notice' }, 'loading…'));
    try {
      const [postL, commentL] = await reddit(`/r/${sub}/comments/${id}`, { sort: csort, limit: 200 });
      const p = postL.data.children[0].data;
      document.title = `${p.title} · quiet reddit`;
      const sortSel = h('select', { onchange: e => { location.hash = `#/r/${sub}/comments/${id}/${e.target.value}`; } },
        ['confidence', 'top', 'new', 'controversial', 'old', 'qa'].map(s => h('option', { value: s, selected: s === (csort || 'confidence') }, s === 'confidence' ? 'best' : s)));
      app.replaceChildren(h('div', { class: 'thread' },
        h('a', { class: 'back', href: `#/r/${sub}` }, `← r/${sub}`),
        postEl(p, { full: true }),
        h('div', { class: 'meta' }, 'sort comments: ', sortSel),
        h('div', { class: 'comments' }, commentL.data.children.map(c => commentEl(c, p, sub)).filter(Boolean))));
    } catch (e) {
      app.replaceChildren(h('p', { class: 'notice error' }, e.message));
    }
  }

  // ---------- routing ----------
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    const parts = hash.split('/').filter(Boolean);
    const subInput = $('#sub'), sortSel = $('#sort'), timeSel = $('#time');
    if (parts[0] === 'r' && parts[1]) {
      const sub = parts[1];
      subInput.value = sub;
      $('#favBtn').classList.toggle('on', settings.favs.includes(sub.toLowerCase()));
      if (parts[2] === 'comments' && parts[3]) return showThread(sub, parts[3], parts[4]);
      const sort = ['hot', 'new', 'top', 'rising'].includes(parts[2]) ? parts[2] : 'hot';
      const t = parts[3] || 'day';
      sortSel.value = sort; timeSel.value = t; timeSel.hidden = sort !== 'top';
      return showListing(sub, sort, t);
    }
    location.replace(`#/r/${settings.home || 'popular'}`);
  }
  addEventListener('hashchange', route);

  // ---------- UI wiring ----------
  $('#go').addEventListener('submit', e => {
    e.preventDefault();
    const sub = $('#sub').value.trim().replace(/^\/?r\//, '').replace(/\s+/g, '') || settings.home;
    const sort = $('#sort').value, t = $('#time').value;
    location.hash = `#/r/${sub}/${sort}` + (sort === 'top' ? `/${t}` : '');
  });
  $('#sort').addEventListener('change', () => { $('#time').hidden = $('#sort').value !== 'top'; $('#go').requestSubmit(); });
  $('#time').addEventListener('change', () => $('#go').requestSubmit());

  function renderFavs() {
    $('#favs').replaceChildren(...settings.favs.map(s => h('a', { href: `#/r/${s}` }, `r/${s}`)));
  }
  $('#favBtn').addEventListener('click', () => {
    const sub = $('#sub').value.trim().toLowerCase(); if (!sub) return;
    const i = settings.favs.indexOf(sub);
    if (i >= 0) settings.favs.splice(i, 1); else settings.favs.push(sub);
    save(); renderFavs(); $('#favBtn').classList.toggle('on', i < 0);
  });

  const dlg = $('#settings');
  const fields = { 'opt-thumbs': 'thumbs', 'opt-nsfw': 'nsfw', 'opt-stickied': 'stickied', 'opt-home': 'home', 'opt-mute': 'mute', 'opt-proxy': 'proxy' };
  $('#settingsBtn').addEventListener('click', () => {
    $('#opt-theme-dark').checked = settings.theme === 'dark';
    for (const [id, key] of Object.entries(fields)) { const el = $('#' + id); if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key]; }
    dlg.showModal();
  });
  $('#settingsClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    settings.theme = $('#opt-theme-dark').checked ? 'dark' : 'light';
    for (const [id, key] of Object.entries(fields)) { const el = $('#' + id); settings[key] = el.type === 'checkbox' ? el.checked : el.value.trim(); }
    settings.home = settings.home.replace(/^\/?r\//, '') || 'popular';
    save(); applyTheme(); route();
  });

  renderFavs();
  route();
})();
