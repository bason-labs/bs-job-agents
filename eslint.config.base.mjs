// Shared ESLint flat config for every workspace package.
// Node/TS packages spread `nodeConfig`; apps/web combines `sharedRules` with
// eslint-config-next (which already registers the typescript-eslint plugin).
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export const sharedIgnores = {
  ignores: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/coverage/**",
    "**/.turbo/**",
    "**/playwright-report/**",
    "**/test-results/**",
    "**/next-env.d.ts",
  ],
};

export const sharedRules = {
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/consistent-type-imports": "error",
    "no-console": ["warn", { allow: ["warn", "error", "info"] }],
  },
};

export const nodeConfig = tseslint.config(
  sharedIgnores,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  sharedRules,
);

export default nodeConfig;
