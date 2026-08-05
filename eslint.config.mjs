import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['web/dist/**', 'vendor/**', '.worktrees/**', '.claude/**'] },
  js.configs.recommended,
  // best-effort `try { ... } catch {}` is a deliberate idiom throughout the daemon
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
  {
    // `web/src/**/*.test.mjs` runs under `node --test` (see vite.config.mjs's
    // `@/`-alias note), not the Vite/browser bundle its sibling sources build for.
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', '*.mjs', 'web/*.mjs', 'web/src/**/*.test.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright specs run in node but ship browser-context callbacks to page.evaluate.
    files: ['e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/src/**/*.{js,jsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
];
