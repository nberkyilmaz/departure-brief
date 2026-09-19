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
  /*
   * The core package ships TypeScript sources rather than a build, so
   * dependency pre-bundling has to leave it alone and let Vite compile it
   * with everything else. Only the `judge` entry point is imported, which
   * is the half of the package that never reaches for Node.
   */
  optimizeDeps: { exclude: ['@depbrief/core'] },
});
