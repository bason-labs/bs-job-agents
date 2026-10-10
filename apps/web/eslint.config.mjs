import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { sharedIgnores, sharedRules } from "../../eslint.config.base.mjs";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  sharedIgnores,
  sharedRules,
]);
