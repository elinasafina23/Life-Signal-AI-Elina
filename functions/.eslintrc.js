module.exports = {
  root: true,
  env: { es6: true, node: true },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google", // keep, but we override noisy rules below
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./tsconfig.json"],       // only files in this tsconfig
    tsconfigRootDir: __dirname,         // important for monorepos/CI
    sourceType: "module",
  },
  ignorePatterns: [
    "lib/**",
    "generated/**",
    ".eslintrc.js",                     // ← don't lint this file
  ],
  plugins: ["@typescript-eslint", "import"],
  rules: {
    // turn off the blockers
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
    "max-len": ["warn", { code: 120, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true }],
    "comma-dangle": "off",
    "object-curly-spacing": ["error", "always"],

    // your prefs
    "quotes": ["error", "double"],
    "indent": ["error", 2],
    "import/no-unresolved": 0,
    "@typescript-eslint/no-explicit-any": "warn",
  },

  // If you ever lint JS files, use the plain JS parser for them:
  overrides: [
    {
      files: ["*.js"],
      parser: "espree",
      parserOptions: { ecmaVersion: 2020, sourceType: "script" },
    },
  ],
};
