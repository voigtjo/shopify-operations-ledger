import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "build/**",
      ".react-router/**",
      ".shopify/**",
      "node_modules/**",
    ],
  },
});
