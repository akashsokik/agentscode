import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = `http://127.0.0.1:${process.env.PORT ?? 4320}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': api,
      '/ws': { target: api, ws: true },
    },
  },
  optimizeDeps: { entries: ['index.html', 'quick.html'] },
  // The syntax highlighter's language pack is large; fine for an app served from localhost.
  // quick.html is the desktop app's floating quick composer window (web/quick, electron/quickWindow.ts).
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: 'index.html', quick: 'quick.html' } },
  },
});
