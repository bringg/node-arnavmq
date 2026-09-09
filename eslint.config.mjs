import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

// eslint-disable-next-line no-underscore-dangle
const __filename = fileURLToPath(import.meta.url);
// eslint-disable-next-line no-underscore-dangle
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  {
    ignores: [
      'bin/**/*',
      'build/**/*',
      'coverage/**/*',
      'docs/**/*',
      'jsdoc/**/*',
      'templates/**/*',
      'tests/bench/**/*',
      'tests/fixtures/**/*',
      'tests/performance/**/*',
      'tmp/**/*',
      'public/**/*',
      'node_modules/**/*',
      'lib-cov/**/*',
      '.grunt/**/*',
      '.sonar/**/*',
      'logs/**/*',
      '.idea/**/*',
      'samples/**/*',
    ],
  },
  // `js.configs.recommended` is handed to FlatCompat above as its `recommendedConfig` option, but
  // that only tells FlatCompat how to resolve `extends: 'eslint:recommended'` inside a *legacy*
  // config - it does not enable a single rule here. It has to be in this array to apply. Without
  // it `npm run lint` enforced nothing but the explicit rules below: no-unsafe-finally,
  // no-unused-vars and the rest of the recommended set were all off, which is how a
  // `return clearTimeout(id)` inside a `finally` (silently swallowing every rejection routed
  // through utils.withTimeout) passed CI.
  js.configs.recommended,
  // After recommended, so it can switch off anything that would fight the formatter.
  ...compat.extends('eslint-config-prettier'),
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
        ...globals.mongo,
      },
    },

    rules: {
      'no-await-in-loop': 0,
      'comma-dangle': 0,
      'max-classes-per-file': 0,

      'max-len': [
        'error',
        {
          code: 190,
          ignoreComments: true,
          ignoreUrls: true,
        },
      ],

      'no-underscore-dangle': [
        1,
        {
          allow: ['_config', '_connection', '_maxListeners'],
          allowAfterThis: true,
        },
      ],

      'no-return-await': 'off',
      'no-console': 'error',
      'no-param-reassign': 'error',
      'global-require': 'error',
      'no-unused-expressions': 'error',
      'no-sequences': 'error',
      'prefer-rest-params': 'error',
      'func-names': ['error', 'as-needed'],
    },
  },
];
