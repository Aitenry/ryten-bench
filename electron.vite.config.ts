import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // electron-vite v6: use build.externalizeDeps instead of the deprecated externalizeDepsPlugin
      externalizeDeps: true
    }
  },
  preload: {
    build: {
      externalizeDeps: true
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [tailwindcss(), react()],
    server: {
      fs: {
        // Allow reading files under the repo root, avoiding regressions when the parent workspace changes
        allow: [resolve('.')]
      }
    },
    build: {
      rollupOptions: {
        input: {
          // Define multiple entry points
          main: resolve(__dirname, 'src/renderer/resource/index.html')
        }
      }
    }
  }
})
