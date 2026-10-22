/* Quiet Reddit — a low-profile, client-side Reddit reader.
   No build step, no server: fetches Reddit's public JSON straight from the browser. */
(() => {
  'use strict';

  // ---------- settings ----------
  const DEFAULTS = {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    thumbs: false, nsfw: false, stickied: false,
    home: 'popular', mute: '', proxy: 'https://quiet-reddit-relay.damoursevan.workers.dev', favs: []
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
  // Reddit refuses anonymous JSON requests from browsers and cloud servers, but still
  // serves RSS/Atom feeds. A small relay (worker/) forwards feeds with CORS headers.
  function relayUrl(pathAndQuery) {
    const p = (settings.proxy || DEFAULTS.proxy).trim();
    const full = 'https://www.reddit.com' + pathAndQuery;
    if (/[=?]$/.test(p)) return p + encodeURIComponent(full);
    return p.replace(/\/+$/, '') + pathAndQuery;
  }
  async function feed(path, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
    const target = relayUrl(path + '/.rss?' + q);
    let res;
    try { res = await fetch(target, { credentials: 'omit' }); }
    catch { throw new Error('Could not reach the relay. Check the relay URL in ⚙ settings.'); }
    if (res.status === 429) throw new Error('Reddit is rate-limiting requests (429). Wait a minute and try again.');
    if (res.status === 403) throw new Error('Reddit refused the request (403): private, banned or quarantined subreddit.');
    if (res.status === 404) throw new Error('Not found (404). Check the subreddit name.');
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from relay');
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('Reddit returned something that was not a feed.');
    return [...xml.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'entry')].map(entryToThing);
  }

  // Turn an Atom entry into an object shaped like Reddit's JSON "thing" data.
  function entryToThing(e) {
    const g = tag => { const el = e.getElementsByTagNameNS('http://www.w3.org/2005/Atom', tag)[0]; return el ? el.textContent : ''; };
    const fullId = g('id'); const kind = fullId.slice(0, 2); const id = fullId.slice(3);
    const link = e.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'link')[0]?.getAttribute('href') || '';
    const cat = e.getElementsByTagNameNS('http://www.w3.org/2005/Atom', 'category')[0];
    const subreddit = cat?.getAttribute('term') || (link.match(/\/r\/([^/]+)/) || [])[1] || '';
    const thumb = [...e.children].find(c => c.localName === 'thumbnail')?.getAttribute('url') || '';
    const author = g('name').replace(/^\/?u\//, '') || '[deleted]';
    const created_utc = Date.parse(g('published') || g('updated')) / 1000 || 0;
    const content = new DOMParser().parseFromString('<div>' + g('content') + '</div>', 'text/html').body.firstChild;
    const permalink = link.replace(/^https?:\/\/[^/]+/, '');
    if (kind === 't1') return { kind, id, name: fullId, subreddit, author, created_utc, permalink, body_html: content.innerHTML };
    // Link posts: a <table> with thumbnail, "submitted by", [link] and [comments].
    const table = content.querySelector('table');
    let url = link, is_self = true, selftext_html = '';
    if (table) {
      const linkA = [...table.querySelectorAll('a')].find(a => a.textContent.trim() === '[link]');
      if (linkA) url = linkA.getAttribute('href') || link;
      is_self = /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\//.test(url);
      table.remove();
    }
    const md = content.querySelector('.md');
    if (md) selftext_html = md.outerHTML;
    const domain = (url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
    return { kind, id, name: fullId, subreddit, author, created_utc, permalink, title: g('title'), url, is_self, selftext_html, thumbnail: thumb, domain,
      score: null, num_comments: null, over_18: false, stickied: false, link_flair_text: '' };
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
    const url = p.url || '';
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return { kind: 'image', src: url };
    if (/^https?:\/\/(www\.)?reddit\.com\/gallery\//.test(url)) return { kind: 'embed', url, title: 'gallery', domain: 'reddit' };
    if (/^https?:\/\/v\.redd\.it\//.test(url)) return { kind: 'embed', url, title: 'video', domain: 'reddit' };
    if (/youtube\.com|youtu\.be|vimeo\.com|streamable\.com|imgur\.com|gfycat\.com|redgifs\.com/i.test(url)) return { kind: 'embed', url, title: 'media', domain: p.domain };
    if (p.thumbnail && !p.is_self) return { kind: 'linkpreview', src: p.thumbnail, url };
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
    const label = { image: 'image', gallery: 'gallery', video: 'video', embed: m.title || 'media', linkpreview: 'preview' }[m.kind];
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
      case 'embed': return h('p', null, h('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer' }, `open ${m.title} on ${m.domain || 'site'} ↗`));
    }
  }

  // ---------- views ----------
  function postEl(p, { full = false } = {}) {
    const permalink = `#/r/${p.subreddit}/comments/${p.id}`;
    const external = !p.is_self && p.url && !/^https?:\/\/(www\.)?reddit\.com\//.test(p.url);
    const title = h('a', { class: 'title', href: external ? p.url : permalink, target: external ? '_blank' : null, rel: external ? 'noopener noreferrer' : null, html: esc(p.title) });
    const el = h('article', { class: 'post' + (p.score == null ? ' noscore' : ''), dataset: { id: p.id } },
      p.score != null ? h('div', { class: 'score' }, h('b', null, num(p.score))) : null,
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
          h('a', { href: permalink }, p.num_comments != null ? `${num(p.num_comments)} comments` : 'comments'),
          ' · ', h('a', { href: 'https://www.reddit.com' + p.permalink, target: '_blank', rel: 'noopener noreferrer' }, 'reddit ↗')),
        mediaBlock(p),
        full && p.selftext_html ? h('div', { class: 'selftext md', html: sanitize(p.selftext_html) }) : null));
    return el;
  }

  const PAGE = 25;
  async function listing(sub, sort, t, after) {
    const things = await feed(`/r/${sub}/${sort}`, { t: sort === 'top' ? t : null, after, limit: PAGE });
    const posts = things.filter(x => x.kind === 't3').filter(keep);
    return { posts, after: things.length >= PAGE ? things.at(-1).name : null };
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

  function commentEl(d, op) {
    const el = h('div', { class: 'comment', dataset: { id: d.id } });
    const head = h('div', { class: 'chead' },
      h('span', { class: 'toggle' }, '▾'), ' ',
      h('span', { class: 'author' + (d.author === op.author ? ' op' : '') }, d.author),
      ` · ${ago(d.created_utc)} · `,
      h('a', { href: 'https://www.reddit.com' + d.permalink, target: '_blank', rel: 'noopener noreferrer', onclick: e => e.stopPropagation() }, 'context ↗'));
    head.addEventListener('click', () => { el.classList.toggle('collapsed'); head.firstChild.textContent = el.classList.contains('collapsed') ? '▸' : '▾'; });
    el.append(head, h('div', { class: 'body md', html: sanitize(d.body_html) }));
    return el;
  }

  async function showThread(sub, id, csort) {
    app.replaceChildren(h('p', { class: 'notice' }, 'loading…'));
    try {
      const things = await feed(`/r/${sub}/comments/${id}`, { sort: csort, limit: 200 });
      const p = things.find(x => x.kind === 't3');
      if (!p) throw new Error('Post not found.');
      const comments = things.filter(x => x.kind === 't1');
      document.title = `${p.title} · quiet reddit`;
      const sortSel = h('select', { onchange: e => { location.hash = `#/r/${sub}/comments/${id}/${e.target.value}`; } },
        ['confidence', 'top', 'new', 'controversial', 'old', 'qa'].map(s => h('option', { value: s, selected: s === (csort || 'confidence') }, s === 'confidence' ? 'best' : s)));
      app.replaceChildren(h('div', { class: 'thread' },
        h('a', { class: 'back', href: `#/r/${sub}` }, `← r/${sub}`),
        postEl(p, { full: true }),
        h('div', { class: 'meta' }, 'sort comments: ', sortSel, ` · ${comments.length} shown, flat (Reddit's feed has no reply nesting)`),
        h('div', { class: 'comments' }, comments.length ? comments.map(c => commentEl(c, p)) : h('p', { class: 'notice' }, 'no comments yet'))));
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
