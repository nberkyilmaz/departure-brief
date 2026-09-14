import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    // The published build is the one that carries its own reports, so that
    // is the build under test. This has to be set before the app module is
    // evaluated, which is why it lives here and not in a test file.
    env: { VITE_DEMO: '1' },
    // Rendering the page and judging a flight in jsdom is not instant.
    testTimeout: 20_000,
  },
});
