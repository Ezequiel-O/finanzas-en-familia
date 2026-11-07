import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Sin source maps en producción para no exponer el código fuente.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Librerías grandes en archivos propios: cambian poco y quedan en caché entre versiones.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}', 'functions-inbox/**/*.test.js'],
    exclude: ['**/node_modules/**'],
  },
})
