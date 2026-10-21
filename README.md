# Quiet Reddit

A low-profile, text-first Reddit reader that runs entirely in your browser.
No server, no build step, no account: it reads Reddit's public JSON directly.

- **No ads.** Promoted posts are dropped before rendering.
- **No images until you ask.** Pictures, galleries, videos and link previews are
  replaced by a small "show image" button. Click to load, click again to hide.
- **Quiet by default.** NSFW and pinned posts are hidden (toggle in settings),
  and you can mute posts by keyword.
- Browse any subreddit or multi (`a+b+c`), sort by hot/new/top/rising,
  read full comment threads with collapsible replies, star favourite subreddits,
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

Reddit refuses anonymous requests from browsers on other sites and from cloud
servers, so the app talks to Reddit through a small relay: a Cloudflare Worker
(`worker/worker.js`) that authenticates with Reddit's official API using a
registered Reddit app, and adds the CORS headers browsers need. The deployed
relay URL is the app's default; you can point it at your own in ⚙ settings.

To run your own relay:

1. Register an app at <https://www.reddit.com/prefs/apps> (type **script**,
   any name, redirect URI `http://localhost`). Note the client id (under the
   app name) and the secret.
2. Create a free Cloudflare account, then in `worker/`:
   `npx wrangler login`, `npx wrangler secret put REDDIT_CLIENT_ID`,
   `npx wrangler secret put REDDIT_CLIENT_SECRET`, `npx wrangler deploy`.
3. Edit `ALLOWED_ORIGINS` in `worker.js` to your site's origin, and paste the
   worker URL into ⚙ settings (or into `DEFAULTS.proxy` in `app.js`).

## Development

Three files: `index.html`, `style.css`, `app.js`. No dependencies.
