import { defineConfig } from 'vite';

export default defineConfig({
  base: '/encrypted-pouch/', // GitHub Pages base path
  define: {
    global: 'globalThis', // PouchDB v8 compatibility
  },
  server: {
    port: 3000,
  },
  build: {
    outDir: '../docs',
    emptyOutDir: false, // Don't clear docs/api/
  },
});
