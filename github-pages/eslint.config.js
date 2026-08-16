import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Only src/world/ may import three; everything else must reach it
    // through a dynamic import() so the flat-fallback bundle never
    // downloads Three.js.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/world/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // `patterns`, not `paths` — `paths` matches only the bare specifier,
          // which would let `three/addons/postprocessing/OutputPass.js` (and
          // every other addon the world imports) sail straight past the guard.
          patterns: [
            {
              group: ['three', 'three/*', 'three/**'],
              message:
                'Only src/world/ may import three; everything else goes through a dynamic import() so flat mode never downloads it.',
            },
          ],
        },
      ],
    },
  },
);
