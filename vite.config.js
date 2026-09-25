import { defineConfig } from 'vite';

// Tauri expects a relative base and a fixed dev port so it can attach its
// webview to a predictable URL. See src-tauri/tauri.conf.json (devUrl / frontendDist).
export default defineConfig({
  base: './',
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