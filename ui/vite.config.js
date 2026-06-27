import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  base: '/',
  build: {
    // Android System WebView on some devices can lag behind Chrome.
    // JS target is controlled by @vitejs/plugin-legacy.targets below.
    cssTarget: 'chrome61',
  },
  plugins: [
    react(),
    legacy({
      targets: ['Android >= 7', 'Chrome >= 61'],
      modernPolyfills: true,
      renderLegacyChunks: true,
    }),
  ],
});
