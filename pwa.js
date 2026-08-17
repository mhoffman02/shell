/**
 * @file pwa.js
 * @description Auto-generated JSDoc header for pwa.js.
 */

let deferredPrompt;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBar = document.getElementById('pwa-install-bar');
  if (installBar) {
    installBar.style.display = 'flex';
  }
});

function installPWA() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
      const installBar = document.getElementById('pwa-install-bar');
      if (installBar) {
        installBar.style.display = 'none';
      }
    });
  }
}

function initPWA() {
  const params = new URLSearchParams(window.location.search);
  let gasUrl = params.get('gasUrl') || localStorage.getItem('gas_planner_url');

  const configModal = document.getElementById('config-modal');
  const appFrame = document.getElementById('app-frame');

  if (!gasUrl) {
    if (configModal) configModal.style.display = 'flex';
  } else {
    localStorage.setItem('gas_planner_url', gasUrl);
    if (appFrame) appFrame.src = gasUrl;
  }
}

function saveGasUrl() {
  const input = document.getElementById('gas-url-input');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    localStorage.setItem('gas_planner_url', val);
    const configModal = document.getElementById('config-modal');
    const appFrame = document.getElementById('app-frame');
    if (configModal) configModal.style.display = 'none';
    if (appFrame) appFrame.src = val;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const launchBtn = document.getElementById('launch-btn');
  if (launchBtn) {
    launchBtn.addEventListener('click', saveGasUrl);
  }

  const installBar = document.getElementById('pwa-install-bar');
  if (installBar) {
    installBar.addEventListener('click', installPWA);
  }

  initPWA();
});
