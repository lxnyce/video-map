// Builds the viewer into dist/ (index.html + hashed assets), which `vmap build`
// copies into every output folder.
//
// Dev: VMAP_SCENE=path/to/built/dist npm run dev -w @videomap/viewer
// serves that build's scene.json and tiles alongside the live viewer source.
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: process.env.VMAP_SCENE || false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2020', 'safari14'],
    assetsDir: 'assets',
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
  server: { host: true },
});
