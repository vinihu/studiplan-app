import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["out/", "dist/", "release/", "artifacts/", "node_modules/", ".claude/", "site/"]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Main process, preload, build config and scripts run in Node.
  {
    files: ["src/main/**", "src/preload/**", "scripts/**", "*.config.{js,ts}", "**/*.test.ts"],
    languageOptions: { globals: globals.node },
  },

  // The smoke test also passes functions to Playwright that run inside the app's page.
  {
    files: ["scripts/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // The renderer is a browser page and must stay one: no Node, no Electron.
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message: "The renderer talks to the main process only through window.studiplan.",
            },
          ],
          patterns: [
            {
              group: ["node:*", "**/main/**", "**/preload/**"],
              message: "The renderer talks to the main process only through window.studiplan.",
            },
          ],
        },
      ],
    },
  },
]);
