import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import security from 'eslint-plugin-security';
import prettier from 'eslint-config-prettier';

/**
 * Lint rules.
 *
 * Two things are enforced beyond the recommended set, because both are already
 * conventions here and neither survives on goodwill: every exported thing
 * carries a JSDoc header describing its parameters and what it returns, and the
 * security plugin stays on so the `eslint-disable` comments in the source mean
 * something.
 *
 * Formatting is prettier's job, so `eslint-config-prettier` goes last and turns
 * off every rule that would argue with it.
 */
export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  security.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    linterOptions: {
      // A disable comment that no longer suppresses anything is a claim about
      // the code that has stopped being true.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',

      // The function-header convention, as rules.
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      // A destructured parameter is documented as the one thing it is:
      // `@param {object} options - what this needs`. Requiring a tag per field
      // would put the argument list in the header twice and the reasons
      // nowhere, and the reasons are what docs/internals.md is for.
      'jsdoc/require-param': ['warn', { checkDestructured: false }],
      'jsdoc/check-param-names': ['warn', { checkDestructured: false }],
      'jsdoc/require-param-description': 'warn',
      'jsdoc/require-returns-description': 'warn',
      'jsdoc/require-description-complete-sentence': 'off',
      // The convention here runs the tags straight on from the description.
      'jsdoc/tag-lines': ['warn', 'any', { startLines: 0 }],
      'jsdoc/reject-function-type': 'off',
      // Types come from the JSDoc itself; there is no TypeScript here to check
      // them against, so an unresolvable name is not worth an error.
      'jsdoc/no-undefined-types': 'off',
      'jsdoc/check-tag-names': ['warn', { definedTags: ['typedef'] }],

      // Every path this project opens is one an operator configured or an admin
      // API call named, so the filename rule fires on essentially every line
      // that does the job and is off. The other two stay on as warnings: they
      // are worth a second look at the point a new one is written, and the
      // `eslint-disable` comments already in the source are the record of that
      // look having happened.
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
    },
  },
  {
    files: ['test/**/*.js'],
    rules: {
      // A test's name is its description.
      'jsdoc/require-jsdoc': 'off',
    },
  },
  prettier,
];
