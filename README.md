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

## If Reddit blocks requests

Reddit sometimes refuses or rate-limits unauthenticated JSON requests
(HTTP 403/429), especially from data-center or VPN IPs. From a normal home or
mobile connection it usually works. If it doesn't, you can point the app at a
CORS proxy you control via ⚙ settings: the proxy prefix is prepended to the
URL-encoded Reddit URL, e.g. `https://my-proxy.example/?url=`.

## Development

Three files: `index.html`, `style.css`, `app.js`. No dependencies.
