import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // `.dsh-vision-toolkit` is the temporary output directory of the vision toolchain (already in .gitignore);
  // the node scripts inside are not project source, so linting them only produces unrelated errors.
  // `data/` is the runtime storage root the app creates under the install directory (memory / plugin source / skills), not project source:
  // plugin source and skill docs would be repeatedly flagged by prettier/eslint as project files, so they must be excluded.
  // `src/main/workshop/template-files/**` holds the **text assets** of draft templates (keeping the .ts/.tsx/.mjs/.md extensions);
  // they contain `${vars.*}` placeholders and are not parseable project source: linting / tsc would only report syntax errors.
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
          // Provider/Context files also exporting hooks is an established pattern in this project (same as AudioContext):
          // these hooks are the context's main public API, and splitting them into files would only turn the context object into a third export.
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
    // Plain JS scripts run directly by node: scripts/ holds build helpers, test/ holds
    // offline verification scripts (verify-*.mjs / sim-render-cost.mjs etc., that directory is not tracked), examples/ holds
    // external plugin examples (built by the plugin authors themselves, not part of the app's TS build). They deliberately omit
    // TS type annotations and intentionally leave implementations empty (jsdom stubs' observe/disconnect etc.). Applying TS rules
    // would only make `pnpm lint` fail year-round and lose its signal value (verify-text-window.mjs etc. already did).
    // Only relax the JS extensions: *.ts verification sources under test/ are still checked with TS rules.
    files: ['scripts/**/*.{js,mjs,cjs}', 'test/**/*.{js,mjs,cjs}', 'examples/**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Simulation scripts render React components inline in the script, so prop-types are unnecessary
      'react/prop-types': 'off'
    }
  },
  eslintConfigPrettier
)
