import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
// Phase A: React + Tailwind + shadcn/ui pages living alongside the existing
// vanilla-JS pages (page-by-page migration - see docs/superpowers/specs/
// 2026-09-25-phase-a-spike-results.md, Spike 2, PASS). @vitejs/plugin-react
// pinned to ^4.7.0 on purpose - its 6.x major requires Vite 8, and this
// project is on Vite 5.4 (confirmed in the spike, don't let a bare
// `npm i @vitejs/plugin-react` silently grab latest and break this).
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Tauri expects a relative base and a fixed dev port so it can attach its
// webview to a predictable URL. See src-tauri/tauri.conf.json (devUrl / frontendDist).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn's generated components import via the "@/..." alias -
    // jsconfig.json alone only helps editor tooling, Vite's own bundler
    // needs this too (confirmed in Spike 2 - the build fails without it).
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Without this, Vite's fs watcher trips over cargo's build output
      // (e.g. a .lib file locked mid-write) and crashes with EBUSY on Windows.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
