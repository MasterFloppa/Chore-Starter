import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api/': `http://127.0.0.1:${process.env.PORT ?? loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '').PORT ?? 8788}`,
    },
  },
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
}));
