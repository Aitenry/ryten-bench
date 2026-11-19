import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // 系统级功能目录（harness / notes 已移出插件）
        '@features': resolve('src/features'),
        // 自包含插件目录（主进程侧：src/plugins/<id>/main、shared）
        '@plugins': resolve('src/plugins'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // electron-vite v5: 使用 build.externalizeDeps 替代已弃用的 externalizeDepsPlugin
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
        // 系统级功能目录（harness / notes 已移出插件）
        '@features': resolve('src/features'),
        // 自包含插件目录（渲染层侧：src/plugins/<id>/renderer、shared、locales）。
        '@plugins': resolve('src/plugins'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [tailwindcss(), react()],
    // dev 下渲染层会 import 仓库根下 src/plugins/**（Vite root 之外）：
    // server.fs.allow 默认就是 workspace root（= 本仓库根，含 src/plugins），无需显式配置。
    server: {
      fs: {
        // 显式写出：允许读取仓库根下的文件（含 src/plugins），避免上层 workspace 变更时回归
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
