import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**']),

  {
    // App code: browser globals, no Node.
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Repo idiom: guarded `!` on values already narrowed a few lines up
      // (e.g. after an explicit `if (!x) return`, or on a Map.get() right
      // after a `.has()` check). Not part of the recommended set anyway,
      // but pinned off explicitly so it stays off if that ever changes.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Repo idiom: `const { drop: _drop, ...rest } = obj` to omit one key —
      // the rest-sibling variable is unused by design, not a mistake.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // React components only. Just the two hook rules — the React Compiler
    // rules this plugin also ships stay OFF (no compiler in this build).
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // MIGRATION BOUNDARY: the model and the three view layers stay
    // framework-free, so the strangler can keep swapping the shell without
    // ever touching them. No React, and no import of the React shell either —
    // dependencies point INTO these modules, never out of them.
    files: ['src/model/**/*.ts', 'src/editor/**/*.ts', 'src/plan2d/**/*.ts', 'src/view3d/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react/**', 'react-dom/**'],
              message: 'Model/editor/view code must stay framework-free — no React here.',
            },
            {
              group: ['**/ui/react/**', '**/app/**'],
              message:
                'Model/editor/view code must not depend on the React shell or the app bootstrap.',
            },
          ],
        },
      ],
    },
  },
  {
    // The React shell renders through JSX, never by pasting markup: no
    // innerHTML assignment, no dangerouslySetInnerHTML.
    files: ['src/ui/react/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression[left.property.name="innerHTML"]',
          message: 'Build DOM through JSX, not innerHTML.',
        },
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message: 'Build DOM through JSX, not dangerouslySetInnerHTML.',
        },
      ],
    },
  },
  {
    // Unit tests: same TS rules, but they run under vitest in plain Node
    // (no jsdom — see test/unit/storageKeys.test.ts), so Node globals.
    files: ['test/unit/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Playwright specs: run under the @playwright/test Node runner, but
    // page.evaluate() callbacks execute in the browser tab, so both globals.
    files: ['e2e/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Plain-JS Node scripts (Playwright E2E driver, screenshot tool). Also
    // browser globals: most of the interesting code here is a callback
    // passed to page.evaluate(), which runs inside the browser tab, not Node.
    files: ['test/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // test/interact.mjs deliberately matches a UTF-8 BOM (U+FEFF) via
      // /^﻿/ to assert the CSV export strips it — not a stray character.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
]);
