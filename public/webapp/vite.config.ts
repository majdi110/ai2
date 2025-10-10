import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { brotliCompressSync, gzipSync } from 'zlib';
import { writeFileSync } from 'fs';
import path from 'path';

// Simple gzip & brotli compression plugin
function compressAssets() {
  return {
    name: 'compress-assets',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      const fs = require('fs');
      if (!fs.existsSync(distDir)) return;

      const files = fs.readdirSync(distDir);
      for (const file of files) {
        const fullPath = path.join(distDir, file);
        if (fs.statSync(fullPath).isFile() && /\.(js|css|html|svg)$/.test(file)) {
          const content = fs.readFileSync(fullPath);
          writeFileSync(fullPath + '.gz', gzipSync(content));
          writeFileSync(fullPath + '.br', brotliCompressSync(content));
        }
      }
      console.log('✅ Compression complete: gzip + brotli files created.');
    },
  };
}

// Production-optimized Vite configuration
export default defineConfig({
  plugins: [react(), compressAssets()],
  root: '.',
  // Set correct base path for deployment under datav.belocloud.com
  // Adjusted to match hosted URL: https://datav.belocloud.com/ai2/public/webapp/
  base: '/ai2/public/webapp/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    cssCodeSplit: true,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
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
  publicDir: 'public',
});



