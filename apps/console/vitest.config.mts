import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Only this app's tests. The workspace root has Node-runner tests that use
    // node:test and would fail under Vitest's globals.
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
