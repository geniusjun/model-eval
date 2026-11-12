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

/** Ways a script opens a connection; the page makes no request (FR-010). */
const NETWORK_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];
const NO_NETWORK = 'The page makes no request (FR-010).';

/** Properties that parse a string as HTML; text from data goes in as text nodes (FR-009). */
const MARKUP_PROPERTIES = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'parseHTMLUnsafe',
  'createContextualFragment',
  'srcdoc',
];
const NO_MARKUP = 'The page renders text, never markup built from strings (FR-009).';

/**
 * The page moves only within itself, through `location.hash`; leaving it would load a URL
 * (FR-010). The two selectors match the object of `location.…` and of `window.location.…`.
 */
const LOCATION = ["[object.name='location']", "[object.property.name='location']"];
const NO_NAVIGATION = 'The page moves only through location.hash (FR-010).';

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
      '**/.venv/',
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
    // plan D5: page code never runs code or renders markup from data, and never opens a
    // connection, so a page built from untrusted model output stays inert and offline.
    files: ['viewer/src/**/*.{ts,tsx}'],
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      // typescript-eslint replaces the core `no-implied-eval` with this type-aware version.
      '@typescript-eslint/no-implied-eval': 'error',
      'no-restricted-globals': [
        'error',
        ...NETWORK_APIS.map((name) => ({ name, message: NO_NETWORK })),
        { name: 'open', message: NO_NAVIGATION },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'document', property: 'write', message: NO_MARKUP },
        { object: 'document', property: 'writeln', message: NO_MARKUP },
        { object: 'window', property: 'open', message: NO_NAVIGATION },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: 'The page is one file; no dynamic import().' },
        ...MARKUP_PROPERTIES.flatMap((name) => [
          { selector: `MemberExpression[property.name='${name}']`, message: NO_MARKUP },
          { selector: `MemberExpression[property.value='${name}']`, message: NO_MARKUP },
        ]),
        ...[...NETWORK_APIS, 'sendBeacon'].flatMap((name) => [
          { selector: `MemberExpression[property.name='${name}']`, message: NO_NETWORK },
          { selector: `MemberExpression[property.value='${name}']`, message: NO_NETWORK },
        ]),
        { selector: "JSXAttribute[name.name='srcDoc']", message: NO_MARKUP },
        ...LOCATION.flatMap((object) => [
          {
            selector: `AssignmentExpression > MemberExpression.left${object}[property.name='href']`,
            message: NO_NAVIGATION,
          },
          {
            selector: `MemberExpression${object}[property.name=/^(assign|replace)$/]`,
            message: NO_NAVIGATION,
          },
        ]),
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
