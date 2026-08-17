/**
 * @file pwa.js
 * @description Universal PWA Shell Loader. Handles dynamic multi-app routing, local URL persistence,
 * dynamic app branding, and install prompts.
 */

let deferredPrompt;

// 1. Service Worker Registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

// 2. Format app name from slug (e.g., 'day-planner' -> 'Day Planner')
function formatAppName(slug) {
  if (!slug) return 'App';
  return slug
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// 3. PWA Install Prompt Listener
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;

  const params = new URLSearchParams(window.location.search);
  const appKey = params.get('app') || params.get('name') || '';
  const appDisplayName = formatAppName(appKey);

  const installBar = document.getElementById('pwa-install-bar');
  const installText = document.getElementById('pwa-install-text');
  
  if (installBar && installText) {
    installText.textContent = appKey ? `Install ${appDisplayName}` : 'Install App';
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

// 4. Initialize Multi-App Router
function initPWA() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'default').toLowerCase();
  const explicitGasUrl = params.get('gasUrl');
  const storageKey = `gas_url_${appKey}`;
  const appDisplayName = formatAppName(appKey === 'default' ? '' : appKey);

  // Update Page Title and Modal Copy Dynamically
  if (appKey !== 'default') {
    document.title = `${appDisplayName} — Workspace`;
    const modalTitle = document.getElementById('modal-title');
    const modalDesc = document.getElementById('modal-desc');
    if (modalTitle) modalTitle.textContent = `Connect ${appDisplayName}`;
    if (modalDesc) modalDesc.textContent = `Enter your Google Apps Script Web App URL to link ${appDisplayName}:`;
  }

  let gasUrl = explicitGasUrl || localStorage.getItem(storageKey);

  // Backward compatibility check for legacy planner key
  if (!gasUrl && (appKey === 'day-planner' || appKey === 'planner' || appKey === 'default')) {
    gasUrl = localStorage.getItem('gas_planner_url');
    if (gasUrl) localStorage.setItem(storageKey, gasUrl);
  }

  const configModal = document.getElementById('config-modal');
  const appFrame = document.getElementById('app-frame');

  if (!gasUrl) {
    if (configModal) configModal.classList.remove('is-hidden');
  } else {
    localStorage.setItem(storageKey, gasUrl);
    if (appFrame) appFrame.src = gasUrl;
  }
}

function saveGasUrl() {
  const params = new URLSearchParams(window.location.search);
  const appKey = (params.get('app') || params.get('name') || 'default').toLowerCase();
  const storageKey = `gas_url_${appKey}`;

  const input = document.getElementById('gas-url-input');
  if (!input) return;
  const val = input.value.trim();
  
  if (val) {
    localStorage.setItem(storageKey, val);
    const configModal = document.getElementById('config-modal');
    const appFrame = document.getElementById('app-frame');
    if (configModal) configModal.classList.add('is-hidden');
    if (appFrame) appFrame.src = val;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    launchBtn.addEventListener('click', saveGasUrl);
  }

  // Handle Enter key inside input
  const input = document.getElementById('gas-url-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveGasUrl();
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
