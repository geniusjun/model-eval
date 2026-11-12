import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactDom from 'eslint-plugin-react-dom';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const VIEWER_NODE_FILES = [
  'viewer/vite.config.ts',
  'playwright.config.ts',
  'test/viewer/**/*.{ts,tsx}',
  'test/browser/**/*.ts',
];

/**
 * `recommended` turns this rule off. Its options are reused below with the rule set to `error`,
 * so lint rejects a control without a text label (plan D7).
 */
const [, controlLabelOptions] =
  jsxA11y.configs.recommended.rules['jsx-a11y-x/control-has-associated-label'];

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'coverage/',
      'schemas/',
      'node_modules/',
      '.omc/',
      'specs/',
      '.specify/',
      'test-results/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['viewer/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './viewer/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: VIEWER_NODE_FILES,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './viewer/tsconfig.node.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['viewer/src/**/*.{ts,tsx}', 'test/viewer/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactDom.configs.recommended,
      jsxA11y.configs.recommended,
    ],
    rules: {
      'react-dom/no-dangerously-set-innerhtml': 'error',
      'jsx-a11y-x/control-has-associated-label': ['error', controlLabelOptions],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
