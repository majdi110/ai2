import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production-optimized Vite configuration
export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './', // ensures proper relative paths when served under /public/webapp/
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    cssCodeSplit: true,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
  preview: {
    port: 4173,
    open: true,
  },
});


