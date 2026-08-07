import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // Generated output, all of it gitignored. playwright-report ships minified
  // vendor bundles that alone account for ~1100 findings.
  { ignores: ['web/dist/**', 'vendor/**', '.worktrees/**', '.claude/**', 'playwright-report/**', 'e2e/.tmp*/**'] },
  js.configs.recommended,
  // best-effort `try { ... } catch {}` is a deliberate idiom throughout the daemon
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
  // `const { text, ...meta } = obj` is how a key gets omitted — the named
  // sibling is the point, not an oversight. Listing the kept fields instead
  // silently drops any field added later.
  { rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] } },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', '*.mjs', 'web/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright specs run in node but ship browser-context callbacks to page.evaluate.
    files: ['e2e/**/*.mjs'],
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
