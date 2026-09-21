import { defineConfig } from 'vite';

// Tauri expects a relative base and a fixed dev port so it can attach its
// webview to a predictable URL. See src-tauri/tauri.conf.json (devUrl / frontendDist).
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
