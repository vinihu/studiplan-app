import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const alias = { "@shared": resolve(import.meta.dirname, "src/shared") };

/**
 * The strict Content-Security-Policy lives in `src/renderer/index.html` and is what ships.
 * The Vite dev server needs an inline script (React refresh), injected <style> tags and a
 * websocket for hot reload, so only while running `npm run dev` the policy is widened by
 * exactly those. A production build is never touched by this plugin.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: "studiplan:dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        // A nonce would make the browser ignore 'unsafe-inline', so the dev policy drops it.
        .replace(/style-src [^;]+/, "style-src 'self' 'unsafe-inline'")
        .replace("connect-src 'none'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
    },
  };
}

/**
 * The two kinds of build, decided here and nowhere else.
 *
 *  - A release build: `electron-vite build` with no mode. The main bundle ignores every
 *    development hook (see `src/main/build.ts`). This is the default, so a build made without
 *    thinking about it is always a release build.
 *  - A build with the hooks on: `npm run dev` (the dev server), or `electron-vite build --mode
 *    test-build`, which `npm run smoke` and `npm run dist:test` use.
 *
 * The answer is written into the main bundle as constants. Nothing in the environment of a
 * running app can change it.
 */
const TEST_BUILD_MODE = "test-build";

export default defineConfig(({ command, mode }) => {
  const hooks = command === "serve" || mode === TEST_BUILD_MODE;
  return {
    main: {
      resolve: { alias },
      define: {
        __STUDIPLAN_DEV_HOOKS__: JSON.stringify(hooks),
        // A plain string in the bundle, so the packaging hooks can tell which kind they are packing.
        __STUDIPLAN_BUILD_MARKER__: JSON.stringify(hooks ? "studiplan-build-kind:test" : "studiplan-build-kind:release"),
      },
    },
    preload: {
      resolve: { alias },
      build: {
        // A sandboxed preload is loaded as a classic script: one CommonJS file, nothing but
        // `electron` left external.
        externalizeDeps: false,
        rollupOptions: {
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      resolve: { alias },
      plugins: [react(), tailwindcss(), devContentSecurityPolicy()],
    },
  };
});
