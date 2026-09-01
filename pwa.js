/**
 * @file pwa.js
 * @description Universal PWA Shell launcher.
 * Offline-first: whenever a cached/BUILTIN_BUNDLES snapshot exists for the requested app,
 * it's mounted immediately on load — no click, no connectivity check. There are two
 * independent freshness paths after that first paint, because they face different
 * constraints:
 *   1. bundles.json (same-origin, this GitHub Pages site) — checkForFreshBundle() below
 *      background-refetches it after mount, compares its `hash` to what's cached, and
 *      silently updates the IndexedDB copy with a lightweight "Update ready" banner. No
 *      CORS issue here, so this is true stale-while-revalidate.
 *   2. The live GAS deployment (cross-origin) — going live is a separate, explicit action
 *      (the "Go live" banner, or a picker tile on first run) that hands off via a real
 *      top-level navigation (window.location.href), NOT an iframe or a fetch: both are
 *      blocked by Google's edge auth redirect (see shell-gas-pattern.md §9). That CORS gap
 *      is why *this* path stays "stale-first, explicit refresh" — there is no way to
 *      background-check whether the live app itself has changed.
 */

let deferredPrompt;
const DB_NAME = 'UniversalPwaShellDB';
const DB_VERSION = 1;
const STORE_NAME = 'app_bundles';

// Only Google Apps Script Web App deployment URLs are trusted as bundle sources.
// Anything else (attacker-controlled domains, ?gasUrl= query-param injection) is rejected.
const GAS_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)$/;
function isValidGasUrl(url) {
  return typeof url === 'string' && GAS_URL_PATTERN.test(url);
}

// Apps this shell can launch with a single tap — no URL to paste. Each `url` is baked
// into this file by the developer at deploy time, not supplied by a visitor/link, so it's
// trusted by construction the same way the rest of this file is trusted: launching one
// skips the consent modal that exists specifically to gate *untrusted* ?gasUrl= links.
// Add more entries here to offer additional apps from the same shell.
const KNOWN_APPS = [
  {
    key: 'day-planner',
    name: 'Day Planner',
    tagline: 'Tasks, calendar & daily notes',
    url: 'https://script.google.com/macros/s/AKfycbyAejUd5SWdt5dbmtSKYJZvwqQ2RHU-V3_mARJp3MDjMZ_jrlP0MfWnyTPYp6hVSyO4/exec',
    icon: './icons/icon.svg'
  }
];
function findKnownApp(key) {
  return KNOWN_APPS.find((a) => a.key === key) || null;
}

// Dev-mode: a low-key convenience toggle, not a security boundary — the GAS /dev URL it
// unlocks is already restricted server-side by Google IAM to accounts with edit access to
// the script project. Visiting once with ?dev=1 sets a localStorage flag so a "Launch /dev"
// link appears on this device going forward; ?dev=0 clears it.
const DEV_MODE_KEY = 'dpDevMode';
function isDevMode() {
  return localStorage.getItem(DEV_MODE_KEY) === '1';
}
function applyDevModeParam(params) {
  const dev = params.get('dev');
  if (dev === '1') localStorage.setItem(DEV_MODE_KEY, '1');
  else if (dev === '0') localStorage.removeItem(DEV_MODE_KEY);
}
function devUrlFor(app) {
  return app.url.replace(/\/exec$/, '/dev');
}

// Built-in Default Offline Application Bundles — loaded from ./bundles.json rather than
// embedded here as a JS object literal. Same bytes, but the browser's native JSON parser
// handles it instead of V8's JS-syntax parser during this script's own compile, and
// sw.js precaches bundles.json like any other asset, so this resolves from Cache Storage
// (not the network) on every load after the first. See build-shell-bundle.js.
let builtinBundlesPromise = null;
function getBuiltinBundles() {
  if (!builtinBundlesPromise) {
    builtinBundlesPromise = fetch('./bundles.json')
      .then((res) => {
        if (!res.ok) throw new Error(`bundles.json: HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        console.error('[shell] Failed to load bundles.json', err && err.stack || err);
        return {};
      });
  }
  return builtinBundlesPromise;
}

// 1. Service Worker Registration
//
// Browsers throttle their own automatic sw.js byte-diff check to roughly once
// per 24h per registration, so a plain reload can keep serving a stale cached
// bundle indefinitely even right after a fresh deploy. Explicitly calling
// registration.update() bypasses that throttle, and reloading once when the
// new worker actually takes control (controllerchange) means a single visit
// is enough to pick up a new release instead of requiring a manual
// DevTools -> Unregister -> reload dance.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then((registration) => registration.update())
    .catch(console.error);

  let swRefreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshed) return;
    swRefreshed = true;
    window.location.reload();
  });
}

// 2. Format app name from slug (e.g., 'day-planner' -> 'Day Planner')
function formatAppName(slug) {
  if (!slug || slug === 'default' || slug === 'app') return 'Day Planner';
  return slug
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// 3. IndexedDB Helper for Storing/Loading Bundles
function openShellDb() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

async function getCachedBundle(appKey) {
  try {
    const db = await openShellDb();
    const key = `bundle_${appKey}`;
    if (!db) {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      return raw ? JSON.parse(raw) : null;
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    console.warn('Could not read cached bundle:', e);
    return null;
  }
}

async function saveCachedBundle(appKey, bundleObj) {
  try {
    const db = await openShellDb();
    const key = `bundle_${appKey}`;
    if (!db) {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(key, JSON.stringify(bundleObj));
      }
      return;
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(bundleObj, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch (e) {
    console.warn('Could not save bundle cache:', e);
  }
}

// 3b. Background freshness check (stale-while-revalidate for bundles.json only — see the
// file header for why the live GAS app can't use the same approach). Runs after the cached
// bundle is already mounted, so it never blocks or delays first paint. sw.js serves
// bundles.json network-first specifically so this sees a same-day rebake instead of whatever
// was precached at install time.
async function checkForFreshBundle(appKey, mountedEntry) {
  if (!navigator.onLine) return;
  try {
    const res = await fetch('./bundles.json', { cache: 'no-store' });
    if (!res.ok) return;
    const fresh = (await res.json())[appKey];
    if (!fresh || !fresh.hash) return;
    if (mountedEntry && mountedEntry.hash === fresh.hash) return; // already current

    await saveCachedBundle(appKey, fresh);
    showUpdateBanner();
  } catch (err) {
    console.warn('[shell] Background bundle freshness check failed:', err && err.stack || err);
  }
}

// 4. DOM Mounting Engine: Injects Styles, Markup, and Executes Scripts
function mountBundle(bundlePayload) {
  const root = document.getElementById('app-root');
  if (!root || !bundlePayload) return;

  const bundle = bundlePayload.bundle || bundlePayload;

  // Set document title & theme
  if (bundle.title) {
    document.title = bundle.title;
  }
  if (bundle.themeColor) {
    let themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', bundle.themeColor);
  }

  // Inject Styles
  if (bundle.styles) {
    let styleTag = document.getElementById('mounted-bundle-styles');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'mounted-bundle-styles';
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = bundle.styles;
  }

  // Extract HTML body content if full document provided
  let htmlContent = bundle.html || '';

  if (htmlContent.includes('<body') && htmlContent.includes('</body>')) {
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
      htmlContent = bodyMatch[1];
    }
  }

  // Pull inline <script> blocks (no src) out of the HTML *before* it's mounted, so they
  // run alongside bundle.script in Step 1 below instead of after root.innerHTML in Step 3
  // — otherwise they'd hit the same Alpine x-data race that bundle.script had.
  let inlineHtmlScripts = '';
  htmlContent = htmlContent.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (match, code) => {
    inlineHtmlScripts += code + '\n';
    return '';
  });

  // ── STEP 1: Inject bundle.script + inline HTML scripts FIRST (before any HTML) ─────
  // Alpine's MutationObserver fires the instant root.innerHTML is set and immediately
  // tries to resolve x-data="plannerApp". If this script runs AFTER innerHTML,
  // Alpine sees plannerApp before Alpine.data() has registered it → ReferenceError.
  // Script tags with textContent (no src) execute SYNCHRONOUSLY when appended to head.
  const combinedScript = [bundle.script, inlineHtmlScripts].filter(Boolean).join('\n');
  if (combinedScript) {
    const existingScript = document.getElementById('mounted-bundle-script');
    if (existingScript) existingScript.remove();

    const scriptTag = document.createElement('script');
    scriptTag.id = 'mounted-bundle-script';
    let cleanScript = combinedScript
      .replace(/^\s*<script[^>]*>\s*/i, '')
      .replace(/\s*<\/script>\s*$/i, '')
      .trim();
    scriptTag.textContent = cleanScript;
    document.head.appendChild(scriptTag); // synchronous — plannerApp now registered
  }

  // ── STEP 2: NOW inject HTML — Alpine sees plannerApp already registered ──────
  root.innerHTML = htmlContent;

  // ── STEP 3: Re-attach any remaining external <script src> tags from the mounted HTML ──
  // (skip CDN Alpine script tags — already loaded from vendor/alpine.min.js)
  const externalScripts = root.querySelectorAll('script[src]');
  externalScripts.forEach((oldScript) => {
    const src = oldScript.getAttribute('src') || '';
    if (src.includes('alpine')) {
      oldScript.parentNode.removeChild(oldScript);
      return;
    }
    const newScript = document.createElement('script');
    Array.from(oldScript.attributes).forEach((attr) => {
      newScript.setAttribute(attr.name, attr.value);
    });
    oldScript.parentNode.removeChild(oldScript);
    document.body.appendChild(newScript);
  });

  // Hide configuration modal and loading/transition overlay if open — #shell-loading now
  // lives outside #app-root (see index.html) so it survives this mount and must be hidden
  // explicitly instead of being implicitly wiped by the innerHTML assignment above.
  const configModal = document.getElementById('config-modal');
  if (configModal) configModal.classList.add('is-hidden');
  const loadingOverlay = document.getElementById('shell-loading');
  if (loadingOverlay) loadingOverlay.classList.add('is-hidden');

  // DO NOT call Alpine.start() here — vendor/alpine.min.js auto-starts via defer.
}

// 4b. Hand off to the live GAS deployment via a top-level navigation. Brief delay before
// the navigation fires so the "Not this app?" escape hatch is actually clickable — a bad
// or rotated trusted URL otherwise has no recovery path short of a manual ?reset=1.
const REDIRECT_DELAY_MS = 600;
let redirectTimer = null;

function redirectToApp(appDisplayName, gasUrl, appKey) {
  clearTimeout(redirectTimer);

  const configModal = document.getElementById('config-modal');
  const loading = document.getElementById('shell-loading');
  const loadingText = document.getElementById('shell-loading-text');
  if (configModal) configModal.classList.add('is-hidden');
  if (loading) loading.classList.remove('is-hidden');
  if (loadingText) loadingText.textContent = `Opening ${appDisplayName}…`;

  let escapeLink = document.getElementById('shell-redirect-escape');
  if (!escapeLink && loading) {
    escapeLink = document.createElement('a');
    escapeLink.id = 'shell-redirect-escape';
    escapeLink.href = '#';
    escapeLink.className = 'shell-redirect-escape';
    escapeLink.textContent = 'Not this app? Choose a different app';
    loading.appendChild(escapeLink);
  }
  if (escapeLink) {
    escapeLink.classList.remove('is-hidden');
    escapeLink.onclick = (e) => {
      e.preventDefault();
      clearTimeout(redirectTimer);
      escapeLink.classList.add('is-hidden');
      localStorage.removeItem(`gas_url_${appKey}`);
      if (appKey === 'day-planner') {
        localStorage.removeItem('dayPlannerGasUrl');
        localStorage.removeItem('gas_planner_url');
      }
      if (loading) loading.classList.add('is-hidden');
      showConnectPrompt(appDisplayName, null, null);
    };
  }

  redirectTimer = setTimeout(() => {
    window.location.href = gasUrl;
  }, REDIRECT_DELAY_MS);
}

// 5. Offline-first "Go live" banner. Shown over the mounted cached bundle whenever a
// trusted GAS URL is on file and the browser reports online — a single explicit action to
// hand off to the live app, standing in for a background refresh that §9's CORS gap makes
// impossible to do silently. Lives outside #app-root so mountBundle() never clobbers it.
function showGoLiveBanner(appDisplayName, gasUrl, appKey) {
  const banner = document.getElementById('shell-golive-link');
  if (!banner) return;
  banner.classList.remove('is-hidden');
  banner.onclick = (e) => {
    e.preventDefault();
    hideGoLiveBanner();
    redirectToApp(appDisplayName, gasUrl, appKey);
  };
}

function hideGoLiveBanner() {
  const banner = document.getElementById('shell-golive-link');
  if (banner) banner.classList.add('is-hidden');
}

// 5b. "Update ready" banner — shown once checkForFreshBundle() has already swapped a newer
// bundle into IndexedDB. Distinct from "Go live": this never navigates anywhere, it just
// reloads so mountBundle() picks up the bundle that's already sitting in the cache.
function showUpdateBanner() {
  const banner = document.getElementById('shell-update-link');
  if (!banner) return;
  banner.classList.remove('is-hidden');
  banner.onclick = (e) => {
    e.preventDefault();
    window.location.reload();
  };
}

// 6. PWA Install Prompt Listener
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;

  const params = new URLSearchParams(window.location.search);
  const appKey = params.get('app') || params.get('name') || 'day-planner';
  const appDisplayName = formatAppName(appKey);

  const installBar = document.getElementById('pwa-install-bar');
  const installText = document.getElementById('pwa-install-text');

  if (installBar && installText) {
    installText.textContent = `Install ${appDisplayName}`;
    installBar.classList.remove('is-hidden');
  }
});

function installPWA() {
  if (deferredPrompt) {
    const installBar = document.getElementById('pwa-install-bar');
    const installText = document.getElementById('pwa-install-text');
    if (installBar) installBar.classList.add('is-installing');
    if (installText) installText.textContent = 'Installing…';

    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
      if (installBar) {
        installBar.classList.remove('is-installing');
        installBar.classList.add('is-hidden');
      }
    });
  }
}

// 6b. iOS "Add to Home Screen" hint. Safari has no beforeinstallprompt event, so there's
// no programmatic install trigger — the best we can do is surface the manual Share-sheet
// steps once, then remember the user saw it.
function isIOS() {
  const ua = navigator.userAgent || '';
  const isIPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isIPadOS13Plus;
}

function isStandaloneDisplay() {
  return window.navigator.standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

function maybeShowIOSInstallHint() {
  if (!isIOS() || isStandaloneDisplay()) return;
  if (localStorage.getItem('iosInstallHintDismissed') === '1') return;

  const installBar = document.getElementById('pwa-install-bar');
  const installText = document.getElementById('pwa-install-text');
  if (!installBar || !installText) return;

  installBar.classList.add('is-ios-hint');
  installText.textContent = 'Tap Share, then "Add to Home Screen"';
  installBar.classList.remove('is-hidden');
}

// 7. Core Boot / Router Flow
async function initPWA() {
  const params = new URLSearchParams(window.location.search);
  applyDevModeParam(params);
  const rawAppParam = params.get('app') || params.get('name');
  const explicitAppKey = rawAppParam ? rawAppParam.toLowerCase() : null;
  const appKey = explicitAppKey || 'day-planner';
  const rawExplicitGasUrl = params.get('gasUrl');
  const storageKey = `gas_url_${appKey}`;
  const appDisplayName = formatAppName(appKey);

  document.title = `${appDisplayName}`;

  // Looked up up-front (before the reset/picker branches below) so both can offer the
  // "Use offline copy" fallback link regardless of which branch is taken — a reset only
  // forgets the trusted URL, not whatever's already cached.
  let cached = await getCachedBundle(appKey);
  if (!cached) {
    const builtinBundles = await getBuiltinBundles();
    if (builtinBundles[appKey] || builtinBundles['day-planner']) {
      cached = builtinBundles[appKey] || builtinBundles['day-planner'];
      await saveCachedBundle(appKey, cached); // persist to IndexedDB for future loads
      console.log('📦 Hydrated from bundles.json (offline cold-start).');
    }
  }
  const hasOfflineCopy = !!(cached && (cached.bundle || cached.html));

  // ?reset=1 clears this app's trusted source and forces the picker — the recovery path
  // when a previously-trusted URL has gone bad (deployment rotated, access revoked) and
  // would otherwise auto-redirect to a dead page on every visit.
  if (params.get('reset') === '1') {
    localStorage.removeItem(storageKey);
    if (appKey === 'day-planner') {
      localStorage.removeItem('dayPlannerGasUrl');
      localStorage.removeItem('gas_planner_url');
    }
    showConnectPrompt(appDisplayName, null, explicitAppKey, hasOfflineCopy);
    return;
  }

  let trustedGasUrl = localStorage.getItem(storageKey);

  // Backward compatibility check for legacy storage keys
  if (!trustedGasUrl) {
    trustedGasUrl = localStorage.getItem('dayPlannerGasUrl') || localStorage.getItem('gas_planner_url');
    if (trustedGasUrl) localStorage.setItem(storageKey, trustedGasUrl);
  }

  // A ?gasUrl= link only auto-runs if it matches a source already approved for this app
  // (via a prior explicit Launch click). A new/unrecognized source is never redirected to
  // silently — even if it passes the URL allowlist — it just pre-fills the Connect modal
  // below and waits for the user to click Launch.
  let pendingGasUrl = null;
  if (rawExplicitGasUrl) {
    if (!isValidGasUrl(rawExplicitGasUrl)) {
      console.warn('Ignoring invalid gasUrl parameter.');
    } else if (rawExplicitGasUrl !== trustedGasUrl) {
      pendingGasUrl = rawExplicitGasUrl;
    }
  }

  // B. Offline-first default: whenever a cached/offline bundle exists, mount it
  // immediately — online or not, trusted URL or not. This is the fast path on every normal
  // visit and is what keeps the app usable regardless of whether a live handoff would even
  // succeed (a wrong Google account slot, an org policy block, or no connectivity all look
  // the same from here: the cached view just loads). Going live is opt-in from here via the
  // "Go live" banner (trusted URL + online) rather than gating first paint on it.
  if (hasOfflineCopy) {
    mountBundle(cached);
    checkForFreshBundle(appKey, cached); // fire-and-forget; see file header
    if (pendingGasUrl) {
      showConnectPrompt(appDisplayName, pendingGasUrl, explicitAppKey, hasOfflineCopy);
    } else if (trustedGasUrl && navigator.onLine) {
      showGoLiveBanner(appDisplayName, trustedGasUrl, appKey);
    }
    return;
  }

  // C. Nothing cached yet (true first run): show the launcher — known-app quick-launch
  // tiles if any apply, otherwise the custom-connect form pre-filled with any
  // previously-trusted URL. Nothing executes until the user takes an explicit action (a
  // tile tap, or Launch in handleConnect) — there's no offline copy to fall back to yet, so
  // this is the one case that still requires a live connection.
  showConnectPrompt(appDisplayName, pendingGasUrl || null, explicitAppKey, hasOfflineCopy);
}

// Renders quick-launch tiles for KNOWN_APPS into #app-picker. If explicitAppKey names a
// known app, only that one tile is shown (deep-link/shortcut case); otherwise all known
// apps are offered so the visitor can choose.
function renderAppPicker(explicitAppKey) {
  const picker = document.getElementById('app-picker');
  if (!picker) return;
  const match = explicitAppKey ? findKnownApp(explicitAppKey) : null;
  const apps = match ? [match] : KNOWN_APPS;

  picker.innerHTML = '';
  apps.forEach((app) => {
    const link = document.createElement('a');
    link.className = 'app-tile';
    link.href = app.url;
    link.setAttribute('aria-label', `Launch ${app.name}`);
    link.innerHTML = `
      <img class="app-tile-icon" src="${app.icon}" alt="" width="40" height="40">
      <span class="app-tile-text">
        <span class="app-tile-name"></span>
        ${app.tagline ? '<span class="app-tile-tagline"></span>' : ''}
      </span>
      <svg class="app-tile-arrow" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    `;
    link.querySelector('.app-tile-name').textContent = app.name;
    const taglineEl = link.querySelector('.app-tile-tagline');
    if (taglineEl) taglineEl.textContent = app.tagline;
    link.addEventListener('click', (e) => launchKnownApp(app, link, e));
    picker.appendChild(link);
  });
}

// One-tap launch for a KNOWN_APPS entry: a real <a href> to its baked-in URL, so the
// browser performs a genuine, user-activated top-level navigation in the current window
// (no JS-driven location.href, no setTimeout delay) — a script-scheduled redirect loses
// user-activation status by the time it fires, which some Google account-resolution flows
// treat differently (observed: silently landing on the wrong signed-in Google account's
// Drive rather than the one that just authenticated). Persists the URL as trusted for
// silent loads on future visits, same as handleConnect, then lets the click proceed
// natively — no paste, no consent modal needed, since the URL is developer-shipped, not
// visitor-supplied.
async function launchKnownApp(app, linkEl, clickEvent) {
  const errorMsg = document.getElementById('shell-error-msg');
  if (errorMsg) errorMsg.classList.add('is-hidden');
  localStorage.setItem(`gas_url_${app.key}`, app.url);
  if (app.key === 'day-planner') localStorage.setItem('dayPlannerGasUrl', app.url);

  if (navigator.onLine) {
    return; // let the native <a> navigation proceed
  }

  // Offline: fall back to whatever's cached for this app (if anything) instead of letting
  // the link navigate to a live URL that can't be reached.
  if (clickEvent) clickEvent.preventDefault();
  if (linkEl) linkEl.classList.add('is-loading');
  const cached = (await getCachedBundle(app.key)) ||
    (await getBuiltinBundles())[app.key] || null;
  if (cached && (cached.bundle || cached.html)) {
    mountBundle(cached);
    return;
  }
  if (linkEl) linkEl.classList.remove('is-loading');
  if (errorMsg) {
    errorMsg.textContent = `⚠️ You're offline and ${app.name} hasn't been opened on this device yet. Connect to the internet and try again.`;
    errorMsg.classList.remove('is-hidden');
  }
}

function showConnectPrompt(appDisplayName, prefillUrl, explicitAppKey, hasOfflineCopy) {
  const configModal = document.getElementById('config-modal');
  const input = document.getElementById('gas-url-input');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');
  const picker = document.getElementById('app-picker');
  const customConnect = document.getElementById('custom-connect');

  // Show the tile picker unless: a specific (untrusted, link-supplied) URL needs explicit
  // review, there are no known apps at all, or an explicit ?app= names an app we don't know.
  const showPicker = !prefillUrl && KNOWN_APPS.length > 0 && (!explicitAppKey || findKnownApp(explicitAppKey));

  if (showPicker) {
    if (modalTitle) modalTitle.textContent = explicitAppKey ? `Launch ${appDisplayName}` : 'Application Launcher';
    if (modalDesc) modalDesc.textContent = explicitAppKey ? 'Tap to launch — no setup needed.' : 'Choose an app to launch:';
    renderAppPicker(explicitAppKey);
    if (picker) picker.classList.remove('is-hidden');
    if (customConnect) customConnect.open = false;
  } else {
    if (modalTitle) modalTitle.textContent = `Connect ${appDisplayName}`;
    if (modalDesc) modalDesc.textContent = prefillUrl
      ? 'A new source was provided. Review and launch to continue:'
      : 'Enter your Google Apps Script Web App URL to launch the app:';
    if (picker) picker.classList.add('is-hidden');
    if (customConnect) customConnect.open = true;
    if (input && prefillUrl) input.value = prefillUrl;
  }

  const devBtn = document.getElementById('dev-launch-btn');
  if (devBtn) {
    const knownApp = findKnownApp(explicitAppKey || 'day-planner');
    devBtn.classList.toggle('is-hidden', !(isDevMode() && knownApp));
  }

  const offlineBtn = document.getElementById('use-offline-btn');
  if (offlineBtn) offlineBtn.classList.toggle('is-hidden', !hasOfflineCopy);

  if (configModal) configModal.classList.remove('is-hidden');
}

// Manual fallback for a live tile tap that lands on a Google account/org error page
// instead of the app — see the "Use offline copy" note in index.html. Mounts whatever is
// already cached (IndexedDB or the build-time BUILTIN_BUNDLES snapshot) without attempting
// any live fetch, so it works the same whether the underlying problem was connectivity or
// a blocked/misrouted Google account.
async function useOfflineCopy() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'day-planner').toLowerCase();
  const builtinBundles = await getBuiltinBundles();
  const cached = (await getCachedBundle(appKey)) ||
    builtinBundles[appKey] || builtinBundles['day-planner'] || null;
  if (cached && (cached.bundle || cached.html)) {
    mountBundle(cached);
  }
}

async function handleConnect() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'day-planner').toLowerCase();
  const storageKey = `gas_url_${appKey}`;

  const input = document.getElementById('gas-url-input');
  const errorMsg = document.getElementById('shell-error-msg');
  if (!input) return;

  const url = input.value.trim();
  if (!isValidGasUrl(url)) {
    if (errorMsg) {
      errorMsg.textContent = 'Please enter a valid Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec).';
      errorMsg.classList.remove('is-hidden');
    }
    return;
  }

  if (errorMsg) errorMsg.classList.add('is-hidden');

  localStorage.setItem(storageKey, url);
  if (appKey === 'day-planner') localStorage.setItem('dayPlannerGasUrl', url);

  if (navigator.onLine) {
    redirectToApp(formatAppName(appKey), url, appKey);
    return;
  }

  if (errorMsg) {
    errorMsg.textContent = '⚠️ You appear to be offline. Connect to the internet to launch this app.';
    errorMsg.classList.remove('is-hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    launchBtn.addEventListener('click', handleConnect);
  }

  const devBtn = document.getElementById('dev-launch-btn');
  if (devBtn) {
    devBtn.addEventListener('click', () => {
      const params = new URLSearchParams(window.location.search);
      const appKey = (params.get('app') || params.get('name') || 'day-planner').toLowerCase();
      const app = findKnownApp(appKey);
      if (app) redirectToApp(`${app.name} (dev)`, devUrlFor(app), app.key);
    });
  }

  const offlineBtn = document.getElementById('use-offline-btn');
  if (offlineBtn) {
    offlineBtn.addEventListener('click', useOfflineCopy);
  }

  const input = document.getElementById('gas-url-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleConnect();
    });
  }

  const installBar = document.getElementById('pwa-install-bar');
  if (installBar) {
    installBar.addEventListener('click', (e) => {
      if (e.target.id !== 'pwa-dismiss-btn') {
        installPWA();
      }
    });
    installBar.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.id !== 'pwa-dismiss-btn') {
        e.preventDefault();
        installPWA();
      }
    });
  }

  const dismissBtn = document.getElementById('pwa-dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const installBar = document.getElementById('pwa-install-bar');
      if (installBar) {
        if (installBar.classList.contains('is-ios-hint')) {
          localStorage.setItem('iosInstallHintDismissed', '1');
        }
        installBar.classList.add('is-hidden');
      }
    });
  }

  maybeShowIOSInstallHint();
  initPWA();
});
