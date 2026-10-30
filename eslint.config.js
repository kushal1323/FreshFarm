
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules']),

  // Base JavaScript rules
  {
    files: ['**/*.{js,jsx}'],
    extends: [js.configs.recommended],
  },

  // React frontend
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },

  // Node.js backend
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Root-level Node configuration files
  {
    files: ['*.config.js', '*.config.cjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
