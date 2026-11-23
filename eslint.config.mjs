import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // `.dsh-vision-toolkit` 是 vision 工具链的临时产物目录（已在 .gitignore 中），
  // 里面的 node 脚本不是项目源码，纳入 lint 只会持续报无关错误。
  // `data/` 是应用运行期按安装目录创建的存储根（记忆 / 插件源码 / 技能），不是项目源码：
  // 插件源码和技能文档会被 prettier/eslint 当成项目文件反复报错，必须排除。
  // `src/main/workshop/template-files/**` 是草稿模板的**文本资产**（保留 .ts/.tsx/.mjs/.md 扩展名），
  // 里面带 `${vars.*}` 占位符，不是可解析的项目源码：纳入 lint / tsc 只会报语法错误。
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/.dsh-vision-toolkit',
      'data/**',
      'src/main/workshop/template-files/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          // Provider/Context 文件同时导出 hooks 是本项目的既有形态（AudioContext 同款）：
          // 这些 hook 就是该上下文对外的主 API，拆文件只会把 context 对象也变成第三个出口。
          allowExportNames: [
            'useAudioState',
            'useAudioProgress',
            'useAudio',
            'usePluginHost',
            'usePlugins',
            'usePluginRoutes',
            'usePluginMenus',
            'usePluginMenuKeys',
            'usePluginSettingsSections',
            'usePluginProviders',
            'useGlobalComponents',
            'useBottomBarItems',
            'useIsPluginEnabled'
          ]
        }
      ],
      'react/prop-types': 'off'
    }
  },
  {
    // node 直跑的纯 JS 脚本：scripts/ 下是构建补丁（patch-langgraph-sdk.js），test/ 下是
    // 离线校验脚本（verify-*.mjs / sim-render-cost.mjs 等，该目录不入库），examples/ 下是
    // 外部插件示例（由插件作者自行构建，不参与应用的 TS 构建）。它们刻意不写 TS 类型标注，
    // 也有意留空实现（jsdom 桩的 observe/disconnect 之类）。套用 TS 规则只会让 `pnpm lint`
    // 常年失败、失去信号价值（此前 verify-text-window.mjs 等就已如此）。
    // 只放宽 JS 扩展名：test/ 里的 *.ts 校验源码仍按 TS 规则检查。
    files: ['scripts/**/*.{js,mjs,cjs}', 'test/**/*.{js,mjs,cjs}', 'examples/**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // 仿真脚本会在脚本里内联渲染 React 组件，不需要 prop-types
      'react/prop-types': 'off'
    }
  },
  eslintConfigPrettier
)
