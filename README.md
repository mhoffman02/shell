# Universal PWA Shell

A generic, installable Progressive Web App launcher that bootstraps private Google Apps Script web-app backends at a public GitHub Pages URL. The shell itself is pure static content and does not contain the actual application logic — that remains in a private GAS deployment. This architecture allows proprietary app UIs to stay server-side while still offering users a real installable PWA experience.

## What This Is

This repository is hosted as a static site at `mhoffman02.github.io/shell` and serves as a generic loader for one or more Google Apps Script web-app backends. It is not a monolithic application repository; instead, it:

- Maintains a roster of "known apps" (baked into `pwa.js`) that link to specific, pinned GAS deployments.
- Accepts arbitrary GAS web-app URLs via query parameter (with strict security validation).
- Remembers the last-used trusted URL for each app in browser localStorage.
- Falls back to a cached offline bundle (stored in IndexedDB or embedded in `pwa.js`) when the live GAS backend is unreachable.

The shell hands off to the GAS backend via a real top-level browser navigation (`window.location.href`), not an iframe or fetch, because Google's authentication system blocks both. When the live app is available, the user navigates directly to it; otherwise, they see a stale read-only cached snapshot.

## Files

- `index.html` — Entry point and container; defines the `#app-root` div for mounting cached bundles.
- `pwa.js` — The core shell logic (~260 KB including embedded offline-fallback bundles); manages app selection, URL validation, localStorage state, and the connect/launcher UI. Contains the `KNOWN_APPS` array.
- `styles.css` — Styling for the launcher picker and connect modal.
- `sw.js` — Service worker for PWA install capability and offline fallback.
- `manifest.json` — PWA manifest (defines app icon, name, start URL, display mode, etc.).
- `vendor/alpine.min.js` — Bundled Alpine.js (no CDN dependency).
- `icons/` — App icons and favicon in various sizes.
- `screenshots/` — Screenshots for PWA install prompts and app stores.

## Local Preview

No build step or npm install is needed. Serve the repository as static files:

```bash
# Python
python3 -m http.server 8000

# Node.js (http-server)
npx http-server

# Or any other static file server
```

Then visit `http://localhost:8000` in a browser. The shell works identically on a local server and on GitHub Pages.

## Usage

### Launcher Screen

Visiting the shell root (`/` or `/index.html`) shows a picker:

- **Known apps** — A list of pre-configured apps from the `KNOWN_APPS` array in `pwa.js`, each with a one-tap launch button. Currently includes "Day Planner" pointing to a specific pinned GAS deployment.
- **Connect a different app** — A text input and "Launch" button to enter an arbitrary GAS web-app URL (must pass a strict `https://script.google.com/macros/s/<id>/(exec|dev)` allowlist regex).

The first time you launch an app via any method, the chosen URL is stored in localStorage as the trusted source for that app key. Future visits automatically redirect to that URL.

### Query Parameters

- `?app=<key>` or `?name=<key>` — Select which app to target. Defaults to `day-planner`. Looked up against `KNOWN_APPS` in `pwa.js`.
- `?gasUrl=<url>` — Pre-fill a specific GAS web-app URL. Must match the strict pattern. **Security note:** An untrusted URL (not yet explicitly launched by the user) never auto-redirects; it only pre-fills the connect form and waits for a manual "Launch" click.
- `?dev=1` — Enable dev mode on this device. Sets a localStorage flag that reveals a "Launch /dev (testing)" button pointing to the GAS deployment's `/dev` URL, and disables auto-redirect-to-prod so the picker remains visible. This is a convenience toggle; the `/dev` URL is already restricted server-side by Google IAM to script editors.
- `?dev=0` — Clear dev mode on this device, reverting to normal (production-only) behavior.
- `?reset=1` — Clear the trusted-source localStorage entry for the current app key, forcing the connect picker to show again. Use this to recover when a previously-trusted URL has gone stale or access has been revoked.

### Offline & Stale Fallback

If the GAS backend is unreachable or there is no trusted URL yet, the shell attempts to display a cached copy of the app from:

1. IndexedDB (if the app has been used before and a fresh bundle was cached there).
2. The `BUILTIN_BUNDLES` snapshot embedded in `pwa.js` (a development/initial-load fallback).

This offline experience is read-only and may be stale; it is not a substitute for the live app, only a graceful degradation.

## Adding a New Known App

To offer a new app as a one-tap launcher:

1. Open `pwa.js` and locate the `KNOWN_APPS` array near the top.
2. Add an entry with:
   - `key` — A URL-safe identifier (e.g., `my-app`).
   - `name` — The display name.
   - `tagline` — A short description.
   - `url` — The pinned GAS `/exec` deployment URL (baked in by the developer, never from user input).
   - `icon` — Path to an icon image in `icons/` or a data URL.
3. Commit and push to GitHub; the site updates automatically.

## Security

- **URL allowlist:** Only Google Apps Script `/exec` or `/dev` URLs matching the pattern `https://script.google.com/macros/s/<id>/(exec|dev)` are ever accepted. This prevents the shell from being used as an open redirect to attacker-controlled domains.
- **Known apps:** Pre-configured app URLs are hard-coded in `pwa.js` by the developer, not sourced from user input or URL parameters.
- **User-supplied URLs:** When a user enters a `?gasUrl=` parameter or uses the "Connect a different app" form, the URL is validated and stored only after an explicit "Launch" click. Future auto-redirects only occur if the URL exactly matches a previously-trusted value, preventing silent redirects to new/untrusted targets.
- **No cloud storage:** This shell does not store any user data in the cloud. Cached bundles and trusted URLs live only in the visiting browser's IndexedDB and localStorage.

