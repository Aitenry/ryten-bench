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
      // electron-vite v6: 使用 build.externalizeDeps 替代已弃用的 externalizeDepsPlugin
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
        // 允许读取仓库根下的文件，避免上层 workspace 变更时回归
        allow: [resolve('.')]
      }
    },
    build: {
      rollupOptions: {
        input: {
          // 定义多个入口点
          main: resolve(__dirname, 'src/renderer/resource/index.html')
        }
      }
    }
  }
})
