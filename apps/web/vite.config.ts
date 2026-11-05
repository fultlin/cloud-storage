import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFile } from 'node:fs/promises'

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  plugins: [react(), {
    name: 'development-mock-worker',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', async (_request, response, next) => {
        try {
          const worker = await readFile(new URL('./mocks/mockServiceWorker.js', import.meta.url));
          response.setHeader('Content-Type', 'application/javascript');
          response.end(worker);
        } catch (error) { next(error); }
      });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
