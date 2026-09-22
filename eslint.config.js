// Lint du renderer et des scripts.
//
// La règle qui justifie l'outil est `no-unsanitized` : le renderer construit
// son HTML par gabarits, et y interpole des noms de projets et de modèles
// venus des journaux analysés. Toute interpolation dans `innerHTML` ou
// `insertAdjacentHTML` doit passer par `esc()` — ou par une fonction qui
// ne produit que du balisage construit ici, listée ci-dessous. La CSP est la
// seconde barrière, pas la première.

const js = require('@eslint/js');
const globals = require('globals');
const nounsanitized = require('eslint-plugin-no-unsanitized');

// Fonctions dont la sortie est du HTML sûr par construction : elles
// échappent elles-mêmes ce qu'elles interpolent, ou n'interpolent que des
// constantes. En ajouter une ici est un engagement vérifié à la relecture.
const SAFE_HTML = [
  'esc',
  // Nombres formatés par Intl : chiffres, séparateurs, unités fixes.
  'nf', 'tokens', 'usd', 'co2', 'energy', 'water', 'pct', 'shortDate',
  // Balisage construit ici, à partir de clés connues et de nombres.
  'providerMark', 'trendChip',
];

module.exports = [
  { ignores: ['node_modules/', 'target/', 'src-tauri/gen/', 'src/renderer/shared/logos.js'] },
  js.configs.recommended,
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
    plugins: { 'no-unsanitized': nounsanitized },
    rules: {
      'no-unsanitized/method': ['error', { escape: { methods: SAFE_HTML } }],
      'no-unsanitized/property': ['error', { escape: { methods: SAFE_HTML } }],
    },
  },
  {
    files: ['src-tauri/src/bridge.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['scripts/**/*.js', 'src/main/**/*.js', 'src/i18n/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
