/**
 * @file pwa.js
 * @description Universal PWA Shell DOM Mount & Bundle Loader.
 * Uses IndexedDB local storage, DOM mounting into #app-root, and SWR hot-updates.
 * Completely eliminates 3rd-party iframe cookie/tracking prevention blocking.
 */

let deferredPrompt;
const DB_NAME = 'UniversalPwaShellDB';
const DB_VERSION = 1;
const STORE_NAME = 'app_bundles';

// 1. Service Worker Registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
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

// 4. Remote Bundle Fetcher (with CORS + JSONP fallback)
function fetchRemoteBundleJsonp(gasUrl, currentHash) {
  return new Promise((resolve) => {
    const callbackName = 'gas_bundle_cb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    }, 15000);

    function cleanup() {
      clearTimeout(timer);
      try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = (data) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(data);
      }
    };

    script.onerror = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null);
      }
    };

    const separator = gasUrl.includes('?') ? '&' : '?';
    script.src = `${gasUrl}${separator}action=bundle&callback=${callbackName}${currentHash ? '&currentHash=' + encodeURIComponent(currentHash) : ''}`;
    document.head.appendChild(script);
  });
}

async function fetchRemoteBundle(gasUrl, currentHash) {
  if (!gasUrl) return null;
  // Use JSONP script injection directly (bypasses 100% of browser CORS and tracking blocker restrictions)
  return fetchRemoteBundleJsonp(gasUrl, currentHash);
}

// 5. DOM Mounting Engine: Injects Styles, Markup, and Executes Scripts
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
  let headScripts = [];

  if (htmlContent.includes('<body') && htmlContent.includes('</body>')) {
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
      htmlContent = bodyMatch[1];
    }
  }

  // Clear root and inject markup
  root.innerHTML = htmlContent;

  // Extract and execute scripts within the mounted HTML
  const inlineScripts = root.querySelectorAll('script');
  inlineScripts.forEach((oldScript) => {
    const newScript = document.createElement('script');
    Array.from(oldScript.attributes).forEach((attr) => {
      newScript.setAttribute(attr.name, attr.value);
    });
    newScript.textContent = oldScript.textContent;
    oldScript.parentNode.removeChild(oldScript);
    document.body.appendChild(newScript);
  });

  // Inject additional bundle.script if present
  if (bundle.script) {
    const existingScript = document.getElementById('mounted-bundle-script');
    if (existingScript) existingScript.remove();

    const scriptTag = document.createElement('script');
    scriptTag.id = 'mounted-bundle-script';
    let cleanScript = bundle.script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    scriptTag.textContent = cleanScript;
    document.body.appendChild(scriptTag);
  }

  // Hide configuration modal if open
  const configModal = document.getElementById('config-modal');
  if (configModal) configModal.classList.add('is-hidden');

  // Trigger Alpine.js start if available
  if (window.Alpine && typeof window.Alpine.start === 'function') {
    try {
      window.Alpine.start();
    } catch (e) {
      // Alpine already initialized
    }
  }
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
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
      const installBar = document.getElementById('pwa-install-bar');
      if (installBar) installBar.classList.add('is-hidden');
    });
  }
}

// 7. Core Boot / Router Flow
async function initPWA() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'day-planner').toLowerCase();
  const explicitGasUrl = params.get('gasUrl');
  const storageKey = `gas_url_${appKey}`;
  const appDisplayName = formatAppName(appKey);

  document.title = `${appDisplayName}`;

  let gasUrl = explicitGasUrl || localStorage.getItem(storageKey);

  // Backward compatibility check for legacy storage keys
  if (!gasUrl) {
    gasUrl = localStorage.getItem('dayPlannerGasUrl') || localStorage.getItem('gas_planner_url');
    if (gasUrl) localStorage.setItem(storageKey, gasUrl);
  }

  const cached = await getCachedBundle(appKey);

  // A. If cached bundle exists: MOUNT INSTANTLY (0ms offline cold-start!)
  if (cached && (cached.bundle || cached.html)) {
    mountBundle(cached);

    // Background SWR update check if online
    if (navigator.onLine && gasUrl) {
      fetchRemoteBundle(gasUrl, cached.hash).then(async (update) => {
        if (update && !update.upToDate && (update.bundle || update.html)) {
          await saveCachedBundle(appKey, update);
          console.log('📦 Updated bundle cached for next launch.');
        }
      });
    }
    return;
  }

  // B. If gasUrl is saved, try fetching bundle from backend
  if (gasUrl && navigator.onLine) {
    const loadingText = document.getElementById('shell-loading-text');
    if (loadingText) loadingText.textContent = `Loading ${appDisplayName}...`;

    const remote = await fetchRemoteBundle(gasUrl, null);
    if (remote && (remote.bundle || remote.html)) {
      await saveCachedBundle(appKey, remote);
      mountBundle(remote);
      return;
    }
  }

  // C. Show Connection Setup Card
  const configModal = document.getElementById('config-modal');
  const input = document.getElementById('gas-url-input');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');

  if (modalTitle) modalTitle.textContent = `Connect ${appDisplayName}`;
  if (modalDesc) modalDesc.textContent = `Enter your Google Apps Script Web App URL to download and run the app:`;
  if (input && gasUrl) input.value = gasUrl;
  if (configModal) configModal.classList.remove('is-hidden');
}

async function handleConnect() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'day-planner').toLowerCase();
  const storageKey = `gas_url_${appKey}`;

  const input = document.getElementById('gas-url-input');
  const btnText = document.getElementById('launch-btn-text');
  const errorMsg = document.getElementById('shell-error-msg');
  if (!input) return;

  const url = input.value.trim();
  if (!url || !url.startsWith('http')) {
    if (errorMsg) {
      errorMsg.textContent = 'Please enter a valid Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec).';
      errorMsg.classList.remove('is-hidden');
    }
    return;
  }

  if (errorMsg) errorMsg.classList.add('is-hidden');
  if (btnText) btnText.textContent = 'Downloading bundle...';

  localStorage.setItem(storageKey, url);
  localStorage.setItem('dayPlannerGasUrl', url);

  const bundleData = await fetchRemoteBundle(url, null);
  if (bundleData && (bundleData.bundle || bundleData.html)) {
    await saveCachedBundle(appKey, bundleData);
    mountBundle(bundleData);
  } else {
    if (btnText) btnText.textContent = 'Launch Application';
    if (errorMsg) {
      errorMsg.textContent = '⚠️ Could not download bundle. Please verify your Web App is deployed with "Anyone" access and CORS enabled.';
      errorMsg.classList.remove('is-hidden');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    launchBtn.addEventListener('click', handleConnect);
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
  }

  const dismissBtn = document.getElementById('pwa-dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const installBar = document.getElementById('pwa-install-bar');
      if (installBar) installBar.classList.add('is-hidden');
    });
  }

  initPWA();
});
