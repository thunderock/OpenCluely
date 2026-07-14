const globals = require('globals');

// Lean, error-only ruleset shared by every layer. Only real correctness
// rules — no stylistic gate (per-layer indentation/quote style is preserved).
// caughtErrors:'none' — unused `catch` bindings are never flagged (the repo
// leans heavily on `catch (e) { log(...) }` / `catch (_) {}` idioms).
// A leading `_` still exempts intentionally-unused args and vars.
const leanRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    caughtErrors: 'none',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
  }],
};

module.exports = [
  // Block 0 — global ignores: vendored/generated/standalone code only.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.venv-whisper/**',
      '.whisper-models/**',
      'lib/markdown.js', // vendored 1725-line parser (hand-written lib/mathrender.js is linted below)
      'assests/vendor/**', // vendored Font Awesome (intentional misspelling)
      'webapp/**', // standalone marketing site
    ],
  },

  // Block 1 — Node/CommonJS layer (main process, preload, scripts, tests).
  {
    files: [
      'main.js',
      'preload.js',
      'prompt-loader.js',
      'speech-recognition.js',
      'src/core/**/*.js',
      'src/managers/**/*.js',
      'src/services/**/*.js',
      'scripts/**/*.js',
      'test/**/*.js',
      'eslint.config.js',
      'tailwind.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: leanRules,
  },

  // Block 2 — renderer/browser layer (UI + onboarding + hand-written math render).
  {
    files: [
      'src/ui/**/*.js',
      'onboarding.js',
      'lib/mathrender.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        electronAPI: 'readonly',
        api: 'readonly',
        markdown: 'readonly',
        marked: 'readonly',
        renderMathInElement: 'readonly',
        Prism: 'readonly',
        mainWindowUI: 'writable',
        require: 'readonly', // chat-window.js feature-detects require for dual Node/browser module loading
      },
    },
    rules: leanRules,
  },
];
