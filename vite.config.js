import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  build: {
    // Android System WebView on some devices can lag behind Chrome.
    // Emit a more compatible bundle to avoid a blank screen in the APK WebView.
    target: 'es2015',
    cssTarget: 'chrome61',
  },
  plugins: [react()],
});
