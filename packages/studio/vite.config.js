// Builds the Studio web UI into dist/, which the Studio server serves.
//
// Dev: start the server (npx vmap studio), then `npm run dev:studio`; the dev
// server proxies the API and build previews to it (VMAP_STUDIO_URL, default
// http://localhost:5170).
import { defineConfig } from 'vite';

const target = process.env.VMAP_STUDIO_URL || 'http://localhost:5170';
// The server refuses writes from other origins, so requests look like they come from it.
const proxy = { target, changeOrigin: true, configure: (p) => p.on('proxyReq', (req) => req.setHeader('origin', target)) };

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: true,
  },
  server: {
    proxy: {
      '/api': proxy,
      '/preview': proxy,
    },
  },
});
