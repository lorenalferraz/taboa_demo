import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-dom') || id.includes('/react/') || id.endsWith('/react')) {
            return 'vendor-react';
          }
          if (id.includes('leaflet')) return 'vendor-leaflet';
          if (id.includes('@turf') || id.includes('/turf/')) return 'vendor-turf';
          if (id.includes('proj4')) return 'vendor-proj4';
        },
      },
    },
  },
});
