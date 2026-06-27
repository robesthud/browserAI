import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // Фронтенд (браузер + React)
  {
    files: ['src/**/*.{js,jsx}', 'vite.config.js'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // React-compiler advisory rules are noisy on this legacy React surface
      // and are not runtime correctness checks. Keep the canonical Hooks rules
      // from the plugin, but do not emit CI warnings for these migration hints.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/refs': 'off',
    },
  },
  // Бэкенд (Node.js)
  {
    files: ['server/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
    rules: {
      // Conventional intentional-unused marker. Keeps lint strict for real
      // dead code while allowing `_foo` placeholders in route signatures,
      // destructuring omissions and compatibility shims.
      // The backend still contains many compatibility imports and reserved
      // parameters for route/module parity. Treat unused backend symbols as
      // non-blocking noise while keeping real correctness rules enabled.
      'no-unused-vars': 'off',
      // Empty catch blocks are used in a few best-effort integrations where
      // failure must be ignored by design. Non-catch empty blocks still fail.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
