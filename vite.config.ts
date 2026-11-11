import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { BuildInfo } from './shared/buildInfo.ts';

/** What Settings > About shows: baked in here so the packaged app never runs git (shared/buildInfo.ts). */
function buildInfo(): BuildInfo {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = process.env.GITHUB_SHA?.slice(0, 7) ?? '';
  }
  return { version, commit, date: new Date().toISOString() };
}

const api = `http://127.0.0.1:${process.env.PORT ?? 4320}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __PODCODE_BUILD__: JSON.stringify(buildInfo()) },
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
