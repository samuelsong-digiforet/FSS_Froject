import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
watch: {
      usePolling: true,      // Windows 파일 변경 감지
      interval: 1000,        // 1초마다 폴링
    },
    proxy: {
      '/api': {
        target: 'http://fss-api:3000',
        changeOrigin: true,
      },
    },
  },
});