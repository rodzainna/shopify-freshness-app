import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Deliberately separate from vite.config.ts: the React Router Vite plugin
// there expects to build routes, which doesn't play well with Vitest's
// test-running mode. This config only needs tsconfig path resolution.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
  },
});
