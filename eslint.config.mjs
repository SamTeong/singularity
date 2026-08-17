import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // Generated/vendored trees, all gitignored. `playwright-report/` and
  // `test-results/` are Playwright artifacts — their bundled JS otherwise
  // dominates the report (~1100+ no-undef errors) and buries real source
  // findings.
  { ignores: ['web/dist/**', 'web/dist-mock/**', 'vendor/**', '.worktrees/**', '.claude/**', 'playwright-report/**', 'test-results/**', 'e2e/.tmp*/**', 'github-pages/**'] },
  js.configs.recommended,
  // best-effort `try { ... } catch {}` is a deliberate idiom throughout the daemon
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
  // `const { text, ...meta } = obj` is how a key gets omitted — the named
  // sibling is the point, not an oversight. Listing the kept fields instead
  // silently drops any field added later.
  { rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] } },
  {
    // `web/src/**/*.test.mjs` runs under `node --test` (see vite.config.mjs's
    // `@/`-alias note), not the Vite/browser bundle its sibling sources build for.
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', '*.mjs', 'web/*.mjs', 'web/src/**/*.test.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright specs run in node but ship browser-context callbacks to page.evaluate.
    files: ['e2e/**/*.mjs', 'e2e-mock/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['web/src/**/*.{js,jsx,mjs}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
];
