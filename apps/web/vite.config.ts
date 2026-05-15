import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          if (normalized.includes('/node_modules/@mkkellogg/gaussian-splats-3d/')) return 'gaussian-splats';
          if (normalized.includes('/node_modules/@react-three/')) return 'react-three';
          if (normalized.includes('/node_modules/three/examples/')) return 'three-examples';
          if (normalized.includes('/node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['f.meta-factory.kr'],
    watch: {
      usePolling: true, // Windows 파일 변경 감지
      interval: 1000, // 1초마다 폴링
    },
    proxy: {
      '/api': {
        target: 'http://fss-api:3000',
        changeOrigin: true,
      },
    },
  },
});
