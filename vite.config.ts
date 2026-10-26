import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://127.0.0.1:5178',
    },
  },
});
