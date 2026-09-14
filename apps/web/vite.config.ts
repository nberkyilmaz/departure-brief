import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // A GitHub Pages project site is served from a sub-path, so the build
  // needs to know it. Local and API-served builds keep the root.
  base: process.env['VITE_BASE'] ?? '/',
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
