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

## Reddit blocks direct browser requests (read this)

Reddit no longer allows plain browser pages to read its JSON from another
site, so the app needs a small relay that you own. It takes about five
minutes and is free:

1. Create an account at <https://workers.cloudflare.com> (free plan is plenty).
2. In the Cloudflare dashboard choose **Workers & Pages → Create → Create Worker**,
   give it a name like `quiet-reddit-relay`, and click **Deploy**.
3. Click **Edit code**, delete the sample code, paste in the contents of
   [`worker/worker.js`](worker/worker.js) from this repo, and click **Deploy**.
4. Copy the worker URL, e.g. `https://quiet-reddit-relay.yourname.workers.dev`.
5. Open the app, press ⚙, paste that URL into **Relay / CORS proxy URL**, close
   the dialog. Done; the setting is remembered in your browser.

Optional: to stop other people using your relay, set `ALLOWED_ORIGINS` at the
top of `worker.js` to `['https://<your-user>.github.io']`.

If you prefer the command line: `cd worker && npx wrangler deploy`.

Any other CORS proxy also works. A URL ending in `?url=` is treated as a
prefix for the encoded Reddit URL; anything else is treated as a host that
mirrors Reddit's paths.

## Development

Three files: `index.html`, `style.css`, `app.js`. No dependencies.
