import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  publicDir: '../public',
  server: {
    host: '127.0.0.1',
    proxy: Object.fromEntries(['/api', '/uploads', '/avatars'].map((path) => [path, 'http://127.0.0.1:3000'])),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: 'es2022',
  },
})
