/**
 * What `npm run lint` holds the JavaScript to.
 *
 * `npm run check` only proves each file parses. A name that is never defined,
 * a variable assigned and never read, a second `case` that can never be
 * reached: all of those parse. These rules are the ones that find mistakes
 * rather than express taste, and they are errors, so a failing run means
 * something is actually wrong. Unused names are the one warning.
 *
 * Written without importing a preset, because this project has no
 * dependencies to import one from: ESLint itself is installed beside the
 * repository by CI, the way the browser tests install Playwright.
 */
const browser = Object.fromEntries([
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'fetch', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'addEventListener', 'removeEventListener', 'innerWidth', 'innerHeight', 'scrollY', 'scrollX', 'matchMedia',
  'URL', 'URLSearchParams', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'Event', 'CustomEvent',
  'HTMLElement', 'Element', 'Node', 'DOMParser', 'FileReader', 'Blob', 'File', 'TextDecoder', 'TextEncoder',
  'AbortController', 'crypto', 'performance', 'getComputedStyle', 'confirm', 'alert', 'prompt', 'history',
  'structuredClone', 'queueMicrotask', 'DecompressionStream', 'CompressionStream', 'Response', 'Request', 'Headers',
  'ArchiveNative', 'globalThis', 'XMLHttpRequest', 'AbortSignal', 'atob', 'btoa', 'CSS', 'Image', 'screen', 'visualViewport', 'ReadableStream',
].map((name) => [name, 'readonly']));

const node = Object.fromEntries([
  'process', 'Buffer', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'URL', 'URLSearchParams', 'fetch', 'TextDecoder', 'TextEncoder', 'AbortController', 'globalThis', 'structuredClone',
  'performance', 'crypto', 'Response', 'Request', 'Headers', 'Blob', 'DecompressionStream', 'CompressionStream',
  'queueMicrotask', 'ReadableStream', 'btoa', 'atob', 'AbortSignal',
].map((name) => [name, 'readonly']));

const rules = {
  'no-undef': 'error',
  // A warning, alone among these: it marks dead code to clear out, not a fault.
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-binary-expression': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-sparse-arrays': 'error',
  'no-fallthrough': 'error',
  'no-redeclare': 'error',
  'no-shadow-restricted-names': 'error',
  'no-loss-of-precision': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-setter-return': 'error',
  'getter-return': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'for-direction': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
};

const languageOptions = { ecmaVersion: 'latest', sourceType: 'module' };

export default [
  { ignores: ['android/**', 'dart/**', 'data/**', 'apk/**', 'docs/**', 'ui-screenshots/**', 'node_modules/**'] },
  { files: ['app/**/*.js'], languageOptions: { ...languageOptions, globals: { ...browser, ...node } }, rules },
  { files: ['tools/**/*.mjs', 'tools/**/*.js', 'test/**/*.mjs', '*.mjs'],
    languageOptions: { ...languageOptions, globals: { ...node, ...browser } }, rules },
  // Tests lift a function out of a source file to run it on its own, and write holes on purpose.
  { files: ['test/**/*.mjs'], rules: { 'no-new-func': 'off', 'no-sparse-arrays': 'off' } },
];
