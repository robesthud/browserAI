import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { registerServiceWorker } from './lib/pwa.js'

// Register the PWA service worker as early as possible — installable app
// + offline shell + Web Push entry point. Fully optional: silently noops
// on browsers without serviceWorker support.
if (import.meta.env.MODE === 'production' || import.meta.env.PROD) {
  // Only in prod: in dev Vite serves an HMR client and would conflict
  // with the SW caching layer.
  void registerServiceWorker()
}

// Handle Chunk Load Errors (dynamic import failures after a new deploy)
// This globally catches the "Failed to fetch dynamically imported module" error
// and triggers a single reload to get the latest version.
window.addEventListener('error', (e) => {
  if (e.message?.includes('dynamically imported module') || e.message?.includes('chunk')) {
    const lastReload = Number(localStorage.getItem('browserai.last_auto_reload') || 0);
    const now = Date.now();
    // Throttle to once per 10s to avoid reload loops
    if (now - lastReload > 10000) {
      localStorage.setItem('browserai.last_auto_reload', String(now));
      window.location.reload();
    }
  }
}, true);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
