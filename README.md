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
counts, no NSFW/pinned flags, no reply nesting (comments show flat), and
galleries/videos open on Reddit instead of inline.

To run your own relay: create a free Cloudflare account, edit `ALLOWED_ORIGINS`
in `worker/worker.js` to your site's origin, then in `worker/` run
`npx wrangler login` and `npx wrangler deploy`. Paste the worker URL into
⚙ settings or into `DEFAULTS.proxy` in `app.js`.

## Development

Three files: `index.html`, `style.css`, `app.js`. No dependencies.
