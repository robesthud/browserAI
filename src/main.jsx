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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
