# Quiet Reddit

A low-profile, text-first Reddit reader that runs entirely in your browser.
No server, no build step, no account: it reads Reddit's public JSON directly.

- **No ads.** Promoted posts are dropped before rendering.
- **No images until you ask.** Pictures, galleries, videos and link previews are
  replaced by a small "show image" button. Click to load, click again to hide.
- **Quiet by default.** NSFW and pinned posts are hidden (toggle in settings),
  and you can mute posts by keyword.
- Browse any subreddit or multi (`a+b+c`), sort by hot/new/top/rising,
  read comment threads, star favourite subreddits,
  light and dark themes. Works on phones.

## Use it

Open the GitHub Pages URL for this repo (see below), or just open `index.html`
locally. Everything is saved in your browser's local storage.

## Hosting on GitHub Pages

1. On GitHub, open **Settings → Pages**.
2. Under *Build and deployment*, set **Source** to *Deploy from a branch*,
   pick `main` and `/ (root)`, and save.
3. After a minute the site is live at `https://<your-user>.github.io/RedditViewer/`.

The repo is plain static files, so any other static host works too.

## How it reaches Reddit

Reddit refuses anonymous JSON requests from browsers on other sites and from
cloud servers, and new API apps need manual approval. It does still publish
RSS/Atom feeds for subreddits, multis and comment threads, so the app reads
those through a small relay: a Cloudflare Worker (`worker/worker.js`) that
forwards feeds and adds the CORS headers browsers need. The deployed relay is
the app's default; you can point it at your own in ⚙ settings.

What feeds give up compared to the JSON API: no vote counts, no comment
counts, no NSFW/pinned flags, and galleries/videos open on Reddit instead of inline.
Reply nesting is rebuilt from depth-limited feeds, so levels one and two are
exact and deeper replies are grouped under their level-two ancestor.

To run your own relay: create a free Cloudflare account, edit `ALLOWED_ORIGINS`
in `worker/worker.js` to your site's origin, then in `worker/` run
`npx wrangler login` and `npx wrangler deploy`. Paste the worker URL into
⚙ settings or into `DEFAULTS.proxy` in `app.js`.

## Quiet TV (IPTV player)

`iptv/` is a separate single-page player for Xtream Codes services and M3U
playlists, served at `/iptv/` on the same Pages site. Sign in with a server
address, username and password, or with a playlist link (or a .m3u file from
the device). In playlist mode the `group-title` folders become the
categories, and an XMLTV guide (plain or .gz, taken from the playlist's
`url-tvg` header when present) is stream-parsed in the browser down to just
your channels and cached locally for 12 hours. It browses live TV (with
now/next listings), movies and series, keeps favourites, and plays HLS via
hls.js, MPEG-TS via mpegts.js, and files via the browser's own player, with
an "open in VLC" fallback.
It talks to the provider directly over https when the provider supports it,
and can use the IPTV relay below otherwise.

## Bonus: IPTV relay

`worker/iptv-relay/` is a second Cloudflare Worker for browser IPTV players
that let you set a CORS proxy. It forwards playlist, Xtream API and (if the
player asks) stream requests to the provider, adds CORS headers, lets an
https page reach `http://` providers, and rewrites HLS playlists so their
segments also come through. It carries your provider login, so it is locked
with a secret path segment: deploy it, run `npx wrangler secret put RELAY_KEY`,
and set the player's proxy to `https://<worker>/<KEY>/?url={url}`.

## Development

Three files: `index.html`, `style.css`, `app.js`. No dependencies.
